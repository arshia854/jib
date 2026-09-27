/**
 * One-off backfill: reconciles Prisma's `_prisma_migrations` bookkeeping
 * table on the live Turso DB with the migrations that have already been
 * applied there by hand (Prisma's CLI can't connect to this project's
 * libsql:// datasource itself - see AGENTS.md's "Turso migration workflow"
 * section for why, and the step-by-step process this backfills the
 * bookkeeping for).
 *
 * Connects the same way lib/prisma.ts does at runtime (TURSO_DATABASE_URL /
 * TURSO_AUTH_TOKEN via @libsql/client) rather than through the Prisma CLI,
 * since the CLI's schema-engine can't parse a libsql:// URL at all.
 *
 * Safe to re-run: skips any migration_name that already has a row. Defaults
 * to a dry run (SELECT-only, no writes) - pass --execute to actually insert.
 *
 * Also doubles as the --fix-checksums tool: when a migration.sql file already
 * recorded in _prisma_migrations gets rewritten in place (see AGENTS.md's
 * note on the two Postgres-dialect migrations corrected to SQLite), its
 * checksum in Turso goes stale and needs updating to match the new file
 * bytes. That mode reuses checksumFor() below rather than duplicating the
 * hashing logic.
 *
 * Usage:
 *   npx tsx scripts/backfill-migration-history.ts                            # dry run: backfill missing rows
 *   npx tsx scripts/backfill-migration-history.ts --execute                  # apply: insert missing rows
 *   npx tsx scripts/backfill-migration-history.ts --fix-checksums            # dry run: show old vs. new checksum for rewritten migrations
 *   npx tsx scripts/backfill-migration-history.ts --fix-checksums --execute  # apply: update those checksums in Turso
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const MIGRATIONS_DIR = join(process.cwd(), "prisma/migrations");

// Every migration folder that has actually been applied to the live Turso
// DB by hand, oldest first (verified per-migration: live tables/columns/
// indexes match what each one describes). Phase 19 fix (2026-08-23): this
// list had drifted to include 20260823072849_add_transaction_balance_
// groupby_index, but Phase 17's own roadmap entry confirms that migration's
// DDL was never applied live - only verified against the local/test DB.
// Adding a name here before the real DDL has actually been run against
// Turso would let --execute insert a false "already applied" bookkeeping
// row - the exact bug the name gets added "as part of the live-apply step
// itself, not before it's approved" rule (see AGENTS.md step 6) exists to
// prevent. Removed until that migration is actually applied live; add it
// back at that point, per the normal process.
const MIGRATION_NAMES = [
  "20260802152001_init_postgres",
  "20260802175335_add_admin_role_error_log_default_categories",
  "20260806121834_add_spending_summary_cache",
  "20260806140512_add_user_fact",
  "20260806144050_add_category_is_essential",
  "20260808153511_add_transaction_source",
  "20260819081756_add_transaction_idempotency_key",
  "20260822213426_add_user_role_check_constraint",
  "20260824095212_add_transaction_enrichment_status",
  "20260825171540_add_assets",
  "20260904102636_add_conversation",
  "20260905094309_add_goal",
  "20260905173527_add_transaction_suggested_category",
  "20260911104341_add_transaction_transfer_group_id",
  "20260912134216_add_goal_savings_account",
  "20260917211853_add_savings_strategy",
  "20260925093410_add_category_is_archived",
  "20260912165902_add_live_price_quota_exceeded_until",
  "20260926152837_add_notifications",
];

// The two migrations whose migration.sql was rewritten from its original
// (invalid) Postgres dialect to valid SQLite on 2026-08-06 - see AGENTS.md's
// "Applying schema changes to the live database (Turso)" section. Rewriting
// the file changed its SHA-256 checksum, so the row(s) the backfill above
// already wrote into Turso's _prisma_migrations for these two now have a
// stale `checksum` column that no longer matches the as-committed file.
// --fix-checksums recomputes and reports the correct value for these names
// only; it never touches MIGRATION_NAMES or the rows' other columns.
const CHECKSUM_FIX_NAMES = [
  "20260802152001_init_postgres",
  "20260802175335_add_admin_role_error_log_default_categories",
];

// Prisma's standard sqlite _prisma_migrations DDL, copied verbatim from the
// installed schema-engine binary's embedded SQL
// (node_modules/@prisma/engines/schema-engine-*) rather than reconstructed
// from memory.
const CREATE_TABLE_SQL = `CREATE TABLE "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/** "20260802152001_init_postgres" -> 2026-08-02T15:20:01Z. Best-effort backfill timestamp - Prisma has no real record of when these were actually applied against Turso, so the folder's own timestamp prefix is the closest honest approximation. */
function timestampFromFolderName(name: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(name);
  if (!match) throw new Error(`Cannot parse timestamp from migration folder name: "${name}"`);
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** SHA-256 hex digest of the migration.sql file's raw bytes - the exact algorithm the schema-engine binary uses (confirmed via its `schema_connector::checksum::compute_checksum` / sha2 symbols), so a future `migrate status`/`migrate deploy` checksum check against the as-committed file passes. */
function checksumFor(migrationName: string): string {
  const sql = readFileSync(join(MIGRATIONS_DIR, migrationName, "migration.sql"));
  return createHash("sha256").update(sql).digest("hex");
}

/** --fix-checksums mode: reports (and, with --execute, applies) old vs. new checksum for CHECKSUM_FIX_NAMES. Never touches migration_name, timestamps, or applied_steps_count - only the checksum column, and only for rows that already exist. */
async function runChecksumFix(client: ReturnType<typeof createClient>, execute: boolean) {
  const rows = await client.execute({
    sql: `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE migration_name IN (${CHECKSUM_FIX_NAMES.map(() => "?").join(",")})`,
    args: CHECKSUM_FIX_NAMES,
  });
  const existing = new Map(rows.rows.map((r) => [r.migration_name as string, r.checksum as string]));

  const plan = CHECKSUM_FIX_NAMES.map((name) => ({
    migration_name: name,
    old_checksum: existing.get(name) ?? null,
    new_checksum: checksumFor(name),
  }));

  console.log(`\n${execute ? "EXECUTING" : "DRY RUN"} - checksum diff for ${plan.length} migration(s):\n`);
  for (const row of plan) {
    if (row.old_checksum === null) {
      console.log(`${row.migration_name}: NOT FOUND in _prisma_migrations - skipping.`);
    } else if (row.old_checksum === row.new_checksum) {
      console.log(`${row.migration_name}: unchanged (checksum already matches file) - skipping.`);
    } else {
      console.log(`${row.migration_name}:`);
      console.log(`  old: ${row.old_checksum}`);
      console.log(`  new: ${row.new_checksum}`);
    }
  }

  const toUpdate = plan.filter((row) => row.old_checksum !== null && row.old_checksum !== row.new_checksum);

  if (!execute) {
    console.log(
      `\nDry run only - no writes made. ${toUpdate.length} row(s) would be updated. Re-run with --fix-checksums --execute to apply.`
    );
    return;
  }

  for (const row of toUpdate) {
    await client.execute({
      sql: `UPDATE "_prisma_migrations" SET checksum = ? WHERE migration_name = ?`,
      args: [row.new_checksum, row.migration_name],
    });
  }
  console.log(`\nUpdated ${toUpdate.length} row(s).`);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const fixChecksums = process.argv.includes("--fix-checksums");

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");
  const client = createClient({ url, authToken });

  if (fixChecksums) {
    await runChecksumFix(client, execute);
    return;
  }

  const tableExists =
    (await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`)).rows
      .length > 0;
  console.log(
    tableExists ? "_prisma_migrations already exists." : "_prisma_migrations does not exist yet - will be created."
  );

  const existingNames = tableExists
    ? new Set(
        (await client.execute(`SELECT migration_name FROM "_prisma_migrations"`)).rows.map(
          (r) => r.migration_name as string
        )
      )
    : new Set<string>();

  const plan = MIGRATION_NAMES.filter((name) => !existingNames.has(name)).map((name) => {
    const appliedAt = timestampFromFolderName(name).toISOString();
    return {
      id: randomUUID(),
      checksum: checksumFor(name),
      finished_at: appliedAt,
      migration_name: name,
      started_at: appliedAt,
      applied_steps_count: 1,
    };
  });

  console.log(
    `\n${execute ? "EXECUTING" : "DRY RUN"} - ${plan.length} row(s) to insert (of ${MIGRATION_NAMES.length} total migrations):\n`
  );
  for (const row of plan) console.log(row);

  const alreadyPresent = MIGRATION_NAMES.length - plan.length;
  if (alreadyPresent > 0) {
    console.log(`\n${alreadyPresent} migration(s) already present in _prisma_migrations - skipped.`);
  }

  if (!execute) {
    console.log("\nDry run only - no writes made. Re-run with --execute to apply.");
    return;
  }

  if (!tableExists) {
    await client.execute(CREATE_TABLE_SQL);
    console.log("\nCreated _prisma_migrations.");
  }
  for (const row of plan) {
    await client.execute({
      sql: `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [row.id, row.checksum, row.finished_at, row.migration_name, row.started_at, row.applied_steps_count],
    });
  }
  console.log(`Inserted ${plan.length} row(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
