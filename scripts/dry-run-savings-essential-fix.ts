/**
 * READ-ONLY dry run: counts what would change on live Turso if the
 * savings/investment isEssential fix (prisma/default-categories.ts -
 * "پس‌انداز و سرمایه‌گذاری" and its 3 children now isEssential: true,
 * were false) were applied to the live DB.
 *
 * Performs SELECT-only queries via @libsql/client (same connection path
 * lib/prisma.ts uses at runtime, same pattern as
 * scripts/backfill-migration-history.ts). Makes NO writes and does not
 * touch DefaultCategory, seed.ts, or backfill-category-essentiality.ts.
 *
 * Usage:
 *   npx tsx scripts/dry-run-savings-essential-fix.ts
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const TARGET_NAMES = [
  "پس‌انداز و سرمایه‌گذاری",
  "واریز به حساب پس‌انداز",
  "خرید طلا و ارز",
  "صندوق سرمایه‌گذاری و بورس",
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");
  const client = createClient({ url, authToken });

  console.log("=== 1. DefaultCategory rows (name, type='expense') ===\n");
  for (const name of TARGET_NAMES) {
    const res = await client.execute({
      sql: `SELECT name, type, isEssential FROM "DefaultCategory" WHERE name = ? AND type = 'expense'`,
      args: [name],
    });
    if (res.rows.length === 0) {
      console.log(`${name}: NOT FOUND (name, type='expense')`);
      continue;
    }
    for (const row of res.rows) {
      const current = Number(row.isEssential);
      const differs = current !== 1;
      console.log(
        `${name}: isEssential=${current} (${current === 1 ? "true" : "false"}) - ${differs ? "WOULD CHANGE to true" : "already true, no-op"}`
      );
    }
  }

  console.log("\n=== 2. Category rows (per-user) grouped by name ===\n");
  let totalWouldFlip = 0;
  let totalAlreadyTrue = 0;
  for (const name of TARGET_NAMES) {
    const res = await client.execute({
      sql: `SELECT
              SUM(CASE WHEN isEssential = 0 THEN 1 ELSE 0 END) AS would_flip,
              SUM(CASE WHEN isEssential = 1 THEN 1 ELSE 0 END) AS already_true
            FROM "Category"
            WHERE name = ?`,
      args: [name],
    });
    const row = res.rows[0];
    const wouldFlip = Number(row?.would_flip ?? 0);
    const alreadyTrue = Number(row?.already_true ?? 0);
    totalWouldFlip += wouldFlip;
    totalAlreadyTrue += alreadyTrue;
    console.log(`${name}: would flip (isEssential 0->1) = ${wouldFlip}, already true (no-op) = ${alreadyTrue}`);
  }
  console.log(`\nTOTAL across all 4 categories: would flip = ${totalWouldFlip}, already true (no-op) = ${totalAlreadyTrue}`);

  console.log("\n=== 3. Distinct users affected (>=1 of the 4 categories currently isEssential=false) ===\n");
  const placeholders = TARGET_NAMES.map(() => "?").join(",");
  const usersRes = await client.execute({
    sql: `SELECT COUNT(DISTINCT userId) AS affected_users
          FROM "Category"
          WHERE name IN (${placeholders}) AND isEssential = 0`,
    args: TARGET_NAMES,
  });
  console.log(`Distinct users affected: ${Number(usersRes.rows[0]?.affected_users ?? 0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
