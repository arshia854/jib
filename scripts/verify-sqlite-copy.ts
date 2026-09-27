/**
 * F3-prep: verifies a local SQLite copy produced by
 * scripts/load-backup-into-sqlite.ts. LOCAL ONLY - the target must be a
 * plain file path (URLs are refused before any connection); never reads
 * TURSO_DATABASE_URL / .env.
 *
 * Checks (any FAIL -> exit 1):
 *  1. per-table row counts == the backup manifest's
 *  2. PRAGMA integrity_check == ok
 *  3. PRAGMA foreign_key_check has no rows
 *  4. the target's sqlite_master (tables, indexes, their exact SQL) is
 *     identical to a fresh `prisma migrate deploy` scratch file built right
 *     now from prisma/migrations, the Phase 17 groupby index is present, and
 *     _prisma_migrations matches prisma/migrations
 *  5. every AUTOINCREMENT table's sqlite_sequence >= max(id), and >= live's
 *     seq when --snapshot is given
 *  6. --backup: every row of the backup JSON is present in the target with
 *     identical values (matched by primary key)
 * Report-only (WARN/INFO, never fails the run), with --snapshot:
 *  7. live schema objects/columns/indexes/FKs missing from the target and
 *     vice versa (live's DDL rebuilt in an in-memory DB and compared via
 *     PRAGMAs - the snapshot itself is SELECT-only), snapshot row counts vs
 *     the manifest, and live's _prisma_migrations vs prisma/migrations.
 *
 * Usage:
 *   npx tsx scripts/verify-sqlite-copy.ts <target.db> <manifest.json> [--snapshot snapshot.json] [--backup backup.json]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Client } from "@libsql/client";
import {
  autoincrementTables,
  buildMigrateDeployDb,
  checkMigrateDeployBookkeeping,
  countRows,
  describeStructure,
  diffSchemaObjects,
  diffStructures,
  listMigrationFolders,
  openLocalDb,
  quoteIdent,
  readColumns,
  readJsonFile,
  readMigrationRows,
  readSchemaObjects,
  readSequence,
  REQUIRED_INDEXES,
  resolveLocalDbPath,
  structureFromSnapshot,
  userTables,
  type Backup,
  type Manifest,
  type SchemaObject,
  type Snapshot,
} from "./lib/sqlite-copy";

type Status = "PASS" | "FAIL" | "WARN" | "INFO";
const results: { status: Status; name: string; lines: string[] }[] = [];

function record(status: Status, name: string, lines: string[] = []) {
  results.push({ status, name, lines });
  console.log(`[${status}] ${name}`);
  for (const line of lines) console.log(`       ${line}`);
}

const fmtObj = (o: SchemaObject) => `${o.type} ${o.name}${o.tbl_name !== o.name ? ` (on ${o.tbl_name})` : ""}`;

async function checkRowCounts(client: Client, objects: SchemaObject[], manifest: Manifest) {
  const tables = userTables(objects);
  const counts = await countRows(client, tables);
  const expected = manifest.tableRowCounts ?? {};
  const bad: string[] = [];
  const lines: string[] = [];
  for (const table of tables) {
    const actual = counts.get(table) ?? 0;
    if (!(table in expected)) {
      if (actual !== 0) bad.push(`${table}: ${actual} row(s) in target, table not in manifest`);
      else lines.push(`${table}: not in manifest, 0 rows (ok)`);
      continue;
    }
    if (actual !== expected[table]) bad.push(`${table}: target ${actual}, manifest ${expected[table]}`);
    else lines.push(`${table.padEnd(22)} ${actual}`);
  }
  for (const table of Object.keys(expected)) {
    if (!tables.includes(table)) bad.push(`${table}: in manifest (${expected[table]} rows) but missing from target`);
  }
  record(bad.length ? "FAIL" : "PASS", "row counts vs manifest", bad.length ? bad : lines);
}

async function checkIntegrity(client: Client) {
  const res = await client.execute("PRAGMA integrity_check");
  const msgs = res.rows.map((r) => String(r.integrity_check));
  record(msgs.length === 1 && msgs[0] === "ok" ? "PASS" : "FAIL", "PRAGMA integrity_check", msgs.slice(0, 20));
}

async function checkForeignKeys(client: Client) {
  const res = await client.execute("PRAGMA foreign_key_check");
  record(
    res.rows.length === 0 ? "PASS" : "FAIL",
    `PRAGMA foreign_key_check (${res.rows.length} violation(s))`,
    res.rows.slice(0, 20).map((v) => `${v.table} rowid=${v.rowid} -> ${v.parent} (fk #${v.fkid})`)
  );
}

async function checkSchemaAgainstMigrations(client: Client, objects: SchemaObject[]) {
  const dir = mkdtempSync(join(tmpdir(), "jib-verify-reference-"));
  const refPath = join(dir, "reference.db");
  try {
    buildMigrateDeployDb(refPath);
    const ref = openLocalDb(refPath);
    let refObjects: SchemaObject[];
    try {
      refObjects = await readSchemaObjects(ref);
    } finally {
      ref.close();
    }
    const diff = diffSchemaObjects(refObjects, objects);
    const lines = [
      ...diff.missing.map((o) => `missing from target: ${fmtObj(o)}`),
      ...diff.unexpected.map((o) => `not produced by migrations: ${fmtObj(o)}`),
      ...diff.changed.map((c) => `SQL differs: ${fmtObj(c.expected)}\n         migrations: ${c.expected.sql}\n         target:     ${c.actual.sql}`),
    ];
    record(
      lines.length ? "FAIL" : "PASS",
      `schema == fresh \`migrate deploy\` (${refObjects.length} sqlite_master objects compared incl. SQL text)`,
      lines
    );

    const missingRequired = REQUIRED_INDEXES.filter((name) => !objects.some((o) => o.type === "index" && o.name === name));
    record(missingRequired.length ? "FAIL" : "PASS", `required indexes present: ${REQUIRED_INDEXES.join(", ")}`, missingRequired.map((n) => `missing: ${n}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const problems = checkMigrateDeployBookkeeping(await readMigrationRows(client, objects), listMigrationFolders());
  record(problems.length ? "FAIL" : "PASS", "_prisma_migrations matches prisma/migrations", problems);
}

async function checkSequence(client: Client, objects: SchemaObject[], snapshot: Snapshot | null) {
  const seq = await readSequence(client, objects);
  const snap = new Map((snapshot?.sqliteSequence ?? []).map((s) => [s.name, Number(s.seq)]));
  const bad: string[] = [];
  const lines: string[] = [];
  for (const table of autoincrementTables(objects)) {
    const r = await client.execute(`SELECT max(rowid) AS m FROM ${quoteIdent(table)}`);
    const maxId = r.rows[0].m === null ? 0 : Number(r.rows[0].m);
    const cur = seq.get(table) ?? 0;
    const live = snap.get(table);
    const line = `${table.padEnd(22)} seq ${cur}, max(id) ${maxId}${snapshot ? `, live seq ${live ?? "-"}` : ""}`;
    if (cur < maxId || (live !== undefined && cur < live)) bad.push(line);
    else lines.push(line);
  }
  record(bad.length ? "FAIL" : "PASS", `sqlite_sequence >= max(id)${snapshot ? " and >= live seq" : ""}`, bad.length ? bad : lines);
}

async function checkBackupContent(client: Client, backup: Backup) {
  const bad: string[] = [];
  let compared = 0;
  for (const [table, rows] of Object.entries(backup)) {
    if (rows.length === 0) continue;
    const pk = (await readColumns(client, table)).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const keyCols = pk.length ? pk : ["rowid"];
    const res = await client.execute(`SELECT ${pk.length ? "" : "rowid, "}* FROM ${quoteIdent(table)}`);
    const keyOf = (row: Record<string, unknown>) => JSON.stringify(keyCols.map((c) => row[c]));
    const targetRows = new Map(res.rows.map((r) => [keyOf(r as unknown as Record<string, unknown>), r as unknown as Record<string, unknown>]));
    for (const row of rows) {
      compared++;
      const t = targetRows.get(keyOf(row));
      if (!t) {
        if (bad.length < 20) bad.push(`${table} ${keyOf(row)}: missing from target`);
        continue;
      }
      for (const [col, value] of Object.entries(row)) {
        if (t[col] !== value && bad.length < 20) {
          bad.push(`${table} ${keyOf(row)}.${col}: backup ${JSON.stringify(value)} | target ${JSON.stringify(t[col])}`);
        }
      }
    }
  }
  record(bad.length ? "FAIL" : "PASS", `backup content == target content (${compared} row(s) compared by primary key)`, bad);
}

async function reportSnapshotDrift(client: Client, objects: SchemaObject[], snapshot: Snapshot, manifest: Manifest) {
  const { structure: live, failures } = await structureFromSnapshot(snapshot);
  if (failures.length) record("WARN", "some live DDL could not be rebuilt in memory for comparison", failures);
  const drift = diffStructures(live, await describeStructure(client, objects));
  record(drift.liveOnly.length ? "WARN" : "PASS", `live objects missing in target (${drift.liveOnly.length})`, drift.liveOnly);
  record("INFO", `target objects not on live (${drift.targetOnly.length})`, drift.targetOnly);
  record(drift.different.length ? "WARN" : "PASS", `objects present on both but defined differently (${drift.different.length})`, drift.different);

  const textDiff = diffSchemaObjects(
    snapshot.sqliteMaster.filter((o) => !o.name.startsWith("sqlite_")),
    objects.filter((o) => !o.name.startsWith("sqlite_")),
    { normalizeSql: true }
  );
  record("INFO", `DDL text differs between live and target for ${textDiff.changed.length} object(s) (whitespace-normalized)`, textDiff.changed.map((c) => fmtObj(c.expected)));

  const countDiffs = Object.entries(manifest.tableRowCounts ?? {})
    .filter(([t, n]) => snapshot.tableRowCounts?.[t] !== undefined && snapshot.tableRowCounts[t] !== n)
    .map(([t, n]) => `${t}: snapshot ${snapshot.tableRowCounts[t]}, backup ${n}`);
  record(countDiffs.length ? "WARN" : "PASS", "snapshot row counts == backup manifest (backup and snapshot taken at the same DB state)", countDiffs);

  const folders = listMigrationFolders();
  const liveNames = new Set((snapshot.prismaMigrations ?? []).map((m) => m.migration_name));
  const liveMissing = folders.filter((f) => !liveNames.has(f.name)).map((f) => f.name);
  record("INFO", `migrations with no _prisma_migrations row on live (${liveMissing.length})`, liveMissing);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { snapshot: { type: "string" }, backup: { type: "string" } },
  });
  if (positionals.length !== 2) {
    throw new Error("Usage: verify-sqlite-copy.ts <target.db> <manifest.json> [--snapshot snapshot.json] [--backup backup.json]");
  }
  const targetPath = resolveLocalDbPath(positionals[0], { mustExist: true });
  const manifest = readJsonFile<Manifest>(positionals[1], "manifest");
  const snapshot = values.snapshot ? readJsonFile<Snapshot>(values.snapshot, "snapshot") : null;
  const backup = values.backup ? readJsonFile<Backup>(values.backup, "backup") : null;

  console.log(`Verifying local SQLite copy: ${targetPath}`);
  console.log(`  manifest: ${positionals[1]} (source: ${manifest.sourceUrl ?? "?"}, taken ${manifest.takenAt ?? "?"})`);
  if (snapshot) console.log(`  snapshot: ${values.snapshot} (taken ${snapshot.takenAt ?? "?"})`);
  if (backup) console.log(`  backup:   ${values.backup}`);
  console.log("");

  const client = openLocalDb(targetPath);
  try {
    const objects = await readSchemaObjects(client);
    await checkRowCounts(client, objects, manifest);
    await checkIntegrity(client);
    await checkForeignKeys(client);
    await checkSchemaAgainstMigrations(client, objects);
    await checkSequence(client, objects, snapshot);
    if (backup) await checkBackupContent(client, backup);
    if (snapshot) await reportSnapshotDrift(client, objects, snapshot, manifest);
  } finally {
    client.close();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const warned = results.filter((r) => r.status === "WARN");
  console.log(
    `\n${failed.length ? "VERIFICATION FAILED" : "VERIFICATION PASSED"}: ${results.filter((r) => r.status === "PASS").length} pass, ${failed.length} fail, ${warned.length} warn`
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
