import { describe, it, expect } from "vitest";
import { generateHighlights } from "@/lib/reports/generate-highlights";
import type { CategoryComparison, MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";

function category(overrides: Partial<CategoryComparison> & { category: string }): CategoryComparison {
  return {
    previousAmount: 100,
    currentAmount: 100,
    percentChange: 0,
    isIncrease: false,
    ...overrides,
  };
}

function result(overrides: Partial<MonthlyComparisonResult> = {}): MonthlyComparisonResult {
  return {
    currentMonth: "1404-06",
    previousMonth: "1404-05",
    categories: [],
    totalPrevious: 1000,
    totalCurrent: 1000,
    totalPercentChange: 0,
    ...overrides,
  };
}

describe("generateHighlights", () => {
  it("returns no highlights when nothing crosses a threshold", () => {
    const input = result({
      totalPercentChange: 10,
      categories: [
        category({ category: "خوراک", percentChange: 20 }),
        category({ category: "حمل‌ونقل", percentChange: -10 }),
      ],
    });

    expect(generateHighlights(input)).toEqual([]);
  });

  it("returns exactly 3 highlights when one from each rule qualifies", () => {
    const input = result({
      totalPercentChange: -25,
      categories: [
        category({ category: "خوراک", percentChange: 60 }),
        category({ category: "سرگرمی", percentChange: -55 }),
      ],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      { type: "positive", message: "عالی! هزینه‌های شما 25٪ نسبت به ماه قبل کاهش یافته است." },
      {
        type: "warning",
        category: "خوراک",
        message: "هزینه «خوراک» نسبت به ماه قبل 60٪ افزایش یافته — کمی مراقب باشید.",
      },
      {
        type: "positive",
        category: "سرگرمی",
        message: "صرفه‌جویی خوب در «سرگرمی»؛ 55٪ کمتر از ماه قبل خرج کرده‌اید.",
      },
    ]);
  });

  it("keeps only the 3 largest highlights when more than 3 would qualify", () => {
    const input = result({
      totalPercentChange: -5, // qualifies for rule A, always kept regardless of magnitude
      categories: [
        category({ category: "خوراک", percentChange: 60 }),
        category({ category: "پوشاک", percentChange: 90 }), // largest increase, should win rule B
        category({ category: "قبوض", percentChange: 55 }),
        category({ category: "سرگرمی", percentChange: -55 }),
        category({ category: "سفر", percentChange: -80 }), // largest decrease, should win rule C
      ],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toHaveLength(3);
    expect(highlights[0].type).toBe("positive");
    expect(highlights[0].category).toBeUndefined();
    expect(highlights.some((h) => h.category === "پوشاک" && h.type === "warning")).toBe(true);
    expect(highlights.some((h) => h.category === "سفر" && h.type === "positive")).toBe(true);
    expect(highlights.some((h) => h.category === "خوراک")).toBe(false);
    expect(highlights.some((h) => h.category === "قبوض")).toBe(false);
    expect(highlights.some((h) => h.category === "سرگرمی")).toBe(false);
  });

  it("returns only a warning highlight when just rule B qualifies", () => {
    const input = result({
      totalPercentChange: 5,
      categories: [
        category({ category: "خوراک", percentChange: 60 }),
        category({ category: "پوشاک", percentChange: 75 }),
        category({ category: "قبوض", percentChange: 10 }),
      ],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      {
        type: "warning",
        category: "پوشاک",
        message: "هزینه «پوشاک» نسبت به ماه قبل 75٪ افزایش یافته — کمی مراقب باشید.",
      },
    ]);
  });

  it("returns only a category-savings highlight when just rule C qualifies", () => {
    const input = result({
      totalPercentChange: 5,
      categories: [
        category({ category: "سرگرمی", percentChange: -55 }),
        category({ category: "سفر", percentChange: -90 }),
        category({ category: "قبوض", percentChange: -10 }),
      ],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      {
        type: "positive",
        category: "سفر",
        message: "صرفه‌جویی خوب در «سفر»؛ 90٪ کمتر از ماه قبل خرج کرده‌اید.",
      },
    ]);
  });

  it("ignores categories with a null percentChange", () => {
    const input = result({
      totalPercentChange: null,
      categories: [category({ category: "متفرقه", percentChange: null, previousAmount: 0, currentAmount: 0 })],
    });

    expect(generateHighlights(input)).toEqual([]);
  });
});
