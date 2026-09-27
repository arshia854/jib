/**
 * F3-prep: read-only snapshot of the database's schema-level state - the
 * parts scripts/backup-live-db.ts does NOT capture (it dumps user-table rows
 * only): every sqlite_master row (type, name, tbl_name, sql - tables,
 * indexes, triggers, views), sqlite_sequence (name, seq),
 * _prisma_migrations (migration_name, checksum, finished_at, rolled_back_at,
 * applied_steps_count), and a row count for every table.
 * scripts/load-backup-into-sqlite.ts --snapshot uses it to keep
 * sqlite_sequence >= live's; scripts/verify-sqlite-copy.ts --snapshot uses
 * it for the live-vs-target drift report.
 *
 * READ-ONLY: issues nothing but SELECTs (no PRAGMAs, no writes). After one
 * sqlite_master read to learn the table list, everything is read in a single
 * read-mode batch (one read transaction), so all counts and the sequence
 * come from the same DB state.
 *
 * SAFETY: prints the resolved URL first, and refuses anything but a local
 * file: URL unless --allow-remote is passed. Per AGENTS.md, running this
 * against the live Turso DB (even though it's SELECT-only) needs explicit
 * approval first - --allow-remote exists so that can't happen by accident.
 *
 * Usage:
 *   npx tsx scripts/snapshot-live-schema.ts [outDir] [--allow-remote]
 *   (outDir defaults to ./backups, gitignored - see .gitignore)
 */
import "dotenv/config";
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "allow-remote": { type: "boolean", default: false } },
  });

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set.");
  console.log(`Resolved TURSO_DATABASE_URL: ${url}`);

  const isLocalFile = url.startsWith("file:");
  if (!isLocalFile && !values["allow-remote"]) {
    console.error(
      "Refusing: this is not a local file: URL. Reading the live DB (even SELECT-only) needs explicit approval " +
        "per AGENTS.md - once approved, re-run with --allow-remote."
    );
    process.exit(1);
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!isLocalFile && !authToken) throw new Error("TURSO_AUTH_TOKEN not set.");

  const outDir = positionals[0] || join(process.cwd(), "backups");
  mkdirSync(outDir, { recursive: true });

  const client = createClient({ url, authToken });
  const masterSql = `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`;
  const firstTables = (await client.execute(masterSql)).rows.filter((r) => r.type === "table").map((r) => String(r.name));
  const hasSequence = firstTables.includes("sqlite_sequence");
  const hasMigrations = firstTables.includes("_prisma_migrations");

  const stmts = [
    masterSql,
    hasSequence ? `SELECT name, seq FROM sqlite_sequence ORDER BY name` : `SELECT 1 WHERE 0`,
    hasMigrations
      ? `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`
      : `SELECT 1 WHERE 0`,
    ...firstTables.map((t) => `SELECT count(*) AS n FROM ${quote(t)}`),
  ];
  const [master, sequence, migrations, ...counts] = await client.batch(stmts, "read");
  client.close();

  const sqliteMaster = master.rows.map((r) => ({
    type: String(r.type),
    name: String(r.name),
    tbl_name: String(r.tbl_name),
    sql: r.sql === null ? null : String(r.sql),
  }));
  const tablesNow = sqliteMaster.filter((o) => o.type === "table").map((o) => o.name);
  if (tablesNow.join("\u0000") !== firstTables.join("\u0000")) {
    throw new Error("The table list changed between the two sqlite_master reads (schema changed mid-snapshot) - re-run.");
  }

  const tableRowCounts: Record<string, number> = {};
  firstTables.forEach((t, i) => (tableRowCounts[t] = Number(counts[i].rows[0].n)));

  const snapshot = {
    takenAt: new Date().toISOString(),
    sourceUrl: url,
    sqliteMaster,
    sqliteSequence: hasSequence ? sequence.rows.map((r) => ({ name: String(r.name), seq: Number(r.seq) })) : null,
    prismaMigrations: hasMigrations
      ? migrations.rows.map((r) => ({
          migration_name: String(r.migration_name),
          checksum: String(r.checksum),
          finished_at: r.finished_at,
          rolled_back_at: r.rolled_back_at,
          applied_steps_count: r.applied_steps_count,
        }))
      : null,
    tableRowCounts,
  };

  const byType = (type: string) => sqliteMaster.filter((o) => o.type === type).length;
  console.log(
    `sqlite_master: ${byType("table")} tables, ${byType("index")} indexes, ${byType("trigger")} triggers, ${byType("view")} views`
  );
  console.log(`sqlite_sequence: ${snapshot.sqliteSequence ? `${snapshot.sqliteSequence.length} rows` : "(table absent)"}`);
  console.log(`_prisma_migrations: ${snapshot.prismaMigrations ? `${snapshot.prismaMigrations.length} rows` : "(table absent)"}`);
  for (const [t, n] of Object.entries(tableRowCounts)) console.log(` - ${t}: ${n} rows`);

  const file = join(outDir, `jib-live-schema-${snapshot.takenAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot written: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
