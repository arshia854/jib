// One-off refresh: replaces every user's own Category rows with a fresh
// copy of the current DefaultCategory tree (the 23-top-level/59-subcategory
// tree already applied to DefaultCategory itself - see
// docs/roadmap-status.md's "Default Category Tree — Applied to Live Turso"
// entry, 2026-09-04). That entry deliberately left every existing user's
// own Category rows untouched (still the old 9/15 tree), which is why the
// AI's parse-transaction categorization was finding no match for things
// like "ترمیم ناخن" against a stale per-user list and proposing a
// duplicate new category instead of matching the now-existing «خدمات شخصی
// و زیبایی» / «آرایشگاه و سالن زیبایی».
//
// Investigation (see docs/roadmap-status.md's entry for this session) found
// 29 Transaction rows + 3 MerchantMapping rows across 7 users still
// reference their own old Category rows - both FKs are onDelete: Restrict
// (prisma/schema.prisma), confirmed DB-enforced live (PRAGMA foreign_keys =
// 1), so a full per-user replace fails outright unless those rows are
// cleared first. Per explicit user decision (all current User rows are
// internal test/disposable accounts, confirmed in conversation - 2 of the 7
// affected users are literal automated-test leftovers, e.g. Category rows
// named "دسته مالکیت الف"/"دسته تست منبع"): wipe every Transaction,
// MerchantMapping, and SpendingSummaryCache row (the last has no FK to
// Category but would otherwise cache a spending-by-category breakdown for
// transactions that no longer exist), then delete every Category row and
// reseed everyone fresh via lib/data/onboarding.ts's
// seedDefaultCategoriesForUser() - the exact function a brand-new signup
// already goes through, reused unmodified rather than duplicating its logic.
//
// Connects the same way lib/prisma.ts does at runtime (TURSO_DATABASE_URL /
// TURSO_AUTH_TOKEN), same pattern as prisma/backfill-categories.ts - there
// is no separate dev DB (see AGENTS.md).
//
// Resumable by design: the reseed phase only calls
// seedDefaultCategoriesForUser() for a user whose Category count is
// currently 0 (same guard prisma/backfill-categories.ts already uses for
// the same function), so re-running after an interruption can never
// duplicate rows - Category's own @@unique([userId, name, type]) would
// reject a second seed for an already-seeded user loudly rather than
// silently doubling up. Every delete step is similarly safe to repeat
// (deleting an already-empty set is a no-op).
//
// Defaults to a dry run (report only, zero writes) - pass --execute to
// actually wipe + reseed. Before any write, dumps the exact Category /
// Transaction / MerchantMapping / SpendingSummaryCache rows about to be
// deleted to a local timestamped JSON file (see BACKUP_DIR below) as a
// restorable safety net - scripts/backup-live-db.ts (the repo's general
// logical-export tool) currently self-aborts on this schema (its
// EXPECTED_TABLES list predates the Conversation/Asset/LivePriceCache
// tables), so this script takes its own narrow snapshot of just the rows
// it's about to touch instead of relying on it.
//
// Requires --conditions=react-server: lib/data/onboarding.ts (imported
// below) starts with `import "server-only"`, which only no-ops under
// Next's own webpack/Turbopack build (a "react-server" export condition
// set on the server compiler graph) - plain Node/tsx resolution instead
// falls through to that package's default export, which unconditionally
// throws "This module cannot be imported from a Client Component module".
// Same root cause vitest.config.ts already documents and works around (via
// a module alias, not available to a plain script) - here, Node's own
// --conditions flag satisfies the same export condition directly.
//
// Usage:
//   npx tsx --conditions=react-server prisma/refresh-user-categories.ts             # dry run: report only
//   npx tsx --conditions=react-server prisma/refresh-user-categories.ts --execute    # apply: wipe + reseed
import "dotenv/config";
// Must precede the "@/lib/data/onboarding" import below - see that file's
// own header comment for why (raises the interactive-transaction timeout
// seedDefaultCategoriesForUser's own $transaction() call relies on, via
// lib/prisma.ts's existing global-singleton reuse hook).
import "./_long-timeout-prisma-setup";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { seedDefaultCategoriesForUser } from "@/lib/data/onboarding";
import { DEFAULT_CATEGORIES } from "./default-categories";

