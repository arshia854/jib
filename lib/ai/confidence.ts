// Phase 8 (docs/roadmap-status.md) confidence model.
//
// Named levels only - "high" | "medium" | "low" - never a numeric
// probability. No calibration data exists for this app (no labeled
// accuracy dataset, no user-feedback loop on category correctness), so a
// number like "0.73" would imply a precision this codebase cannot actually
// back up. The AI's own self-reported 0-1 `confidence` value (see
// resolveAiCategory in lib/ai/parse-transaction.ts) is model-reported, not
// calibrated either - it's kept as-is (unchanged, per "extend the existing
// shape, don't replace it"), but nothing here derives a new number from it
// beyond the three existing threshold buckets that already gate
// needsConfirmation today.
//
// Two concerns, kept explicitly separate (per the Phase 8 spec):
//   - extraction confidence: how sure the parser is about amount/date
//     themselves, independent of category.
//   - categorization confidence: how sure the categorizer is about the
//     assigned category, independent of amount/date.
// combineConfidence derives a third, overall value from those two with one
// documented, testable rule - not a weighted formula.
export type ConfidenceLevel = "high" | "medium" | "low";

const LEVEL_RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

// Overall confidence = the weaker of the two halves. A transaction whose
// amount is rock-solid but whose category is a low-confidence guess is
// still, overall, a low-confidence transaction - and vice versa. This is
// deliberately the simplest possible rule that respects both signals
// (Phase 8.1: "the minimum of the two, or another simple, documented,
// testable rule - not a magic weighted formula").
export function combineConfidence(extraction: ConfidenceLevel, categorization: ConfidenceLevel): ConfidenceLevel {
  return LEVEL_RANK[extraction] <= LEVEL_RANK[categorization] ? extraction : categorization;
}

// Bank-SMS extraction: amount/type are always the same deterministic regex
// pipeline (lib/bank/extract-bank-amount.ts / extract-bank-type.ts)
// regardless of how confidently the *bank itself* was identified - but
// bankConfidence < 1 means only some of that bank's own detection rules
// matched (see lib/bank/detect-bank.ts), which is a real, if secondary,
// signal that this message's structure wasn't a perfect fit for the
// pattern set it matched against. Capped at "medium" rather than treated
// as "low": parseBankSms already refuses anything below
// MIN_CONFIDENCE_SCORE (50%) outright (see detect-bank.ts), so anything
// that reaches this function already cleared that floor.
export function extractionConfidenceForBankSms(bankConfidence: number): ConfidenceLevel {
  return bankConfidence >= 1 ? "high" : "medium";
}

// The merchant fast path (no AI call at all) only ever returns once
// extractAmount()/extractDate() have both resolved non-null - i.e. the
// same deterministic, all-or-nothing extraction guarantee as the bank
// engine, just via a different pair of extractors. Always high.
export const EXTRACTION_CONFIDENCE_DETERMINISTIC: ConfidenceLevel = "high";

// Any branch that reached the real NVIDIA NIM call for amount/date
// extraction (parsed.amount/parsed.date come straight from the model's own
// JSON, not a regex) is capped at "medium" - never "high", since there is
// no deterministic guarantee behind it, and never "low" either, since the
// response already passed isRawParsedTransaction's shape validation
// (amount is a finite positive number, a parseable date). NVIDIA NIM's
// response carries no logprob/self-reported extraction-confidence field to
// draw a finer signal from (checked - chatCompletion's return type is a
// plain string; see lib/nvidia-ai.ts), so "the AI was needed for
// extraction at all" is itself treated as the lower-confidence signal, per
// the Phase 8 spec's own instruction not to fabricate one.
export const EXTRACTION_CONFIDENCE_AI: ConfidenceLevel = "medium";

// The bank engine has no merchant name or category signal whatsoever (see
// buildBankSmsResult's own comment in lib/ai/parse-transaction.ts) - every
// unmatched bank-SMS result lands on the generic fallback category with
// needsConfirmation always true. There is no weaker categorization signal
// in this codebase than "no signal existed at all."
export const CATEGORIZATION_CONFIDENCE_NONE: ConfidenceLevel = "low";

// A merchant-match category, from either the global default list or a
// user's own learned mapping (lib/merchant-lookup.ts). matchTier is
// findBestMatch's own 1 (exact) / 2 (alias / contiguous token sequence) /
// 3 (loose substring) result - undefined only for a "keyword"-source
// result, which bypasses findBestMatch entirely (see matchTier's own doc
// comment on MerchantLookupResult).
//   - userMapping: always high, regardless of tier. This is the one
//     signal in this codebase that reflects a real decision by this
//     specific person about this specific merchant text, not a curated
//     global default - Phase 8.1 names "user historical match" as its own
//     high-confidence signal for exactly this reason.
//   - keyword: always high. A keyword override (lib/merchants.ts) is a
//     deliberately narrow, hand-curated trigger phrase, not a fuzzy
//     match - treated the same as an exact hit, not an alias one.
//   - globalMerchant, tier 1 (exact): high.
//   - globalMerchant, tier 2/3 (alias / substring): medium. Phase 8.1
//     names these as two separate signals in its own list, but only
//     defines three levels total - both land in the one bucket beneath
//     "exact match", since neither is a curated/personal signal the way
//     userMapping/keyword are.
export function categorizationConfidenceForMerchantMatch(
  source: "userMapping" | "globalMerchant" | "keyword",
  matchTier: 1 | 2 | 3 | undefined
): ConfidenceLevel {
  if (source === "userMapping" || source === "keyword") return "high";
  return matchTier === 1 ? "high" : "medium";
}
