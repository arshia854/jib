import { SAVINGS_STRATEGY_FORMULA_TYPES, type SavingsStrategyFormulaType } from "@/lib/data/savings-strategies";
import type { MonthlyFinancialProfile } from "@/lib/savings/monthly-profile";

/**
 * A starting-point suggestion for one SavingsStrategy formula, derived from
 * a user's MonthlyFinancialProfile. targetPercent/targetAmount are exactly
 * what a caller would persist via POST /api/savings-strategies if the user
 * accepts the suggestion as-is - that route's own invariant (exactly one of
 * the two non-null) holds here too. suggestedMonthlyAmount is a Toman
 * figure for DISPLAY ONLY next to a percent-based suggestion (e.g. "20% ≈
 * 2,400,000 تومان/ماه") - it is never itself persisted.
 */
export interface SavingsFormulaSuggestion {
  formulaType: SavingsStrategyFormulaType;
  targetPercent: number | null;
  targetAmount: number | null;
  suggestedMonthlyAmount: number | null;
  // false only when the specific average(s) this formula depends on are
  // null (no lookback history yet) - callers use this to show "not enough
  // data yet" instead of a fabricated number, rather than inferring it from
  // targetPercent/targetAmount/suggestedMonthlyAmount being null (roundup's
  // targetAmount is always non-null despite never being data-backed - see
  // ROUNDUP_DEFAULT_MONTHLY_AMOUNT below).
  hasData: boolean;
}

// Rule-of-thumb constants below, same "not derived from this app's own
// calibration data" caveat as UNUSUAL_TRANSACTION_MULTIPLIER
// (lib/analytics/spending-summary.ts) - no calibration data exists for this
// feature yet, these are common, easily-explainable starting points, not
// numbers inferred from Jib's own users.

// pay_yourself_first's fallback rate when there isn't enough history to
// derive one from the user's own cash flow (see suggestSavingsAmount below).
export const PAY_YOURSELF_FIRST_FALLBACK_PERCENT = 10;
// Clamp bounds for the rate pay_yourself_first derives from
// avgNetCashFlow/avgIncome - keeps the suggestion within a sane "pay
// yourself first" range even when the user's own recent cash flow is very
// thin or very strong.
export const PAY_YOURSELF_FIRST_MIN_PERCENT = 5;
export const PAY_YOURSELF_FIRST_MAX_PERCENT = 50;

// roundup's real monthly total genuinely depends on per-transaction
// round-up amounts, which nothing in this codebase currently tracks. This
// is a placeholder starting suggestion the user is expected to adjust, NOT
// a derived estimate - hasData is unconditionally false for this formula
// (see suggestSavingsAmount below), so this number is never presented as
// coming from the user's own data.
export const ROUNDUP_DEFAULT_MONTHLY_AMOUNT = 300_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** One SavingsFormulaSuggestion for the given formula type, derived from `profile`. See SavingsFormulaSuggestion's own doc comment for the targetPercent/targetAmount/suggestedMonthlyAmount/hasData contract. */
export function suggestSavingsAmount(
  formulaType: SavingsStrategyFormulaType,
  profile: MonthlyFinancialProfile
): SavingsFormulaSuggestion {
  switch (formulaType) {
    case "fifty_thirty_twenty": {
      // This model doesn't track the 50/30 split elsewhere, only the fixed
      // 20% savings portion.
      const targetPercent = 20;
      const hasData = profile.avgIncome != null;
      const suggestedMonthlyAmount = profile.avgIncome != null ? Math.round(profile.avgIncome * 0.2) : null;
      return { formulaType, targetPercent, targetAmount: null, suggestedMonthlyAmount, hasData };
    }

    case "pay_yourself_first": {
      let targetPercent: number;
      if (profile.avgIncome != null && profile.avgIncome > 0 && profile.avgNetCashFlow != null) {
        const derivedRate = (profile.avgNetCashFlow / profile.avgIncome) * 100;
        targetPercent = Math.round(clamp(derivedRate, PAY_YOURSELF_FIRST_MIN_PERCENT, PAY_YOURSELF_FIRST_MAX_PERCENT));
      } else {
        targetPercent = PAY_YOURSELF_FIRST_FALLBACK_PERCENT;
      }
      const suggestedMonthlyAmount =
        profile.avgIncome != null ? Math.round((profile.avgIncome * targetPercent) / 100) : null;
      const hasData = profile.avgIncome != null && profile.avgNetCashFlow != null;
      return { formulaType, targetPercent, targetAmount: null, suggestedMonthlyAmount, hasData };
    }

    case "leftover": {
      const targetAmount =
        profile.avgNetCashFlow != null && profile.avgNetCashFlow > 0 ? Math.round(profile.avgNetCashFlow) : null;
      return {
        formulaType,
        targetPercent: null,
        targetAmount,
        suggestedMonthlyAmount: targetAmount,
        hasData: targetAmount !== null,
      };
    }

    case "roundup": {
      // See ROUNDUP_DEFAULT_MONTHLY_AMOUNT's own doc comment - always a
      // placeholder, never claimed to come from the user's own data.
      return {
        formulaType,
        targetPercent: null,
        targetAmount: ROUNDUP_DEFAULT_MONTHLY_AMOUNT,
        suggestedMonthlyAmount: ROUNDUP_DEFAULT_MONTHLY_AMOUNT,
        hasData: false,
      };
    }

    case "custom":
      // No formula to derive a number from - the user sets both from scratch.
      return { formulaType, targetPercent: null, targetAmount: null, suggestedMonthlyAmount: null, hasData: false };
  }
}

/** suggestSavingsAmount for every SAVINGS_STRATEGY_FORMULA_TYPES entry, in that order. */
export function suggestAllFormulas(profile: MonthlyFinancialProfile): SavingsFormulaSuggestion[] {
  return SAVINGS_STRATEGY_FORMULA_TYPES.map((formulaType) => suggestSavingsAmount(formulaType, profile));
}
