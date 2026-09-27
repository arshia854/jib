import { describe, it, expect } from "vitest";
import {
  suggestSavingsAmount,
  suggestAllFormulas,
  PAY_YOURSELF_FIRST_FALLBACK_PERCENT,
  PAY_YOURSELF_FIRST_MIN_PERCENT,
  PAY_YOURSELF_FIRST_MAX_PERCENT,
  ROUNDUP_DEFAULT_MONTHLY_AMOUNT,
} from "@/lib/savings/formulas";
import { SAVINGS_STRATEGY_FORMULA_TYPES } from "@/lib/data/savings-strategies";
import type { MonthlyFinancialProfile } from "@/lib/savings/monthly-profile";

function profile(overrides: Partial<MonthlyFinancialProfile> = {}): MonthlyFinancialProfile {
  return {
    avgIncome: 10_000_000,
    avgEssentialExpense: 5_000_000,
    avgDiscretionaryExpense: 2_000_000,
    avgNetCashFlow: 3_000_000,
    ...overrides,
  };
}

const NO_DATA_PROFILE: MonthlyFinancialProfile = {
  avgIncome: null,
  avgEssentialExpense: null,
  avgDiscretionaryExpense: null,
  avgNetCashFlow: null,
};

describe("suggestSavingsAmount", () => {
  describe("fifty_thirty_twenty", () => {
    it("suggests a fixed 20% and the matching Toman amount from avgIncome", () => {
      const result = suggestSavingsAmount("fifty_thirty_twenty", profile());
      expect(result).toEqual({
        formulaType: "fifty_thirty_twenty",
        targetPercent: 20,
        targetAmount: null,
        suggestedMonthlyAmount: 2_000_000,
        hasData: true,
      });
    });

    it("hasData is false and suggestedMonthlyAmount is null with no income history", () => {
      const result = suggestSavingsAmount("fifty_thirty_twenty", NO_DATA_PROFILE);
      expect(result.targetPercent).toBe(20);
      expect(result.suggestedMonthlyAmount).toBeNull();
      expect(result.hasData).toBe(false);
    });
  });

  describe("pay_yourself_first", () => {
    it("derives targetPercent from avgNetCashFlow/avgIncome when within the clamp range", () => {
      // 3,000,000 / 10,000,000 * 100 = 30%, within [5, 50].
      const result = suggestSavingsAmount("pay_yourself_first", profile());
      expect(result.targetPercent).toBe(30);
      expect(result.suggestedMonthlyAmount).toBe(3_000_000);
      expect(result.hasData).toBe(true);
    });

    it("clamps the derived rate at the minimum (PAY_YOURSELF_FIRST_MIN_PERCENT) for thin/negative cash flow", () => {
      // 100,000 / 10,000,000 * 100 = 1%, below the 5% floor.
      const result = suggestSavingsAmount(
        "pay_yourself_first",
        profile({ avgIncome: 10_000_000, avgNetCashFlow: 100_000 })
      );
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_MIN_PERCENT);
      expect(result.suggestedMonthlyAmount).toBe(Math.round((10_000_000 * PAY_YOURSELF_FIRST_MIN_PERCENT) / 100));
      expect(result.hasData).toBe(true);
    });

    it("clamps a negative derived rate at the minimum too, not below it", () => {
      const result = suggestSavingsAmount(
        "pay_yourself_first",
        profile({ avgIncome: 10_000_000, avgNetCashFlow: -5_000_000 })
      );
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_MIN_PERCENT);
      expect(result.hasData).toBe(true);
    });

    it("clamps the derived rate at the maximum (PAY_YOURSELF_FIRST_MAX_PERCENT) for very strong cash flow", () => {
      // 9,000,000 / 10,000,000 * 100 = 90%, above the 50% ceiling.
      const result = suggestSavingsAmount(
        "pay_yourself_first",
        profile({ avgIncome: 10_000_000, avgNetCashFlow: 9_000_000 })
      );
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_MAX_PERCENT);
      expect(result.suggestedMonthlyAmount).toBe(Math.round((10_000_000 * PAY_YOURSELF_FIRST_MAX_PERCENT) / 100));
      expect(result.hasData).toBe(true);
    });

    it("falls back to PAY_YOURSELF_FIRST_FALLBACK_PERCENT with no history at all", () => {
      const result = suggestSavingsAmount("pay_yourself_first", NO_DATA_PROFILE);
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_FALLBACK_PERCENT);
      expect(result.suggestedMonthlyAmount).toBeNull();
      expect(result.hasData).toBe(false);
    });

    it("falls back to PAY_YOURSELF_FIRST_FALLBACK_PERCENT when avgIncome exists but avgNetCashFlow does not", () => {
      const result = suggestSavingsAmount(
        "pay_yourself_first",
        profile({ avgIncome: 10_000_000, avgNetCashFlow: null })
      );
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_FALLBACK_PERCENT);
      // suggestedMonthlyAmount is still derivable from avgIncome + the
      // fallback percent even though hasData is false (no real cash-flow
      // signal backs the *rate* itself).
      expect(result.suggestedMonthlyAmount).toBe(
        Math.round((10_000_000 * PAY_YOURSELF_FIRST_FALLBACK_PERCENT) / 100)
      );
      expect(result.hasData).toBe(false);
    });

    it("falls back to PAY_YOURSELF_FIRST_FALLBACK_PERCENT when avgIncome is zero (division-by-zero guard), but hasData is still true since both averages are non-null", () => {
      const result = suggestSavingsAmount(
        "pay_yourself_first",
        profile({ avgIncome: 0, avgNetCashFlow: 1_000_000 })
      );
      expect(result.targetPercent).toBe(PAY_YOURSELF_FIRST_FALLBACK_PERCENT);
      expect(result.suggestedMonthlyAmount).toBe(0);
      expect(result.hasData).toBe(true);
    });
  });

  describe("leftover", () => {
    it("targets a positive avgNetCashFlow, rounded", () => {
      const result = suggestSavingsAmount("leftover", profile({ avgNetCashFlow: 3_000_000.6 }));
      expect(result.targetAmount).toBe(3_000_001);
      expect(result.suggestedMonthlyAmount).toBe(3_000_001);
      expect(result.targetPercent).toBeNull();
      expect(result.hasData).toBe(true);
    });

    it("hasData is false and targetAmount is null when avgNetCashFlow is null", () => {
      const result = suggestSavingsAmount("leftover", NO_DATA_PROFILE);
      expect(result.targetAmount).toBeNull();
      expect(result.suggestedMonthlyAmount).toBeNull();
      expect(result.hasData).toBe(false);
    });

    it("hasData is false and targetAmount is null when avgNetCashFlow is zero or negative", () => {
      const zero = suggestSavingsAmount("leftover", profile({ avgNetCashFlow: 0 }));
      expect(zero.targetAmount).toBeNull();
      expect(zero.hasData).toBe(false);

      const negative = suggestSavingsAmount("leftover", profile({ avgNetCashFlow: -1_000_000 }));
      expect(negative.targetAmount).toBeNull();
      expect(negative.hasData).toBe(false);
    });
  });

  describe("roundup", () => {
    it("always suggests ROUNDUP_DEFAULT_MONTHLY_AMOUNT with hasData false, even with a full profile", () => {
      const result = suggestSavingsAmount("roundup", profile());
      expect(result.targetAmount).toBe(ROUNDUP_DEFAULT_MONTHLY_AMOUNT);
      expect(result.suggestedMonthlyAmount).toBe(ROUNDUP_DEFAULT_MONTHLY_AMOUNT);
      expect(result.targetPercent).toBeNull();
      expect(result.hasData).toBe(false);
    });

    it("is unaffected by a no-data profile - same placeholder either way", () => {
      const result = suggestSavingsAmount("roundup", NO_DATA_PROFILE);
      expect(result.targetAmount).toBe(ROUNDUP_DEFAULT_MONTHLY_AMOUNT);
      expect(result.hasData).toBe(false);
    });
  });

  describe("custom", () => {
    it("has no derivable suggestion of any kind", () => {
      const result = suggestSavingsAmount("custom", profile());
      expect(result).toEqual({
        formulaType: "custom",
        targetPercent: null,
        targetAmount: null,
        suggestedMonthlyAmount: null,
        hasData: false,
      });
    });
  });
});

describe("suggestAllFormulas", () => {
  it("returns one suggestion per SAVINGS_STRATEGY_FORMULA_TYPES entry, in that order", () => {
    const results = suggestAllFormulas(profile());
    expect(results.map((r) => r.formulaType)).toEqual([...SAVINGS_STRATEGY_FORMULA_TYPES]);
  });
});
