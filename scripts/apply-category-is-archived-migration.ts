/**
 * One-off live-apply script for
 * prisma/migrations/20260925093410_add_category_is_archived.
 *
 * Applies that migration's SQL to the live Turso DB as ONE transaction on
 * ONE connection - same credentials as scripts/backfill-migration-history.ts
 * (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN via @libsql/client, not the Prisma
 * CLI - see AGENTS.md for why the CLI can't reach a libsql:// datasource).
 *
 * The SQL executed here is read directly from the migration.sql file on
 * disk, never hardcoded a second time - so the file that's actually applied
 * and the file committed to the repo can never drift from each other.
 *
 * After the DDL commits, this also inserts the matching bookkeeping row
 * into _prisma_migrations, in the exact column shape
 * scripts/backfill-migration-history.ts already uses for every other
 * migration recorded there (id, checksum, finished_at, migration_name,
 * started_at, applied_steps_count - rolled_back_at/logs left NULL).
 *
 * PRE-REQUISITE: take a fresh backup first (scripts/backup-live-db.ts) -
 * this script does not take one itself.
 *
 * WHY THIS ONE IS TRANSACTIONAL (unlike apply-user-role-check-migration.ts):
 * this migration is two back-to-back RedefineTables sequences (Category,
 * then DefaultCategory - CREATE new_X -> INSERT...SELECT -> DROP X -> RENAME
 * -> recreate indexes, 16 statements total), so a mid-sequence failure run
 * statement-by-statement could leave "Category" dropped with the real data
 * sitting in "new_Category". Two SQLite/libsql facts shape how it's wrapped:
 *
 *   1. `PRAGMA foreign_keys` is a documented no-op inside an open
 *      transaction (sqlite.org/pragma.html#pragma_foreign_keys). The
 *      `PRAGMA foreign_keys=OFF` that migrate diff put in the file would do
 *      nothing if it ran after BEGIN - it has to run BEFORE BEGIN, on the
 *      same connection.
 *   2. Over libsql:// (HTTP/Hrana), every `client.execute()` call opens its
 *      own stream - i.e. its own server-side connection - so a loop of
 *      execute("BEGIN IMMEDIATE"), execute(stmt), ..., execute("COMMIT")
 *      would NOT be one transaction against live Turso at all (it would be
 *      against a file: DB, which is exactly why that bug wouldn't show up
 *      in local testing). See node_modules/@libsql/client/lib-esm/http.js.
 *
 * `client.migrate(stmts)` is the one @libsql/client API that handles both:
 * on a single stream/connection it runs `PRAGMA foreign_keys=off`, BEGIN,
 * every statement in order, COMMIT - or, if any statement fails, skips the
 * rest, runs ROLLBACK on that same connection - and finally
 * `PRAGMA foreign_keys=on`. The ROLLBACK is therefore issued by the library,
 * not by this file (there's no way to issue one from here on the same Hrana
 * stream after the fact). Its BEGIN is DEFERRED, not IMMEDIATE; that's fine
 * here because the first statement that touches the DB is a CREATE TABLE
 * (a write), so the write lock is taken at the first real statement with no
 * earlier read in the transaction to upgrade from. The file's own
 * in-transaction PRAGMA foreign_keys lines still run, as harmless no-ops;
 * its defer_foreign_keys lines are legal in a transaction and still apply.
 *
 * Rollback of a partial sequence was verified (not assumed) against scratch
 * DBs only - a local file: DB and a local sqld server over HTTP - by
 * corrupting statement 6 (the RENAME right after DROP TABLE "Category") and
 * checking the schema/data was byte-for-byte what it was before. It has not
 * been exercised against Turso itself.
 *
 * If it fails: the error names the statement that failed, and nothing from
 * this migration should have been committed. Confirm that by hand
 * (`SELECT name FROM sqlite_master WHERE type='table'` - "Category" present,
 * no "new_Category"/"new_DefaultCategory", and `PRAGMA table_info("Category")`
 * has no isArchived) before deciding anything else. If that check shows
 * anything other than the untouched pre-migration state, stop and restore
 * from the fresh backup (or Turso PITR, see AGENTS.md) rather than
 * hand-writing recovery SQL.
 *
 * Usage:
 *   npx tsx scripts/apply-category-is-archived-migration.ts
 *
 * This has NO --dry-run / interactive confirmation flag by design: the gate
 * on running this against live Turso is the conversation that authorizes
 * it, not the script itself.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, LibsqlBatchError, type Client } from "@libsql/client";

const MIGRATION_NAME = "20260925093410_add_category_is_archived";
const MIGRATION_PATH = join(process.cwd(), "prisma/migrations", MIGRATION_NAME, "migration.sql");
const EXPECTED_STATEMENT_COUNT = 16;
const TABLES = ["Category", "DefaultCategory"] as const;

/**
 * Splits the migration file into individual statements (client.migrate()
 * takes one statement per array entry). Strips comment-only lines first.
 * This migration's file has no inline (same-line-as-code) comments and no
 * string literals containing ';' or '--', so a line-strip + semicolon-split
 * is safe here - verified by eye against the file, not a general-purpose
 * SQL parser. EXPECTED_STATEMENT_COUNT guards against that assumption
 * silently breaking.
 */
function parseStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function rowCounts(client: Client) {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
    counts[table] = Number(r.rows[0].n);
  }
  return counts;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");

  const sqlBytes = readFileSync(MIGRATION_PATH);
  const statements = parseStatements(sqlBytes.toString("utf-8"));

  console.log(`Loaded ${statements.length} statement(s) from ${MIGRATION_PATH}`);
  if (statements.length !== EXPECTED_STATEMENT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_STATEMENT_COUNT} statements, parsed ${statements.length} - migration.sql ` +
        `changed or the naive split broke. Not applying.`
    );
  }

  const client = createClient({ url, authToken });
  console.log(`Connecting to: ${url}`);

  // Read-only pre-flight: a pre-existing FK violation would otherwise only
  // show up in the post-apply check below and look like this migration's
  // fault.
  const preViolations = await client.execute(`PRAGMA foreign_key_check`);
  if (preViolations.rows.length > 0) {
    console.error(`PRAGMA foreign_key_check already reports violations BEFORE applying:`);
    for (const row of preViolations.rows) console.error(row);
    throw new Error("Pre-existing foreign key violations - not applying.");
  }
  const before = await rowCounts(client);
  console.log(`\nPre-flight: 0 foreign key violations; row counts`, before);

  for (let i = 0; i < statements.length; i++) {
    console.log(`\n[${i + 1}/${statements.length}]\n${statements[i]}`);
  }
  console.log(`\nRunning all ${statements.length} statement(s) as one transaction (client.migrate)...`);

  try {
    await client.migrate(statements);
  } catch (e) {
    const failedAt = e instanceof LibsqlBatchError ? e.statementIndex : undefined;
    if (failedAt !== undefined) {
      console.error(`\nFAILED at statement ${failedAt + 1}/${statements.length}:`);
      console.error(statements[failedAt]);
    } else {
      console.error(`\nFAILED (no statement index on the error - failure was outside the statement list):`);
    }
    console.error(e);
    console.error(
      `\nThe transaction was rolled back on the same connection by client.migrate(), so nothing ` +
        `from this migration should have been committed. Confirm by hand before doing anything else:\n` +
        `  1. SELECT name FROM sqlite_master WHERE type='table';  -> "Category" and ` +
        `"DefaultCategory" present, no "new_Category"/"new_DefaultCategory".\n` +
        `  2. PRAGMA table_info("Category"); PRAGMA table_info("DefaultCategory");  -> no isArchived.\n` +
        `  3. SELECT COUNT(*) FROM "Category"; / "DefaultCategory"  -> matches the pre-flight counts ` +
        `above (${JSON.stringify(before)}).\n` +
        `  If any of those don't hold, restore from the fresh backup taken before this run, or via ` +
        `Turso point-in-time recovery (see AGENTS.md's "Backing up the live database" section) - do ` +
        `not attempt to hand-write recovery SQL under time pressure.\n` +
        `  4. No _prisma_migrations bookkeeping row was inserted (that only happens after the ` +
        `transaction commits), so bookkeeping is not out of sync from this failure alone.`
    );
    process.exit(1);
  }

  console.log(`\nAll ${statements.length} statement(s) committed.`);

  const checksum = createHash("sha256").update(sqlBytes).digest("hex");
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    checksum,
    finished_at: now,
    migration_name: MIGRATION_NAME,
    started_at: now,
    applied_steps_count: 1,
  };

  console.log(`\nInserting _prisma_migrations bookkeeping row:`, row);
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.checksum, row.finished_at, row.migration_name, row.started_at, row.applied_steps_count],
  });
  console.log("Bookkeeping row inserted.");

  // Read-only verification. foreign_keys was OFF for the whole sequence, so
  // nothing checked FKs during it - this is the check.
  const postViolations = await client.execute(`PRAGMA foreign_key_check`);
  console.log(`\nPRAGMA foreign_key_check: ${postViolations.rows.length} violation(s)`);
  for (const r of postViolations.rows) console.log(r);

  const after = await rowCounts(client);
  const countsMatch = TABLES.every((t) => before[t] === after[t]);
  console.log(`Row counts after:`, after, countsMatch ? "(unchanged)" : "(MISMATCH vs pre-flight!)");

  for (const table of TABLES) {
    const col = await client.execute(
      `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}') WHERE name = 'isArchived'`
    );
    console.log(`${table}.isArchived:`, col.rows[0] ?? "(MISSING!)");
  }

  const indexes = await client.execute(
    `SELECT tbl_name, name FROM sqlite_master WHERE type='index' AND tbl_name IN ('Category', 'DefaultCategory') AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`
  );
  console.log(`Indexes:`, indexes.rows.map((r) => `${r.tbl_name}.${r.name}`));

  const leftovers = await client.execute(
    `SELECT name FROM sqlite_master WHERE name IN ('new_Category', 'new_DefaultCategory')`
  );
  console.log(`Leftover new_* tables: ${leftovers.rows.length === 0 ? "none" : leftovers.rows.map((r) => r.name)}`);

  if (postViolations.rows.length > 0 || !countsMatch) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
