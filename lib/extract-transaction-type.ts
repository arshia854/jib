import { normalizeText } from "@/lib/normalize";

// Keywords that declare a transaction as income in casual, free-form
// Persian expense-tracking text, whichever way the rest of the sentence is
// worded ("حقوق ۳۰ میلیون", "حقوقمو گرفتم", "دریافتی این ماه" - all read as
// money coming in, never as the user paying someone).
//
// "واریز" (deposit / transfer) is deliberately NOT here, and must not be
// added, nor borrowed from lib/bank/extract-bank-type.ts's list. That file
// can safely treat "واریز" as income only because it only ever sees a real
// bank SMS, where the bank's own message format guarantees the money moved
// INTO the user's account. In text the user types themselves, "واریز" is
// directionally ambiguous - "۵۰۰ هزار به علی واریز کردم" (I paid Ali) is an
// expense, "حقوقم واریز شد" (my salary arrived) is income - and telling the
// two apart takes real parsing, not a keyword list. (A phrase like "واریزی
// حقوق" is still caught, but by "حقوق", not by "واریزی".)
//
// Keep this list conservative. The two ways to be wrong are not equal:
//   - a false "income" silently corrupts monthIncome and the budget figures
//     built on it, and stays wrong until background AI enrichment happens to
//     fix it (and anything that reads `type` at save time, such as the
//     dashboard's income-reaction banner, has already acted on it);
//   - a false negative just means the transaction is saved as "expense" like
//     every quick-submit was before this function existed, and enrichment
//     corrects it as it always did - no worse than today.
// So a keyword only belongs here if it reads as income in essentially every
// sentence it can appear in. When in doubt, leave it out.
const INCOME_KEYWORDS = [
  "حقوق", // salary
  "درآمد", // income
  "دریافتی", // "amount received" (noun)
];

// Returns true iff the text contains at least one INCOME_KEYWORDS entry as a
// whole word. This is a one-directional override, not a classifier: there is
// deliberately no expense keyword list, because "expense" is already the
// default buildQuickParsedTransaction (components/transactions/
// add-transaction-form.tsx) falls back to, so the only thing it ever needs
// from here is a reason to change that default to "income". false means
// "no evidence of income" - not "this is an expense".
//
// Matches whole normalizeText tokens, not raw substrings - unlike
// extractBankType, which can substring-match because a bank SMS's own
// vocabulary is closed. Free text isn't: "حقوق" is a substring of "حقوقی"
// (legal), so "وکیل حقوقی ۵ میلیون" - a lawyer's fee, an expense - would flip
// to income under a substring match. The cost is a miss on glued forms like
// "حقوقم" (my salary), which lands on the safe side of the asymmetry above.
//
// Uses lib/normalize.ts's normalizeText (punctuation and half-spaces become
// spaces), not lib/bank/normalize.ts's - so "حقوق." and "حقوق،" still
// tokenize to "حقوق". Kept in sync with the same-named choice in
// lib/extract-amount.ts, whose input this is always paired with.
export function extractIncomeSignal(rawText: string): boolean {
  const tokens = normalizeText(rawText).split(" ");
  return INCOME_KEYWORDS.some((keyword) => tokens.includes(keyword));
}
