/**
 * One-off, read-only diagnostic: for three specific migrations, checks
 * whether the live Turso schema actually has what each migration is
 * supposed to add, and compares that against whether _prisma_migrations
 * has a row for it. Flags any mismatch explicitly (the false-positive
 * shape from the Phase 19 incident documented in
 * scripts/backfill-migration-history.ts).
 *
 * Read-only: only PRAGMA table_info and SELECT statements are run. No
 * INSERT/UPDATE/DELETE/CREATE/ALTER, and no file in prisma/ is touched.
 *
 * Usage: npx tsx scripts/check-migration-status.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

type Check = {
  migrationName: string;
  describe: string;
  check: (client: ReturnType<typeof createClient>) => Promise<boolean>;
};

const CHECKS: Check[] = [
  {
    migrationName: "20260911104341_add_transaction_transfer_group_id",
    describe: `"Transaction" table has a "transferGroupId" column`,
    check: async (client) => {
      const result = await client.execute(`PRAGMA table_info("Transaction")`);
      return result.rows.some((r) => r.name === "transferGroupId");
    },
  },
  {
    migrationName: "20260912134216_add_goal_savings_account",
    describe: `"Goal" table has a "savingsAccountId" column`,
    check: async (client) => {
      const result = await client.execute(`PRAGMA table_info("Goal")`);
      return result.rows.some((r) => r.name === "savingsAccountId");
    },
  },
  {
    migrationName: "20260917211853_add_savings_strategy",
    describe: `"SavingsStrategy" table exists`,
    check: async (client) => {
      const result = await client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='SavingsStrategy'`
      );
      return result.rows.length > 0;
    },
  },
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");
  const client = createClient({ url, authToken });

  const names = CHECKS.map((c) => c.migrationName);
  const bookkeepingRows = await client.execute({
    sql: `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name IN (${names
      .map(() => "?")
      .join(",")})`,
    args: names,
  });
  const bookkeepingPresent = new Set(bookkeepingRows.rows.map((r) => r.migration_name as string));

  console.log("Migration status report (read-only, live Turso DB)\n");

  let anyMismatch = false;

  for (const c of CHECKS) {
    const schemaActuallyApplied = await c.check(client);
    const bookkeepingClaims = bookkeepingPresent.has(c.migrationName);
    const mismatch = schemaActuallyApplied !== bookkeepingClaims;
    if (mismatch) anyMismatch = true;

    console.log(`${c.migrationName}`);
    console.log(`  Schema check:       ${c.describe} -> ${schemaActuallyApplied ? "YES" : "NO"}`);
    console.log(
      `  _prisma_migrations: row present -> ${bookkeepingClaims ? "YES" : "NO"}`
    );
    if (mismatch) {
      if (bookkeepingClaims && !schemaActuallyApplied) {
        console.log(
          `  MISMATCH: bookkeeping claims this migration was applied, but the schema does NOT reflect it. False-positive risk (Phase 19 shape).`
        );
      } else {
        console.log(
          `  MISMATCH: schema reflects this migration, but _prisma_migrations has no row for it (bookkeeping is behind reality).`
        );
      }
    } else {
      console.log(`  OK: schema and bookkeeping agree.`);
    }
    console.log("");
  }

  console.log(
    anyMismatch
      ? "Result: at least one mismatch found between schema reality and _prisma_migrations bookkeeping. See above."
      : "Result: no mismatches found - schema reality and _prisma_migrations bookkeeping agree for all three migrations."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
