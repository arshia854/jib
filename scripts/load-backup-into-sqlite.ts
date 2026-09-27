/**
 * F3-prep: loads a scripts/backup-live-db.ts JSON dump into a LOCAL SQLite
 * file whose schema was built by `prisma migrate deploy` (never from live's
 * DDL), preserving every id.
 *
 * LOCAL ONLY: the target must be a plain file path - URLs (libsql://,
 * file:, ...) are refused before any connection is made. This script never
 * reads TURSO_DATABASE_URL / .env.
 *
 * Refuses (exit 1, nothing written) unless ALL of these hold:
 *  - backup and manifest agree on every table's row count;
 *  - the target's _prisma_migrations matches prisma/migrations exactly
 *    (same count, same names, finished, not rolled back, same checksums);
 *  - the target has no rows except in migration-seeded tables
 *    (DefaultCategory - deleted, then replaced by the backup's rows);
 *  - every backup table exists in the target, and vice versa (unless
 *    accepted with --allow-missing-table);
 *  - no backup column is missing from the target (its data would be
 *    dropped), no NOT NULL target column is missing from the backup, and no
 *    nullable one is either (unless accepted with --accept-missing);
 *  - every value is a JSON scalar (a BLOB would have become `{}`).
 * The column checks double as the live-vs-migrations drift detector.
 *
 * Load: one transaction, foreign_keys off during the load, then
 * PRAGMA foreign_key_check - any violation rolls everything back. Then each
 * AUTOINCREMENT table's sqlite_sequence is raised to at least max(id) and at
 * least live's seq from --snapshot (so ids of rows deleted on live are never
 * reused). DRY RUN BY DEFAULT: the whole load runs and is rolled back;
 * pass --execute to commit.
 *
 * Usage:
 *   npx tsx scripts/load-backup-into-sqlite.ts <backup.json> <manifest.json> <target.db> \
 *     [--snapshot snapshot.json] [--execute] \
 *     [--accept-missing Table.column]... [--allow-missing-table Table]...
 */
import { parseArgs } from "node:util";
import {
  applyLoad,
  inspectTarget,
  listMigrationFolders,
  LoadError,
  openLocalDb,
  preflightLoad,
  readJsonFile,
  resolveLocalDbPath,
  type Backup,
  type Manifest,
  type Snapshot,
} from "./lib/sqlite-copy";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      snapshot: { type: "string" },
      execute: { type: "boolean", default: false },
      "accept-missing": { type: "string", multiple: true, default: [] },
      "allow-missing-table": { type: "string", multiple: true, default: [] },
    },
  });
  if (positionals.length !== 3) {
    throw new Error("Usage: load-backup-into-sqlite.ts <backup.json> <manifest.json> <target.db> [--snapshot s.json] [--execute]");
  }
  const [backupPath, manifestPath, targetArg] = positionals;
  const targetPath = resolveLocalDbPath(targetArg, { mustExist: true });

  const backup = readJsonFile<Backup>(backupPath, "backup");
  const manifest = readJsonFile<Manifest>(manifestPath, "manifest");
  const snapshot = values.snapshot ? readJsonFile<Snapshot>(values.snapshot, "snapshot") : null;

  console.log(`${values.execute ? "EXECUTE" : "DRY RUN"} - load backup into local SQLite`);
  console.log(`  backup:   ${backupPath} (source: ${manifest.sourceUrl ?? "?"}, taken ${manifest.takenAt ?? "?"})`);
  console.log(`  target:   ${targetPath}`);
  console.log(`  snapshot: ${snapshot ? `${values.snapshot} (taken ${snapshot.takenAt ?? "?"})` : "(none - sqlite_sequence will only be raised to max(id))"}\n`);

  const client = openLocalDb(targetPath);
  try {
    const target = await inspectTarget(client);
    const pre = preflightLoad({
      backup,
      manifest,
      snapshot,
      target,
      folders: listMigrationFolders(),
      options: { acceptMissingColumns: values["accept-missing"], allowMissingTables: values["allow-missing-table"] },
    });
    for (const n of pre.notes) console.log(`NOTE: ${n}`);
    for (const w of pre.warnings) console.log(`WARNING: ${w}`);
    if (pre.errors.length > 0) {
      console.error(`\nREFUSING TO LOAD - ${pre.errors.length} problem(s), nothing was written:`);
      for (const e of pre.errors) console.error(`  ERROR: ${e}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nPreflight OK.\n");

    const report = await applyLoad(client, backup, target, {
      snapshotSequence: snapshot?.sqliteSequence ? new Map(snapshot.sqliteSequence.map((s) => [s.name, Number(s.seq)])) : null,
      execute: values.execute,
    });

    for (const d of report.deleted) console.log(`deleted ${d.rows} migration-seeded row(s) from ${d.table}`);
    console.log("inserted:");
    for (const i of report.inserted) console.log(`  ${i.table.padEnd(22)} ${i.rows}`);
    console.log("sqlite_sequence (table: current-after-insert / max(id) / snapshot -> set):");
    for (const s of report.sequence) {
      console.log(`  ${s.table.padEnd(22)} ${s.current ?? "-"} / ${s.maxId ?? "-"} / ${s.snapshot ?? "-"} -> ${s.target}`);
    }
    console.log("PRAGMA foreign_key_check: 0 violations");
    console.log(
      report.committed
        ? `\nCOMMITTED. Next: npx tsx scripts/verify-sqlite-copy.ts ${targetArg} ${manifestPath}${values.snapshot ? ` --snapshot ${values.snapshot}` : ""} --backup ${backupPath}`
        : "\nDry run only - the full load ran inside a transaction and was ROLLED BACK; target unchanged. Re-run with --execute to commit."
    );
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof LoadError ? "LOAD FAILED" : "ERROR"}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
