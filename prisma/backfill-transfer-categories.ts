// One-off backfill for existing users' Category rows after the two new
// "انتقال بین حساب‌ها" (isTransfer: true, one expense + one income - see
// prisma/default-categories.ts) system categories were added to
// DefaultCategory. Unlike prisma/backfill-categories.ts (which only
// touches users with zero Category rows) or prisma/refresh-user-
// categories.ts (which wipes and reseeds a user's *entire* Category tree),
// this script leaves every existing Category row untouched and only
// inserts the two specific rows a user is missing - the shape needed here,
// since every already-onboarded user already has a full, otherwise-correct
// Category tree and doesn't need (or want) the rest of it touched.
//
// Requires the two DefaultCategory rows (name="انتقال بین حساب‌ها",
// type="expense"/"income", isTransfer=true) to already exist - i.e. this
// only makes sense to run *after* prisma/seed.ts (or the live-DB
// equivalent) has created them. Aborts loudly with no writes if either is
// missing, rather than guessing at icon/color/isEssential values.
//
// Idempotent: matches on Category's own @@unique([userId, name, type]) key
// before inserting, so re-running only ever inserts what's still missing -
// a user who already has both rows (from a previous run, or from a
// brand-new onboarding that already picked them up via
// seedDefaultCategoriesForUser) is skipped entirely, logged as 0 inserted.
//
// Defaults to a dry run (report only, zero writes) - pass --execute to
// actually insert. Per AGENTS.md, running this against the live Turso DB
// (in either mode) needs explicit go-ahead in conversation first.
//
// Usage:
//   npx tsx prisma/backfill-transfer-categories.ts             # dry run: report only
//   npx tsx prisma/backfill-transfer-categories.ts --execute    # apply: insert missing rows
import "dotenv/config";
import { prisma } from "@/lib/prisma";

const TRANSFER_CATEGORY_NAME = "انتقال بین حساب‌ها";

async function main() {
  const execute = process.argv.includes("--execute");

  const transferDefaults = await prisma.defaultCategory.findMany({
    where: { name: TRANSFER_CATEGORY_NAME, isTransfer: true },
    select: { name: true, type: true, icon: true, color: true, isEssential: true, isTransfer: true },
  });
  const expenseDefault = transferDefaults.find((c) => c.type === "expense");
  const incomeDefault = transferDefaults.find((c) => c.type === "income");
  if (!expenseDefault || !incomeDefault) {
    console.error(
      `Expected both an expense and an income DefaultCategory row named "${TRANSFER_CATEGORY_NAME}" ` +
        `with isTransfer=true - found ${transferDefaults.length}. Seed DefaultCategory first (prisma/seed.ts ` +
        `or its live-DB equivalent) before running this backfill.`
    );
    process.exitCode = 1;
    return;
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true, phoneNumber: true } });

  console.log(`${execute ? "EXECUTING" : "DRY RUN"} — ${users.length} user(s).\n`);

  let totalInserted = 0;
  let usersFullyMissing = 0;
  let usersPartiallyMissing = 0;
  let usersAlreadyComplete = 0;

  for (const user of users) {
    const existing = await prisma.category.findMany({
      where: { userId: user.id, name: TRANSFER_CATEGORY_NAME, type: { in: ["expense", "income"] } },
      select: { type: true },
    });
    const existingTypes = new Set(existing.map((c) => c.type));

    const toInsert: typeof transferDefaults = [];
    if (!existingTypes.has("expense")) toInsert.push(expenseDefault);
    if (!existingTypes.has("income")) toInsert.push(incomeDefault);

    if (toInsert.length === 0) {
      usersAlreadyComplete++;
      continue;
    }
    if (toInsert.length === 2) {
      usersFullyMissing++;
    } else {
      usersPartiallyMissing++;
    }

    const label = user.email ?? user.phoneNumber ?? `#${user.id}`;
    if (execute) {
      await prisma.category.createMany({
        data: toInsert.map((c) => ({
          name: c.name,
          icon: c.icon,
          color: c.color,
          type: c.type,
          isEssential: c.isEssential,
          isTransfer: c.isTransfer,
          userId: user.id,
        })),
      });
    }
    totalInserted += toInsert.length;
    console.log(
      `  user ${user.id} (${label}): ${execute ? "inserted" : "would insert"} ${toInsert.length} row(s) ` +
        `(${toInsert.map((c) => c.type).join(", ")})`
    );
  }

  console.log(
    `\n${execute ? "Inserted" : "Would insert"} ${totalInserted} row(s) across ${users.length} user(s). ` +
      `${usersFullyMissing} user(s) missing both, ${usersPartiallyMissing} missing one, ` +
      `${usersAlreadyComplete} already complete (skipped).`
  );
  if (!execute) {
    console.log("\nDry run only — no writes made. Re-run with --execute to apply.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
