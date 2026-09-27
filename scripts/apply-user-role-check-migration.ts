/**
 * One-off live-apply script for
 * prisma/migrations/20260822213426_add_user_role_check_constraint.
 *
 * Applies that migration's SQL to the live Turso DB, statement by statement,
 * in order - same connection pattern as scripts/backfill-migration-history.ts
 * (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN via @libsql/client, not the Prisma
 * CLI - see AGENTS.md for why the CLI can't reach a libsql:// datasource).
 *
 * The SQL executed here is read directly from the migration.sql file on
 * disk, never hardcoded a second time - so the file that's actually applied
 * and the file committed to the repo can never drift from each other.
 *
 * After the DDL succeeds, this also inserts the matching bookkeeping row
 * into _prisma_migrations, in the exact column shape
 * scripts/backfill-migration-history.ts already uses for every other
 * migration recorded there (id, checksum, finished_at, migration_name,
 * started_at, applied_steps_count - rolled_back_at/logs left NULL).
 *
 * PRE-REQUISITE: take a fresh backup first (scripts/backup-live-db.ts) -
 * this script does not take one itself.
 *
 * NOT re-run-safe after a partial failure: SQLite's RedefineTables pattern
 * (CREATE new_User -> INSERT...SELECT -> DROP User -> RENAME) has no
 * transactional wrapper across statements here (PRAGMA statements can't run
 * inside a transaction in SQLite), so a failure partway through can leave
 * "new_User" already created (re-running from the top would then fail with
 * "table new_User already exists"), or - if DROP succeeded but RENAME didn't
 * - leave the DB with a "new_User" holding the real data and no "User"
 * table at all. See the try/catch below for what to do if that happens: stop,
 * inspect `SELECT name FROM sqlite_master WHERE type='table'` by hand, and
 * restore from the fresh backup (or Turso PITR, see AGENTS.md) rather than
 * guessing at partial-recovery SQL.
 *
 * Usage:
 *   npx tsx scripts/apply-user-role-check-migration.ts
 *
 * This has NO --dry-run / interactive confirmation flag by design: the gate
 * on running this against live Turso is the conversation that authorizes
 * it, not the script itself.
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const MIGRATION_NAME = "20260822213426_add_user_role_check_constraint";
const MIGRATION_PATH = join(process.cwd(), "prisma/migrations", MIGRATION_NAME, "migration.sql");

/**
 * Splits the migration file into individual statements to execute one at a
 * time (libsql's `execute()` takes a single statement per call). Strips
 * comment-only lines first. This migration's file has no inline
 * (same-line-as-code) comments and no string literals containing ';' or
 * '--', so a line-strip + semicolon-split is safe here - verified by eye
 * against the file, not a general-purpose SQL parser.
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

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");

  const sqlBytes = readFileSync(MIGRATION_PATH);
  const statements = parseStatements(sqlBytes.toString("utf-8"));

  console.log(`Loaded ${statements.length} statement(s) from ${MIGRATION_PATH}`);

  const client = createClient({ url, authToken });
  console.log(`Connecting to: ${url}`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    console.log(`\n[${i + 1}/${statements.length}] Executing:\n${stmt}\n`);
    try {
      await client.execute(stmt);
      console.log(`[${i + 1}/${statements.length}] OK`);
    } catch (e) {
      console.error(`\nFAILED at statement ${i + 1}/${statements.length}:`);
      console.error(stmt);
      console.error(e);
      console.error(
        `\nDDL sequence aborted partway through - the live DB may now be in an ambiguous ` +
          `intermediate state (see this file's header comment on why RedefineTables here isn't ` +
          `naturally re-run-safe). Do not re-run this script blindly. Manual recovery:\n` +
          `  1. Inspect current tables by hand: SELECT name FROM sqlite_master WHERE type='table';\n` +
          `  2. If "new_User" exists alongside "User", the CREATE TABLE and/or INSERT...SELECT ran ` +
          `but DROP/RENAME did not - decide by hand whether to drop the incomplete "new_User" and ` +
          `retry, or investigate further.\n` +
          `  3. If "User" is missing entirely, restore from the fresh backup taken before this run, ` +
          `or via Turso point-in-time recovery (see AGENTS.md's "Backing up the live database" ` +
          `section) - do not attempt to hand-write recovery SQL under time pressure.\n` +
          `  4. No _prisma_migrations bookkeeping row was inserted (that only happens after all ` +
          `statements above succeed), so bookkeeping is not out of sync from this failure alone.`
      );
      process.exit(1);
    }
  }

  console.log(`\nAll ${statements.length} statement(s) applied successfully.`);

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

  // Read-only verification: confirm the CHECK constraint is actually present
  // in the live schema now (table_info doesn't surface CHECK constraints,
  // so read the table's own CREATE TABLE SQL from sqlite_master instead).
  const schemaRow = await client.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='User'`
  );
  console.log(`\nLive "User" table definition after migration:`);
  console.log(schemaRow.rows[0]?.sql ?? "(not found)");

  const info = await client.execute(`PRAGMA table_info("User")`);
  console.log(`\nPRAGMA table_info("User"):`);
  for (const col of info.rows) console.log(col);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
