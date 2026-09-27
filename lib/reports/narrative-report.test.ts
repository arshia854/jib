import { describe, it, expect } from "vitest";
import {
  generateNarrativeReport,
  MIN_ELAPSED_FRACTION_FOR_PROJECTION,
  OPPORTUNITY_REDUCTION_PERCENT,
  TOTAL_EXPENSE_LABEL,
} from "@/lib/reports/narrative-report";
import { periodToGregorianRange } from "@/lib/reports/period-range";
import { formatToman } from "@/lib/format";
import type { CategoryComparison, MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";
import type { TrendPeriod, UnusualTransaction } from "@/lib/reports/trend-insights";

// Same builder convention as generate-highlights.test.ts - discretionary (isEssential: false) by
// default so existing tests that don't care about it are unaffected.
function category(overrides: Partial<CategoryComparison> & { category: string }): CategoryComparison {
  return {
    previousAmount: 100,
    currentAmount: 100,
    percentChange: 0,
    isIncrease: false,
    isEssential: false,
    ...overrides,
  };
}

function result(overrides: Partial<MonthlyComparisonResult> = {}): MonthlyComparisonResult {
  return {
    currentMonth: CURRENT_PERIOD,
    previousMonth: "1404-05",
    categories: [],
    totalPrevious: 1000,
    totalCurrent: 1000,
    totalPercentChange: 0,
    ...overrides,
  };
}

function trendPeriod(overrides: Partial<TrendPeriod> & { periodKey: string }): TrendPeriod {
  return {
    label: overrides.periodKey,
    income: 0,
    expense: 0,
    net: 0,
    ...overrides,
  };
}

// isEssential defaults to false (discretionary) for the same reason category() above does -
// existing tests that don't care about the essential/discretionary split are unaffected.
function unusual(overrides: Partial<UnusualTransaction> & { category: string }): UnusualTransaction {
  return {
    id: 1,
    date: new Date(),
    description: null,
    amount: 300,
    categoryAverage: 100,
    multiple: 3,
    isEssential: false,
    ...overrides,
  };
}

const GRANULARITY = "month" as const;
const CURRENT_PERIOD = "1404-06";
const { start: PERIOD_START, end: PERIOD_END } = periodToGregorianRange(CURRENT_PERIOD, GRANULARITY);

/** A `now` at exactly `fraction` of the way through CURRENT_PERIOD. */
function nowAtFraction(fraction: number): Date {
  return new Date(PERIOD_START.getTime() + (PERIOD_END.getTime() - PERIOD_START.getTime()) * fraction);
}

function generate(overrides: {
  comparison?: MonthlyComparisonResult;
  trend?: TrendPeriod[];
  unusualTransactions?: UnusualTransaction[];
  now?: Date;
}) {
  return generateNarrativeReport({
    granularity: GRANULARITY,
    currentPeriod: CURRENT_PERIOD,
    comparison: overrides.comparison ?? result(),
    trend: overrides.trend ?? [trendPeriod({ periodKey: CURRENT_PERIOD, income: 1000, expense: 500 })],
    unusualTransactions: overrides.unusualTransactions ?? [],
    now: overrides.now ?? nowAtFraction(0.5),
  });
}

describe("generateNarrativeReport", () => {
  it("throws when trend has no entry for currentPeriod", () => {
    expect(() =>
      generate({ trend: [trendPeriod({ periodKey: "1404-01" })] })
    ).toThrow(/currentPeriod/);
  });

  it("reads income/expense from the matching trend entry, not comparison's expense-only totals", () => {
    const report = generate({
      trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 2000, expense: 1200 })],
    });
    expect(report.income).toBe(2000);
    expect(report.expense).toBe(1200);
  });

  describe("status tiers", () => {
    it("is 'unknown' when there's no income this period", () => {
      const report = generate({ trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 0, expense: 500 })] });
      expect(report.status).toBe("unknown");
      expect(report.savingsRate).toBeUndefined();
    });

    it("is 'good' when savingsRate >= 20", () => {
      const report = generate({ trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 1000, expense: 800 })] }); // 20%
      expect(report.status).toBe("good");
      expect(report.savingsRate).toBe(20);
    });

    it("is 'medium' when 0 <= savingsRate < 20", () => {
      const report = generate({ trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 1000, expense: 900 })] }); // 10%
      expect(report.status).toBe("medium");
      expect(report.savingsRate).toBe(10);
    });

    it("is 'medium' at the exact 0% boundary", () => {
      const report = generate({ trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 1000, expense: 1000 })] });
      expect(report.status).toBe("medium");
      expect(report.savingsRate).toBe(0);
    });

    it("is 'bad' when savingsRate < 0", () => {
      const report = generate({ trend: [trendPeriod({ periodKey: CURRENT_PERIOD, income: 1000, expense: 1500 })] });
      expect(report.status).toBe("bad");
      expect(report.savingsRate).toBeLessThan(0);
    });
  });

  describe("topCategory", () => {
    it("is comparison.categories[0] (already sorted descending by currentAmount)", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "خوراک", currentAmount: 500 }), category({ category: "سرگرمی", currentAmount: 200 })],
        }),
      });
      expect(report.topCategory).toEqual({ name: "خوراک", amount: 500 });
    });

    it("is omitted when there are no categories", () => {
      const report = generate({ comparison: result({ categories: [] }) });
      expect(report.topCategory).toBeUndefined();
    });
  });

  describe("insight priority", () => {
    it("prefers the highest-multiple unusual transaction over any category increase", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "خوراک", previousAmount: 100, currentAmount: 900 })], // huge absolute increase
        }),
        unusualTransactions: [
          unusual({ category: "سرگرمی", amount: 300, multiple: 3 }),
          unusual({ category: "پوشاک", amount: 1000, multiple: 6 }), // highest multiple, should win
        ],
      });
      expect(report.insight?.category).toBe("پوشاک");
      expect(report.insight?.multiple).toBe(6);
      expect(report.insight?.amount).toBe(1000);
      // v1.1 expression bank idiom opens the message, ahead of the category/amount/multiple.
      expect(report.insight?.message).toContain("پول از دستت مثل آب سُر خورد");
      expect(report.insight?.message).toContain("«پوشاک»");
      expect(report.insight?.message).toContain(formatToman(1000));
      // The baseline is a multi-period average now - the message must not claim an all-time
      // ("همیشگی") one, which is what the old copy said back when it was same-period-only.
      expect(report.insight?.message).toContain("میانگین این دسته توی دوره‌های اخیر");
      expect(report.insight?.message).not.toContain("همیشگی");
    });

    it("prefers a discretionary unusual transaction over an essential one with a higher multiple", () => {
      const report = generate({
        unusualTransactions: [
          unusual({ category: "اجاره", amount: 5000, multiple: 9, isEssential: true }), // highest multiple overall
          unusual({ category: "سرگرمی", amount: 600, multiple: 4, isEssential: false }),
        ],
      });
      expect(report.insight?.category).toBe("سرگرمی");
      expect(report.insight?.multiple).toBe(4);
      expect(report.insight?.message).toContain("پول از دستت مثل آب سُر خورد");
    });

    it("picks the highest-multiple discretionary transaction among several", () => {
      const report = generate({
        unusualTransactions: [
          unusual({ category: "اجاره", multiple: 20, isEssential: true }),
          unusual({ category: "سرگرمی", multiple: 4, isEssential: false }),
          unusual({ category: "پوشاک", multiple: 7, isEssential: false }),
        ],
      });
      expect(report.insight?.category).toBe("پوشاک");
      expect(report.insight?.multiple).toBe(7);
    });

    it("falls back to an essential unusual transaction, with neutral (non-warning) wording, when there is no discretionary one", () => {
      const report = generate({
        unusualTransactions: [
          unusual({ category: "اجاره", amount: 5000, multiple: 9, isEssential: true }),
          unusual({ category: "درمان", amount: 2000, multiple: 5, isEssential: true }),
        ],
      });
      expect(report.insight?.category).toBe("اجاره");
      expect(report.insight?.multiple).toBe(9);
      expect(report.insight?.message).toContain("«اجاره»");
      expect(report.insight?.message).toContain(formatToman(5000));
      expect(report.insight?.message).toContain("میانگین این دسته توی دوره‌های اخیر");
      // Neutral register (see generate-highlights.ts's essentialIncreaseCandidate) - none of the
      // discretionary branch's "money slipped through your fingers / watch out" framing.
      expect(report.insight?.message).not.toContain("پول از دستت مثل آب سُر خورد");
      expect(report.insight?.message).not.toContain("مراقب");
    });

    it("falls back to the largest absolute increase when there are no unusual transactions", () => {
      const report = generate({
        comparison: result({
          categories: [
            category({ category: "خوراک", previousAmount: 100, currentAmount: 250 }), // +150
            category({ category: "سرگرمی", previousAmount: 1000, currentAmount: 1080 }), // +80, smaller percent-irrelevant absolute delta
          ],
        }),
      });
      expect(report.insight?.category).toBe("خوراک");
      expect(report.insight?.amount).toBe(150);
      expect(report.insight?.multiple).toBeUndefined();
      // v1.1 expression bank idiom - deliberately different from the unusual-transaction branch's.
      expect(report.insight?.message).toContain("دست و دلت واقعاً باز بوده");
      expect(report.insight?.message).toContain("«خوراک»");
      expect(report.insight?.message).toContain(formatToman(150));
    });

    it("picks the largest absolute increase by amount even when its percent change is smaller", () => {
      const report = generate({
        comparison: result({
          categories: [
            category({ category: "کوچک", previousAmount: 10, currentAmount: 30 }), // +20, +200%
            category({ category: "بزرگ", previousAmount: 3_000_000, currentAmount: 3_500_000 }), // +500,000, +17%
          ],
        }),
      });
      expect(report.insight?.category).toBe("بزرگ");
    });

    it("is omitted when no category increased and there are no unusual transactions", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "خوراک", previousAmount: 500, currentAmount: 300 })],
        }),
      });
      expect(report.insight).toBeUndefined();
    });

    it("is omitted when categories is empty and there are no unusual transactions", () => {
      const report = generate({ comparison: result({ categories: [] }) });
      expect(report.insight).toBeUndefined();
    });
  });

  describe("projection", () => {
    const categories = [category({ category: "خوراک", previousAmount: 1000, currentAmount: 800 })];

    it("is omitted before MIN_ELAPSED_FRACTION_FOR_PROJECTION of the period has elapsed", () => {
      const report = generate({
        comparison: result({ categories }),
        now: nowAtFraction(MIN_ELAPSED_FRACTION_FOR_PROJECTION - 0.01),
      });
      expect(report.projection).toBeUndefined();
    });

    it("is present once at least MIN_ELAPSED_FRACTION_FOR_PROJECTION has elapsed and the projection exceeds the baseline", () => {
      // 800 so far at 50% elapsed -> projects to 1600, above the 1000 baseline.
      const report = generate({ comparison: result({ categories }), now: nowAtFraction(0.5) });
      expect(report.projection).toBeDefined();
      expect(report.projection?.target).toBe("خوراک");
      expect(report.projection?.projectedTotal).toBeCloseTo(1600);
      expect(report.projection?.baselineAmount).toBe(1000);
      expect(report.projection?.message).toContain(formatToman(1600));
    });

    it("is omitted when the projection does not exceed the previous-period baseline", () => {
      // 300 so far at 50% elapsed -> projects to 600, below the 1000 baseline - on track to spend less.
      const lowSpend = [category({ category: "خوراک", previousAmount: 1000, currentAmount: 300 })];
      const report = generate({ comparison: result({ categories: lowSpend }), now: nowAtFraction(0.5) });
      expect(report.projection).toBeUndefined();
    });

    it("is omitted when the target has no previous-period baseline to anchor to", () => {
      const newCategory = [category({ category: "جدید", previousAmount: 0, currentAmount: 800 })];
      const report = generate({ comparison: result({ categories: newCategory }), now: nowAtFraction(0.5) });
      expect(report.projection).toBeUndefined();
    });

    it("targets the period's total expense when there is no insight and no topCategory", () => {
      const report = generate({
        comparison: result({ categories: [], totalCurrent: 400, totalPrevious: 500 }),
        now: nowAtFraction(0.2), // 400 / 0.2 = 2000, above the 500 baseline
      });
      expect(report.projection?.target).toBe(TOTAL_EXPENSE_LABEL);
      expect(report.projection?.projectedTotal).toBeCloseTo(2000);
    });
  });

  describe("suggestion", () => {
    it("caps at the target category's previous-period amount", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "خوراک", previousAmount: 1000, currentAmount: 800 })],
        }),
      });
      expect(report.suggestion?.target).toBe("خوراک");
      expect(report.suggestion?.cap).toBe(1000);
    });

    it("is omitted when the target category has no previous-period baseline", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "جدید", previousAmount: 0, currentAmount: 800 })],
        }),
      });
      expect(report.suggestion).toBeUndefined();
    });

    it("is present even when the projection itself is omitted (period barely started)", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "خوراک", previousAmount: 1000, currentAmount: 50 })],
        }),
        now: nowAtFraction(0.01),
      });
      expect(report.projection).toBeUndefined();
      expect(report.suggestion?.cap).toBe(1000);
    });
  });

  describe("opportunity", () => {
    it("is 10% of current-period discretionary spend", () => {
      const report = generate({
        comparison: result({
          categories: [
            category({ category: "سرگرمی", currentAmount: 2000, isEssential: false }),
            category({ category: "اجاره", currentAmount: 5000, isEssential: true }),
          ],
        }),
      });
      const expectedAmount = Math.round((2000 * OPPORTUNITY_REDUCTION_PERCENT) / 100);
      expect(report.opportunity?.amount).toBe(expectedAmount);
      // v1.1 expression bank idiom opens the message, ahead of the percent/amount.
      expect(report.opportunity?.message).toContain("یه‌جای خالی برای پس‌انداز پیدا کردم");
      expect(report.opportunity?.message).toContain(formatToman(expectedAmount));
    });

    it("is omitted when there is no discretionary spending", () => {
      const report = generate({
        comparison: result({
          categories: [category({ category: "اجاره", currentAmount: 5000, isEssential: true })],
        }),
      });
      expect(report.opportunity).toBeUndefined();
    });
  });

  it("passes overallTrendPercent through from comparison.totalPercentChange unchanged", () => {
    const report = generate({ comparison: result({ totalPercentChange: -33 }) });
    expect(report.overallTrendPercent).toBe(-33);
  });

  it("uses the granularity-specific 'این ماه' style periodLabel", () => {
    const report = generate({});
    expect(report.periodLabel).toBe("این ماه");
  });
});
