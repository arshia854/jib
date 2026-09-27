// One-off backfill: flags Category.isArchived / DefaultCategory.isArchived
// (migration 20260925093410_add_category_is_archived) on every existing row
// whose name is in RETIRED_CATEGORY_NAMES below - the list lib/categories.ts
// used to filter by name at each read site (DEPRECATED_CATEGORY_NAMES)
// before the flag existed. Once this has run, the name list has no other
// reader: every read path (lib/ai/parse-transaction.ts, lib/data/onboarding.ts,
// lib/data/categories.ts's suggestion dedup, the add-transaction pickers)
// filters on the flag instead.
//
// Nothing is deleted or re-pointed: Transaction/MerchantMapping rows keep
// referencing the same Category ids (both FKs are onDelete: Restrict), so
// history keeps displaying the real name. The only write is flipping a
// boolean, and the dry run prints every id it would flip - reversing it is
// the same update with isArchived: false on those ids.
//
// PRE-REQUISITE: the migration above must already be applied to the target
// DB (see AGENTS.md's "Applying a new schema change"). main() checks for the
// column first and aborts with a clear message rather than a raw
// "no such column" Prisma error.
//
// ORDERING: run this (--execute) after the migration is applied but BEFORE
// deploying the code that reads isArchived. Old code ignores the column, so
// flagging early is invisible to it; deploying first would instead briefly
// put the retired category back into the AI prompt for every existing user,
// since the old name-based filter is gone from the new code.
//
// Idempotent: only rows still at isArchived = false are counted/updated, so
// a re-run after a successful one reports 0 and writes nothing.
//
// Connects the same way lib/prisma.ts does at runtime (TURSO_DATABASE_URL /
// TURSO_AUTH_TOKEN), same as prisma/backfill-categories.ts and
// prisma/refresh-user-categories.ts - there is no separate dev DB (see
// AGENTS.md). Doesn't import any "server-only" module, so no
// --conditions=react-server flag is needed (unlike refresh-user-categories.ts).
//
// Usage:
//   npx tsx prisma/archive-retired-categories.ts             # dry run: report only
//   npx tsx prisma/archive-retired-categories.ts --execute   # apply
import "dotenv/config";
import { prisma } from "@/lib/prisma";

// Expense-only: the one retired entry is a child of «پس‌انداز و سرمایه‌گذاری»
// (removed from prisma/default-categories.ts because it overlapped the
// /app/transfer flow). Matched on (name, type), the same pair Category's
// own @@unique([userId, name, type]) keys on.
const RETIRED_CATEGORY_NAMES: ReadonlyArray<{ name: string; type: "income" | "expense" }> = [
  { name: "واریز به حساب پس‌انداز", type: "expense" },
];

async function assertColumnExists(table: "Category" | "DefaultCategory") {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM pragma_table_info('${table}') WHERE name = 'isArchived'`
  );
  if (rows.length === 0) {
    throw new Error(
      `${table}.isArchived does not exist on this DB - apply prisma/migrations/20260925093410_add_category_is_archived first (AGENTS.md).`
    );
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  await assertColumnExists("Category");
  await assertColumnExists("DefaultCategory");

  const retiredFilter = { OR: RETIRED_CATEGORY_NAMES.map(({ name, type }) => ({ name, type })) };

  const [categories, defaultCategories] = await Promise.all([
    prisma.category.findMany({
      where: { ...retiredFilter, isArchived: false },
      select: {
        id: true,
        userId: true,
        name: true,
        type: true,
        _count: { select: { transactions: true, merchantMappings: true } },
      },
      orderBy: { id: "asc" },
    }),
    prisma.defaultCategory.findMany({
      where: { ...retiredFilter, isArchived: false },
      select: { id: true, name: true, type: true },
      orderBy: { id: "asc" },
    }),
  ]);

  console.log(`${execute ? "EXECUTING" : "DRY RUN"} - retired names: ${RETIRED_CATEGORY_NAMES.map((r) => r.name).join(", ")}\n`);

  console.log(`Category rows to archive: ${categories.length}`);
  for (const c of categories) {
    console.log(
      `  id ${c.id} (user ${c.userId}) "${c.name}" [${c.type}] - ` +
        `${c._count.transactions} transaction(s), ${c._count.merchantMappings} merchant mapping(s) keep pointing at it`
    );
  }
  const referencingTransactions = categories.reduce((sum, c) => sum + c._count.transactions, 0);
  const referencingMappings = categories.reduce((sum, c) => sum + c._count.merchantMappings, 0);
  console.log(
    `  total: ${referencingTransactions} transaction(s), ${referencingMappings} merchant mapping(s) reference these rows (unchanged either way)`
  );

  console.log(`\nDefaultCategory rows to archive: ${defaultCategories.length}`);
  for (const d of defaultCategories) {
    console.log(`  id ${d.id} "${d.name}" [${d.type}]`);
  }

  if (!execute) {
    console.log("\nDry run only - no writes made. Re-run with --execute to apply.");
    return;
  }

  // Keyed on the exact ids reported above (not the name filter again), so
  // --execute can never touch a row the printed report didn't list.
  const [categoryResult, defaultResult] = await prisma.$transaction([
    prisma.category.updateMany({
      where: { id: { in: categories.map((c) => c.id) }, isArchived: false },
      data: { isArchived: true },
    }),
    prisma.defaultCategory.updateMany({
      where: { id: { in: defaultCategories.map((d) => d.id) }, isArchived: false },
      data: { isArchived: true },
    }),
  ]);
  console.log(`\nArchived ${categoryResult.count} Category row(s), ${defaultResult.count} DefaultCategory row(s).`);

  const [remaining, remainingDefaults] = await Promise.all([
    prisma.category.count({ where: { ...retiredFilter, isArchived: false } }),
    prisma.defaultCategory.count({ where: { ...retiredFilter, isArchived: false } }),
  ]);
  console.log(`Verification: ${remaining} Category / ${remainingDefaults} DefaultCategory row(s) still unarchived (expected 0 / 0).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
