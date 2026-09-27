import "server-only";
import { getMostRecentActiveSavingsStrategy } from "@/lib/data/savings-strategies";
import { sendPushToUser } from "@/lib/notifications/send-push";
import { formatToman } from "@/lib/format";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Minimal, self-contained shape this module needs from a SavingsStrategy row
// - declared separately rather than importing the generated Prisma model
// type, same "keep this module's own types self-contained" precedent as
// lib/data/transactions.ts's AssetPurchaseInput.
export interface SavingsStrategyForSuggestion {
  status: string;
  targetPercent: number | null;
  targetAmount: number | null;
}

/**
 * Suggested Toman amount to save from one real income transaction, given the
 * user's active SavingsStrategy - or null when no suggestion should be made.
 *
 * Deliberately branches on which of targetPercent/targetAmount is actually
 * set on the row, not on formulaType: app/api/savings-strategies/route.ts
 * lets every formulaType store either representation (exactly one is
 * required at creation, see that route's own validation), so the persisted
 * row is already either "percent of income" or "a fixed monthly amount"
 * regardless of which of the 5 formulas produced it. There is no existing
 * per-transaction formula for leftover/roundup/custom specifically (the only
 * prior art, lib/savings/formulas.ts's suggestSavingsAmount, derives a
 * setup-time suggestion from trailing MonthlyFinancialProfile averages, not
 * from a single incoming transaction) - confirmed with the project owner
 * that treating every strategy uniformly by its stored field, rather than
 * inventing distinct math per formula, is the correct behavior here.
 *
 * The fixed-amount branch is capped at incomeAmount - never suggest saving
 * more than was just earned, even if the strategy's own targetAmount (set
 * once, independent of any particular paycheck) is larger.
 */
export function calculateSuggestedSavingsAmount(
  strategy: SavingsStrategyForSuggestion,
  incomeAmount: number
): number | null {
  if (strategy.status !== "active") return null;

  let amount: number;
  if (strategy.targetPercent !== null) {
    amount = Math.round(incomeAmount * (strategy.targetPercent / 100));
  } else if (strategy.targetAmount !== null) {
    amount = Math.min(strategy.targetAmount, incomeAmount);
  } else {
    // Shouldn't happen in practice - the create/update API requires exactly
    // one of the two to be set - but a row with neither has nothing to base
    // a suggestion on.
    return null;
  }

  return amount > 0 ? amount : null;
}

// docs/jib-persona.md's "Savings opportunity" expression bank, rotated
// (Math.random()) rather than always using the same line - per that doc's
// own "rotate expressions ... a repeated catchphrase turns charming into
// annoying by the third occurrence" rule. Each template puts the idiom
// first, then the real income/suggestion amounts in the same sentence (Fact
// → Recommendation - no separate "Insight" here, there's no "why" to
// explain about receiving income), never stacks a second idiom, and has no
// exclamation marks or emoji, matching the persona's لوس/باحال calibration.
const INCOME_SAVINGS_SUGGESTION_BODY_TEMPLATES: ((income: string, suggested: string) => string)[] = [
  (income, suggested) => `یه‌جای خالی برای پس‌انداز پیدا کردم: از ${income} که تازه واریز شد، ${suggested}‌ش رو کنار بذار.`,
  (income, suggested) => `اینجا می‌تونی یه گاز بگیری: ${income} واریز شد، پیشنهاد می‌کنم ${suggested}‌ش رو پس‌انداز کنی.`,
  (income, suggested) => `یه فرصت طلایی اینجا داری: از این ${income} واریزی، ${suggested} رو بذار کنار.`,
];

const INCOME_SAVINGS_SUGGESTION_TITLE = "فرصت پس‌انداز";

function buildIncomeSavingsSuggestionCopy(
  incomeAmount: number,
  suggestedAmount: number
): { title: string; body: string } {
  const template =
    INCOME_SAVINGS_SUGGESTION_BODY_TEMPLATES[
      Math.floor(Math.random() * INCOME_SAVINGS_SUGGESTION_BODY_TEMPLATES.length)
    ];
  return {
    title: INCOME_SAVINGS_SUGGESTION_TITLE,
    body: template(formatToman(incomeAmount), formatToman(suggestedAmount)),
  };
}

/**
 * Income-transaction trigger for the "income_savings_suggestion" push
 * notification (Phase 2's sendPushToUser/NotificationLog plumbing, reused
 * unchanged - see lib/notifications/send-push.ts). Called right after a
 * transaction is created (see app/api/transactions/route.ts's POST) - never
 * from inside createTransaction() itself, same "side effect kicked off at
 * the call site, not inside the data-layer write" precedent as that route's
 * own enrichTransactionWorkflow kickoff for quick-submit transactions.
 *
 * Only reacts to a transaction that is both real income (`type === "income"`)
 * and not one leg of an internal transfer (`transferGroupId === null`) - a
 * transfer's income leg (lib/data/transfers.ts) is money the user already
 * had, not new earnings. In practice every transaction created through
 * createTransaction() already has a null transferGroupId (transfers are
 * created through a separate path, lib/data/transfers.ts, that never calls
 * createTransaction() - see its own comment), so this check is defensive
 * rather than currently reachable - it costs nothing and guards against that
 * ever changing.
 *
 * Silently does nothing (no notification, no error) when: the transaction
 * isn't real income, the user has no active SavingsStrategy right now (see
 * getMostRecentActiveSavingsStrategy - picks the most recently updated one
 * if the user has several), or calculateSuggestedSavingsAmount returns null
 * for it. Any failure past that point (DB read, push send) is reported via
 * reportError and swallowed here - this must never surface as an error to
 * whatever called it, since a notification is a best-effort nicety on top
 * of an already-successful transaction save, not part of that save's own
 * correctness.
 */
export async function notifyIncomeSavingsSuggestion(
  userId: number,
  transaction: { type: string; amount: number; transferGroupId: string | null }
): Promise<void> {
  if (transaction.type !== "income" || transaction.transferGroupId !== null) return;

  try {
    const strategy = await getMostRecentActiveSavingsStrategy(userId);
    if (!strategy) return;

    const suggestedAmount = calculateSuggestedSavingsAmount(strategy, transaction.amount);
    if (suggestedAmount === null) return;

    const { title, body } = buildIncomeSavingsSuggestionCopy(transaction.amount, suggestedAmount);
    await sendPushToUser(userId, { type: "income_savings_suggestion", title, body });
  } catch (error) {
    reportError({
      errorType: ERROR_TYPES.API_ERROR,
      route: "notifications/savings-suggestion",
      userId,
      message: error instanceof Error ? error.message : "Failed to send income savings suggestion notification",
      error,
      context: { operation: "notifyIncomeSavingsSuggestion" },
    });
  }
}
