/**
 * Read-only logical export of the live Turso database.
 *
 * Stand-in for the documented `turso db shell <db> .dump` backup runbook
 * (AGENTS.md, "Backing up the live database (Turso)") — that path needs an
 * authenticated Turso CLI session against the account that owns this
 * database, which is unavailable this session. This script instead connects
 * with the app's own runtime credentials (TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN, same env vars `lib/prisma.ts` requires) via the raw
 * `@libsql/client` driver — the same package/connection pattern already
 * used by `scripts/backfill-migration-history.ts`.
 *
 * Deliberately uses the raw libsql client rather than importing
 * `lib/prisma.ts`'s Prisma Client: Prisma coerces column values into JS
 * types (DateTime -> `Date`, SQLite 0/1 -> `Boolean`) on the way out, which
 * risks losing the exact on-disk representation. The raw client returns the
 * literal stored value for each column, which is what a faithful,
 * restorable export needs — read once, write back unchanged.
 *
 * Read-only: every statement issued is a SELECT/PRAGMA. Nothing in this
 * file executes INSERT/UPDATE/DELETE/DDL against the live DB.
 *
 * KNOWN LIMITATIONS vs. a native `turso db shell .dump` (see AGENTS.md and
 * the ground rules for this task) — stated explicitly, not glossed over:
 *   - This is column-value fidelity, not a byte-exact SQLite file. It does
 *     not capture PRAGMA settings, the WAL/journal state, or anything at
 *     the SQLite storage-engine level.
 *   - It captures every user table plus `sqlite_sequence` (AUTOINCREMENT
 *     bookkeeping) and `_prisma_migrations`. It does NOT capture triggers
 *     or views — this schema is confirmed to have zero of either (checked
 *     via `sqlite_master` below, part of this script's own output), so
 *     that gap is moot for this database as it stands today, but would
 *     matter if either were ever added later.
 *   - Values are written back using each JS value's own type (string ->
 *     quoted+escaped literal, number/bigint -> bare literal, null -> NULL,
 *     Uint8Array -> SQLite blob literal). No reformatting of dates/numbers
 *     is performed in either direction, so round-tripping through this
 *     script cannot itself introduce a type-affinity change — but it also
 *     means this script trusts libsql's JS value mapping to be a faithful
 *     read of the column, which is a driver-level assumption, not
 *     something this script independently re-verifies at the byte level.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Expected app tables, derived from prisma/schema.prisma's model list (read
// directly, not guessed), ordered parent-before-child by FK dependency so a
// straight top-to-bottom re-import stays correct even if FK enforcement is
// ever turned on. Category/DefaultCategory are self-referential
// (parentId -> same table) — see the restore procedure's note on
// `PRAGMA defer_foreign_keys`.
const EXPECTED_TABLES = [
  "User",
  "DefaultCategory",
  "FinanceAccount",
  "Category",
  "ChatMessage",
  "SpendingSummaryCache",
  "UserFact",
  "ErrorLog",
  "Account",
  "MerchantMapping",
  "Transaction",
] as const;

// Bookkeeping tables that exist in the live DB but aren't schema.prisma
// models — captured for completeness (a full restore needs them) but kept
// out of the app-table row-count baseline used for before/after
// verification.
const BOOKKEEPING_TABLES = ["_prisma_migrations", "sqlite_sequence"] as const;

function sqlQuoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in export: ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `X'${hex}'`;
  }
  throw new Error(`Unhandled value type in export: ${typeof value} (${String(value)})`);
}

async function columnsOf(client: Client, table: string): Promise<string[]> {
  const info = await client.execute(`PRAGMA table_info(${sqlQuoteIdent(table)})`);
  return info.rows.map((r) => r.name as string);
}

async function dumpTable(client: Client, table: string): Promise<{ sql: string; rowCount: number; columns: string[] }> {
  const columns = await columnsOf(client, table);
  if (columns.length === 0) {
    throw new Error(`Table "${table}" reported zero columns via PRAGMA table_info — does it exist?`);
  }
  const orderBy = columns.includes("id") ? ` ORDER BY "id"` : "";
  const result = await client.execute(`SELECT * FROM ${sqlQuoteIdent(table)}${orderBy}`);

  const lines: string[] = [];
  lines.push(`-- Table: ${table} (${result.rows.length} rows)`);
  const colList = columns.map(sqlQuoteIdent).join(", ");
  for (const row of result.rows) {
    const values = columns.map((c) => sqlLiteral(row[c])).join(", ");
    lines.push(`INSERT INTO ${sqlQuoteIdent(table)} (${colList}) VALUES (${values});`);
  }
  lines.push("");
  return { sql: lines.join("\n"), rowCount: result.rows.length, columns };
}

async function main() {
  const outPath = process.argv[2] ?? `/home/abt/jib-db-backups/jib-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;

  const client = createClient({
    url: requireEnv("TURSO_DATABASE_URL"),
    authToken: requireEnv("TURSO_AUTH_TOKEN"),
  });

  // Cross-check live schema against what we expect from prisma/schema.prisma
  // before trusting the table list below — if these disagree, stop rather
  // than silently export a partial/wrong set of tables.
  const liveTables = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const liveTableNames = new Set(liveTables.rows.map((r) => r.name as string));
  const liveViewsAndTriggers = await client.execute(
    `SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger')`,
  );

  const missingFromLive = EXPECTED_TABLES.filter((t) => !liveTableNames.has(t));
  const unexpectedInLive = [...liveTableNames].filter(
    (t) => !EXPECTED_TABLES.includes(t as (typeof EXPECTED_TABLES)[number]) && t !== "_prisma_migrations",
  );

  if (missingFromLive.length > 0) {
    console.error("STOP: tables expected from prisma/schema.prisma are missing on the live DB:", missingFromLive);
    process.exit(1);
  }
  if (unexpectedInLive.length > 0) {
    console.error("STOP: live DB has tables not in prisma/schema.prisma's model list:", unexpectedInLive);
    process.exit(1);
  }
  if (liveViewsAndTriggers.rows.length > 0) {
    console.error("STOP: live DB has views/triggers this export does not capture:", liveViewsAndTriggers.rows);
    process.exit(1);
  }

  const hasSqliteSequence = liveTableNames.has("sqlite_sequence") || (await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`,
  )).rows.length > 0;

  console.log(`Schema check OK: ${EXPECTED_TABLES.length} expected app tables all present, no unexpected tables, no views/triggers.`);

  const allTables = [...EXPECTED_TABLES, ...BOOKKEEPING_TABLES.filter((t) => t !== "sqlite_sequence" || hasSqliteSequence)];

  const header = [
    `-- jib logical export (read-only, via raw @libsql/client)`,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Source: TURSO_DATABASE_URL (live production DB)`,
    `-- Method: scripts/backup-live-db.ts — see its header comment for exact scope/limitations`,
    `-- This is a substitute for the documented \`turso db shell <db> .dump\` runbook`,
    `-- (Turso CLI account access unavailable this session) — NOT byte-equivalent to a native .dump.`,
    ``,
  ].join("\n");

  const sections: string[] = [header];
  const rowCounts: Record<string, number> = {};

  for (const table of allTables) {
    const { sql, rowCount } = await dumpTable(client, table);
    sections.push(sql);
    rowCounts[table] = rowCount;
    console.log(`${table}: ${rowCount} rows`);
  }

  writeFileSync(outPath, sections.join("\n"), { encoding: "utf8" });

  console.log(`\nWritten to: ${outPath}`);
  console.log(`\nRow counts (app tables):`);
  for (const t of EXPECTED_TABLES) console.log(`  ${t}: ${rowCounts[t]}`);
  console.log(`\nRow counts (bookkeeping tables):`);
  for (const t of BOOKKEEPING_TABLES) {
    if (t in rowCounts) console.log(`  ${t}: ${rowCounts[t]}`);
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
