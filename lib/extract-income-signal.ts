import { normalizeText } from "@/lib/normalize";

// Deterministic, keyword-based income signal detector - the terminal-failure
// fallback for a "ثبت سریع" (quick submit) transaction whose background AI
// enrichment permanently failed (see markEnrichmentFailed in
// lib/data/transactions.ts). Quick-submit always guesses type: "expense"
// (see add-transaction-form.tsx's handleQuickSubmit) since amount/date are
// the only things extractable deterministically - normally the AI-parse
// workflow corrects a real income transaction's type once it runs, but if
// that never happens (retries exhausted, or skipped outright by the
// per-user rate limit), leaving type: "expense" standing forever silently
// corrupts every downstream balance calculation (getTotalBalance in
// lib/data/accounts.ts sums by `type` unconditionally). This function is the
// last-resort correction for the clearest cases only - same "imperfect but
// better than a guaranteed-wrong default" spirit as extractAmount/
// extractDate's own deterministic-fast-path role, not an attempt at real
// classification (that's parseTransactionWithAI's job, and it already ran
// and failed by the time this is ever consulted).
//
// Deliberately does NOT include the bare word "واریز" on its own, even
// though it's the single most common everyday word for "a deposit" - it's
// genuinely ambiguous in first-person Persian usage:
//   - "حقوقم واریز شد" ("my salary was deposited") -> income
//   - "۵۰۰ به علی واریز کردم" ("I deposited/sent 500 to Ali") -> expense
// The passive "واریز شد" and the active "واریز کردم" read as opposite
// directions of money movement, and telling them apart reliably needs real
// parsing, not a keyword list - so bare "واریز" is left out entirely rather
// than risk flipping a real expense into income, which would be exactly as
// harmful as the bug this function exists to mitigate. "واریزی" (the noun,
// "an incoming deposit/payment") doesn't have that ambiguity and is
// included below instead.
const INCOME_KEYWORDS = [
  "حقوق", // salary
  "دستمزد", // wage
  "درآمد", // income
  "دریافتی", // "amount received" (noun - not the ambiguous verb "دریافت کردم")
  "واریزی", // "an incoming deposit" (noun, unlike the ambiguous verb "واریز")
  "پورسانت", // commission
  "عیدی", // Eid/year-end bonus
  "پاداش", // bonus/reward
  "استرداد", // refund
];

/**
 * True when `rawInput` contains at least one strong, low-ambiguity income
 * keyword. Token-based (exact word match against normalizeText's output),
 * not a raw substring search - avoids a false match against an unrelated
 * word that merely contains one of these as a substring.
 */
export function hasStrongIncomeSignal(rawInput: string): boolean {
  const tokens = normalizeText(rawInput).split(" ");
  return INCOME_KEYWORDS.some((keyword) => tokens.includes(keyword));
}
