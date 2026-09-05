import { describe, it, expect } from "vitest";
import { generateHighlights } from "@/lib/reports/generate-highlights";
import { formatToman } from "@/lib/format";
import type { CategoryComparison, MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";

// Discretionary (isEssential: false) by default - most of this file's existing categories
// (خوراک, سرگرمی, پوشاک, سفر...) are conceptually discretionary anyway, and this keeps every
// existing test that doesn't care about isEssential unaffected by its addition. Tests that
// specifically exercise essential-category behavior override it explicitly.
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
        // Marked essential so there's no discretionary spending at all here - otherwise the
        // discretionary-total highlight (see below) would fire regardless of these percent
        // thresholds, since it's independent of percentChange.
        category({ category: "خوراک", percentChange: 20, isEssential: true }),
        category({ category: "حمل‌ونقل", percentChange: -10, isEssential: true }),
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

    // The discretionary-total highlight also qualifies here (both categories are discretionary,
    // currentAmount 100 each against totalCurrent 1000 -> a 20% share) but is outranked within
    // its priority tier by both خوراک's 60% and سرگرمی's 55%, so the capped-at-3 output is
    // unchanged from before isEssential existed.
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
        message: "صرفه‌جویی خوب در «سرگرمی»؛ نسبت به ماه قبل 55٪ کمتر خرج کرده‌اید.",
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

    // The discretionary-total highlight also qualifies (5 categories x 100 currentAmount against
    // totalCurrent 1000 -> 50% share) but its magnitude loses to both پوشاک's 90% and سفر's 80%
    // within their shared priority tier, so it's the one trimmed instead of either of those.
    expect(highlights).toHaveLength(3);
    expect(highlights[0].type).toBe("positive");
    expect(highlights[0].category).toBeUndefined();
    expect(highlights.some((h) => h.category === "پوشاک" && h.type === "warning")).toBe(true);
    expect(highlights.some((h) => h.category === "سفر" && h.type === "positive")).toBe(true);
    expect(highlights.some((h) => h.category === "خوراک")).toBe(false);
    expect(highlights.some((h) => h.category === "قبوض")).toBe(false);
    expect(highlights.some((h) => h.category === "سرگرمی")).toBe(false);
  });

  it("returns a discretionary warning together with the discretionary-total highlight when rule B qualifies", () => {
    const input = result({
      totalPercentChange: 5,
      categories: [
        category({ category: "خوراک", percentChange: 60 }),
        category({ category: "پوشاک", percentChange: 75 }),
        category({ category: "قبوض", percentChange: 10 }),
      ],
    });

    const highlights = generateHighlights(input);
    const discretionaryTotal = 300; // 3 categories x currentAmount 100

    expect(highlights).toEqual([
      {
        type: "warning",
        category: "پوشاک",
        message: "هزینه «پوشاک» نسبت به ماه قبل 75٪ افزایش یافته — کمی مراقب باشید.",
      },
      {
        type: "warning",
        amount: discretionaryTotal,
        message: `${formatToman(discretionaryTotal)} از هزینه‌های این دوره غیرضروری بوده و قابل کاهش است.`,
      },
    ]);
  });

  it("returns the discretionary-total highlight together with a category-savings highlight when rule C qualifies", () => {
    const input = result({
      totalPercentChange: 5,
      categories: [
        category({ category: "سرگرمی", percentChange: -55 }),
        category({ category: "سفر", percentChange: -90 }),
        category({ category: "قبوض", percentChange: -10 }),
      ],
    });

    const highlights = generateHighlights(input);
    const discretionaryTotal = 300; // 3 categories x currentAmount 100

    expect(highlights).toEqual([
      {
        type: "warning",
        amount: discretionaryTotal,
        message: `${formatToman(discretionaryTotal)} از هزینه‌های این دوره غیرضروری بوده و قابل کاهش است.`,
      },
      {
        type: "positive",
        category: "سفر",
        message: "صرفه‌جویی خوب در «سفر»؛ نسبت به ماه قبل 90٪ کمتر خرج کرده‌اید.",
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

  it("uses the given periodLabel in place of the default month wording, in all three message types", () => {
    const input = result({
      totalPercentChange: -25,
      categories: [
        category({ category: "خوراک", percentChange: 60 }),
        category({ category: "سرگرمی", percentChange: -55 }),
      ],
    });

    const highlights = generateHighlights(input, "نسبت به هفته قبل");

    expect(highlights).toEqual([
      { type: "positive", message: "عالی! هزینه‌های شما 25٪ نسبت به هفته قبل کاهش یافته است." },
      {
        type: "warning",
        category: "خوراک",
        message: "هزینه «خوراک» نسبت به هفته قبل 60٪ افزایش یافته — کمی مراقب باشید.",
      },
      {
        type: "positive",
        category: "سرگرمی",
        message: "صرفه‌جویی خوب در «سرگرمی»؛ نسبت به هفته قبل 55٪ کمتر خرج کرده‌اید.",
      },
    ]);
  });

  it("flags a discretionary category as a warning via absolute increase share even when its percentChange is under 50%", () => {
    const input = result({
      totalCurrent: 4000000,
      categories: [
        // Only a 23% relative increase (well under WARNING_INCREASE_THRESHOLD) but its absolute
        // growth (700,000) is 17.5% of totalCurrent, above WARNING_ABSOLUTE_INCREASE_SHARE (15%).
        category({ category: "سفر", percentChange: 23, previousAmount: 3000000, currentAmount: 3700000 }),
      ],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      {
        type: "warning",
        category: "سفر",
        message: "هزینه «سفر» نسبت به ماه قبل 23٪ افزایش یافته — کمی مراقب باشید.",
      },
      {
        type: "warning",
        amount: 3700000,
        message: `${formatToman(3700000)} از هزینه‌های این دوره غیرضروری بوده و قابل کاهش است.`,
      },
    ]);
  });

  it("phrases an essential category's cost increase neutrally, as an 'info' highlight rather than a warning", () => {
    const input = result({
      categories: [category({ category: "اجاره", percentChange: 60, isEssential: true })],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      {
        type: "info",
        category: "اجاره",
        message: "هزینه ضروری «اجاره» نسبت به ماه قبل 60٪ افزایش یافته است.",
      },
    ]);
    // Neutral, not the actionable "کمی مراقب باشید" tone used for discretionary increases.
    expect(highlights[0].message).not.toContain("مراقب باشید");
  });

  it("still surfaces a category-savings highlight for an essential category's large decrease", () => {
    const input = result({
      categories: [category({ category: "بیمه", percentChange: -60, isEssential: true })],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toEqual([
      {
        type: "positive",
        category: "بیمه",
        message: "صرفه‌جویی خوب در «بیمه»؛ نسبت به ماه قبل 60٪ کمتر خرج کرده‌اید.",
      },
    ]);
  });

  it("does not let an essential category's cost increase drown out discretionary/actionable highlights when more than 3 candidates qualify", () => {
    const input = result({
      totalPercentChange: 0, // doesn't qualify for the overall-savings highlight
      categories: [
        category({ category: "سفر", percentChange: 60 }), // discretionary warning, magnitude 60
        category({ category: "بیمه", percentChange: 200, isEssential: true }), // essential-increase "noise" - largest raw magnitude of all four
        category({ category: "سرگرمی", percentChange: -70 }), // category savings, magnitude 70
      ],
    });

    const highlights = generateHighlights(input);
    const discretionaryTotal = 200; // سفر + سرگرمی, 100 currentAmount each (بیمه is essential, excluded)

    // Despite بیمه's 200% dwarfing every other candidate's magnitude, it sits in the lowest
    // priority tier (essential-cost noise) and is the one dropped - not one of the three
    // discretionary/actionable candidates, which fill every slot on this cap.
    expect(highlights).toEqual([
      {
        type: "positive",
        category: "سرگرمی",
        message: "صرفه‌جویی خوب در «سرگرمی»؛ نسبت به ماه قبل 70٪ کمتر خرج کرده‌اید.",
      },
      {
        type: "warning",
        category: "سفر",
        message: "هزینه «سفر» نسبت به ماه قبل 60٪ افزایش یافته — کمی مراقب باشید.",
      },
      {
        type: "warning",
        amount: discretionaryTotal,
        message: `${formatToman(discretionaryTotal)} از هزینه‌های این دوره غیرضروری بوده و قابل کاهش است.`,
      },
    ]);
    expect(highlights.some((h) => h.type === "info")).toBe(false);
  });
});
