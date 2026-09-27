/**
 * READ-ONLY audit: finds existing transactions that are likely mistyped as
 * a result of the "ثبت سریع" (quick submit) / background AI enrichment bug
 * (see components/transactions/add-transaction-form.tsx's handleQuickSubmit
 * and lib/workflows/enrich-transaction.ts).
 *
 * Background: quick submit always saves a new transaction with a hardcoded
 * type: "expense" guess (amount/date are the only things it can extract
 * deterministically) and enrichmentStatus: "pending", relying on a
 * background AI-parse workflow to correct type/category shortly after. If
 * that background enrichment never lands - AI retries exhausted, or the
 * per-user rate limit skipped it outright (see the two call sites of
 * markEnrichmentFailed in app/api/transactions/route.ts) - the row is left
 * on enrichmentStatus: "failed" (or, in a rarer/worse case covered below,
 * stuck on "pending" forever) with its wrong "expense" guess never
 * corrected. Since getTotalBalance (lib/data/accounts.ts) sums every
 * transaction's amount signed by `type` unconditionally, a real income
 * transaction stuck as "expense" swings total balance by 2x its amount -
 * this is a real data-integrity bug, not a cosmetic one.
 *
 * markEnrichmentFailed (lib/data/transactions.ts) now applies a narrow
 * deterministic heuristic fallback (lib/extract-income-signal.ts) on any
 * *new* terminal failure going forward - see that function's own comment.
 * This script is the backfill half: it finds pre-existing rows created
 * before that fix landed, which never got any such correction. Deliberately
 * reuses the exact same hasStrongIncomeSignal() heuristic as the forward
 * fix (not a second, possibly-drifting keyword list) so "what the audit
 * flags" and "what the forward fix now corrects automatically" stay in
 * lockstep.
 *
 * Scope, deliberately narrow (see the task this was written for): only
 * type: "expense" transactions whose enrichmentStatus is "failed" or still
 * "pending" - i.e. only rows that never got a real, confidence-bearing
 * classification in the first place. A transaction created through the
 * normal AI-preview-then-confirm flow (enrichmentStatus: null) already had
 * its type either AI-classified with a real confidence signal or reviewed
 * by the user on the preview screen before being saved - flagging those as
 * "likely mistyped" on a bare keyword match would be far noisier and far
 * less justified than flagging a row that got *zero* real classification
 * at all.
 *
 * READ-ONLY / report-only, per this project's live-DB protocol (AGENTS.md,
 * "Applying schema changes to the live database (Turso)" and this task's
 * own instructions): every statement below is a SELECT. Nothing here
 * executes INSERT/UPDATE/DELETE against the live DB, and this script does
 * not propose or perform any automatic correction - it only prints
 * candidates for manual review. Deciding whether/how to correct any of
 * these rows is a separate, explicitly-approved step.
 *
 * Usage:
 *   npx tsx scripts/audit-mistyped-transactions.ts
 *
 * Connects via lib/prisma.ts (the app's own runtime Prisma Client +
 * @prisma/adapter-libsql, using TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) -
 * safe to do directly here (unlike importing anything under lib/data/*.ts)
 * since lib/prisma.ts itself carries no `import "server-only"` guard, only
 * the data-layer modules built on top of it do.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { hasStrongIncomeSignal } from "@/lib/extract-income-signal";

// A "pending" row this old was created by a workflow run that crashed or
// was otherwise lost before ever reaching either applyEnrichment or
// recordFailure (lib/workflows/enrich-transaction.ts) - normal enrichment
// resolves within seconds. Flagged as its own category below (regardless
// of keyword match) since a row stuck here isn't just "possibly mistyped,"
// it never even got the "failed" flag that would otherwise nudge a user to
// check it - a strictly worse state than "failed".
const STUCK_PENDING_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

interface Candidate {
  id: number;
  userId: number;
  amount: number;
  date: Date;
  enrichmentStatus: string;
  rawInput: string;
  description: string | null;
  createdAt: Date;
}

function formatCandidate(t: Candidate): string {
  const ageHours = Math.round((Date.now() - t.createdAt.getTime()) / (60 * 60 * 1000));
  return (
    `  id=${t.id}  userId=${t.userId}  amount=${t.amount}  date=${t.date.toISOString().slice(0, 10)}  ` +
    `status=${t.enrichmentStatus}  createdAt=${t.createdAt.toISOString()} (${ageHours}h ago)\n` +
    `    rawInput: ${JSON.stringify(t.rawInput)}\n` +
    `    description: ${JSON.stringify(t.description)}`
  );
}

async function main() {
  const suspects = await prisma.transaction.findMany({
    where: {
      type: "expense",
      enrichmentStatus: { in: ["failed", "pending"] },
    },
    select: {
      id: true,
      userId: true,
      amount: true,
      date: true,
      enrichmentStatus: true,
      rawInput: true,
      description: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Scanned ${suspects.length} type:"expense" transaction(s) with enrichmentStatus "failed" or "pending".\n`);

  const likelyMistyped = suspects.filter(
    (t): t is Candidate => t.enrichmentStatus !== null && hasStrongIncomeSignal(t.rawInput)
  );
  const stuckPending = suspects.filter(
    (t): t is Candidate =>
      t.enrichmentStatus === "pending" && Date.now() - t.createdAt.getTime() > STUCK_PENDING_THRESHOLD_MS
  );

  console.log(
    `=== Likely mistyped (type: "expense", enrichmentStatus "failed"/"pending", strong income keyword in rawInput) ===`
  );
  console.log(`${likelyMistyped.length} candidate(s) for manual review.\n`);
  for (const t of likelyMistyped) {
    console.log(formatCandidate(t));
  }

  console.log(
    `\n=== Stuck "pending" (>${STUCK_PENDING_THRESHOLD_MS / (60 * 60 * 1000)}h old, enrichment workflow never resolved either way) ===`
  );
  console.log(
    `${stuckPending.length} row(s) - a distinct, separate issue: these never even reached "failed", so they never got the ` +
      `existing UI review-nudge (transaction-row.tsx) either. Listed for awareness, not because their type is necessarily ` +
      `wrong - only because they never received any real classification signal at all.\n`
  );
  for (const t of stuckPending) {
    console.log(formatCandidate(t));
  }

  console.log(`\nNo writes were made. This script only reads from the database.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