const BACKUP_DIR = "/home/abt/jib-db-backups";

// A fully-reseeded user always has exactly this many Category rows (23
// top-level + each one's children) - computed from the real tree, not
// hardcoded, so this can't silently drift if DEFAULT_CATEGORIES changes.
// Used below to make the delete phase skip users a *previous, interrupted*
// run of this same script already finished reseeding, instead of
// unconditionally deleting-then-recreating every user's rows on every
// re-run (safe either way - reseeding is deterministic - but wasteful, and
// it needlessly re-exposes already-correct users to the same intermittent
// libsql "idle stream" failure documented below).
const EXPECTED_TREE_SIZE = DEFAULT_CATEGORIES.reduce((sum, top) => sum + 1 + (top.children?.length ?? 0), 0);

async function dumpBackupSnapshot(): Promise<string> {
  const [categories, transactions, merchantMappings, spendingSummaryCache] = await Promise.all([
    prisma.category.findMany(),
    prisma.transaction.findMany(),
    prisma.merchantMapping.findMany(),
    prisma.spendingSummaryCache.findMany(),
  ]);
  const outPath = join(BACKUP_DIR, `pre-category-refresh-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ categories, transactions, merchantMappings, spendingSummaryCache }, null, 2), "utf8");
  return outPath;
}

async function main() {
  const execute = process.argv.includes("--execute");

  const users = await prisma.user.findMany({ select: { id: true, email: true, phoneNumber: true } });

  let totalCategories = 0;
  let totalTransactions = 0;
  let totalMerchantMappings = 0;
  const perUser: Array<{
    id: number;
    label: string;
    categories: number;
    transactions: number;
    merchantMappings: number;
  }> = [];

  for (const user of users) {
    const label = user.email ?? user.phoneNumber ?? `#${user.id}`;
    const [categoryCount, transactionCount, merchantMappingCount] = await Promise.all([
      prisma.category.count({ where: { userId: user.id } }),
      prisma.transaction.count({ where: { userId: user.id } }),
      prisma.merchantMapping.count({ where: { userId: user.id } }),
    ]);
    totalCategories += categoryCount;
    totalTransactions += transactionCount;
    totalMerchantMappings += merchantMappingCount;
    perUser.push({
      id: user.id,
      label,
      categories: categoryCount,
      transactions: transactionCount,
      merchantMappings: merchantMappingCount,
    });
  }
  const cacheCount = await prisma.spendingSummaryCache.count();

  console.log(`${execute ? "EXECUTING" : "DRY RUN"} — ${users.length} user(s).\n`);
  for (const u of perUser) {
    if (u.categories === 0 && u.transactions === 0 && u.merchantMappings === 0) continue;
    console.log(
      `  user ${u.id} (${u.label}): ${u.categories} categories, ${u.transactions} transactions, ${u.merchantMappings} merchant mappings`
    );
  }
  // A user already sitting at exactly EXPECTED_TREE_SIZE categories was
  // fully reseeded by a previous (possibly interrupted) run of this same
  // script - see EXPECTED_TREE_SIZE's own comment. Excluded from the
  // delete phase below rather than re-wiped-and-recreated.
  const alreadyFreshUserIds = perUser.filter((u) => u.categories === EXPECTED_TREE_SIZE).map((u) => u.id);
  const categoriesToWipe = totalCategories - alreadyFreshUserIds.length * EXPECTED_TREE_SIZE;

  console.log(
    `\nTotals to be wiped: ${categoriesToWipe} categories, ${totalTransactions} transactions, ` +
      `${totalMerchantMappings} merchant mappings, ${cacheCount} spending-summary-cache rows.` +
      (alreadyFreshUserIds.length
        ? ` (${alreadyFreshUserIds.length} user(s) already fully reseeded by a prior run - left untouched.)`
        : "")
  );

  if (!execute) {
    console.log("\nDry run only — no writes made. Re-run with --execute to wipe + reseed.");
    return;
  }

  const backupPath = await dumpBackupSnapshot();
  console.log(`\nBackup snapshot written to: ${backupPath}`);

  const deletedTransactions = await prisma.transaction.deleteMany({});
  const deletedMappings = await prisma.merchantMapping.deleteMany({});
  const deletedCache = await prisma.spendingSummaryCache.deleteMany({});
  console.log(
    `\nDeleted ${deletedTransactions.count} transactions, ${deletedMappings.count} merchant mappings, ` +
      `${deletedCache.count} spending-summary-cache rows.`
  );

  // Bottom-up: children (parentId set) first, then top-level - Category's
  // own self-relation is onDelete: Restrict too (prisma/schema.prisma), so
  // a parent row can't be deleted while a child still points to it. Both
  // exclude alreadyFreshUserIds - see that variable's own comment.
  const deletedChildren = await prisma.category.deleteMany({
    where: { parentId: { not: null }, userId: { notIn: alreadyFreshUserIds } },
  });
  const deletedTopLevel = await prisma.category.deleteMany({
    where: { parentId: null, userId: { notIn: alreadyFreshUserIds } },
  });
  console.log(`Deleted ${deletedChildren.count} child categories, ${deletedTopLevel.count} top-level categories.`);

  console.log(`\nReseeding ${users.length} user(s) from DefaultCategory...`);
  // Retries per user: seedDefaultCategoriesForUser's own ~40-round-trip
  // $transaction() has been observed to intermittently hit a *server-side*
  // libsql/Turso idle-stream timeout ("interactive transaction was rolled
  // back because the stream was idle for too long") - separate from, and
  // not fixed by, the client-side transactionOptions.timeout raised in
  // ./_long-timeout-prisma-setup. Confirmed safe to retry: every observed
  // failure (this one and the earlier client-side-timeout one) left the
  // affected user at exactly 0 categories, never a partial count - the
  // server rolls the transaction back cleanly either way.
  const MAX_ATTEMPTS = 5;
  let seeded = 0;
  const stillFailed: number[] = [];
  for (const user of users) {
    // Only seed a user whose Category count is currently 0 - see this
    // file's own header comment on why (resumability if this script is
    // interrupted and re-run).
    const currentCount = await prisma.category.count({ where: { userId: user.id } });
    if (currentCount !== 0) continue;

    let succeeded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await seedDefaultCategoriesForUser(user.id);
        succeeded = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        console.log(`  user ${user.id}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${message}) - retrying...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    if (succeeded) {
      seeded++;
    } else {
      stillFailed.push(user.id);
      console.error(`  user ${user.id}: FAILED after ${MAX_ATTEMPTS} attempts - left at 0 categories.`);
    }
  }
  console.log(
    `Seeded ${seeded} user(s) this run. ${stillFailed.length} user(s) still failed after retries: ` +
      `${stillFailed.length ? stillFailed.join(", ") : "none"}.`
  );

  console.log(`\nVerification:`);
  const finalCategoryCount = await prisma.category.count();
  const finalTransactionCount = await prisma.transaction.count();
  const finalMappingCount = await prisma.merchantMapping.count();
  const finalCacheCount = await prisma.spendingSummaryCache.count();
  console.log(`  Category rows now: ${finalCategoryCount}`);
  console.log(`  Transaction rows now: ${finalTransactionCount} (expected 0)`);
  console.log(`  MerchantMapping rows now: ${finalMappingCount} (expected 0)`);
  console.log(`  SpendingSummaryCache rows now: ${finalCacheCount} (expected 0)`);

  for (const user of users) {
    const count = await prisma.category.count({ where: { userId: user.id } });
    console.log(`    user ${user.id}: ${count} categories`);
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
