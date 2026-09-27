import { describe, it, expect } from "vitest";
import { generateHighlights } from "@/lib/reports/generate-highlights";
import { formatToman, formatNumber } from "@/lib/format";
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

// Message-shape assertions (post docs/jib-persona.md v1.1) - these check that a highlight's
// message contains the category name (where applicable) and the correctly formatted percent/
// amount, rather than asserting the exact idiomatic wording chosen for each candidate. The exact
// wording is intentionally free to evolve (rotating expression-bank idioms etc.) as long as the
// underlying facts still show up, correctly formatted.
function expectMessageWithPercent(message: string, percent: number) {
  expect(message).toContain(`${formatNumber(percent)}٪`);
}

function expectMessageWithCategory(message: string, categoryName: string) {
  expect(message).toContain(`«${categoryName}»`);
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
    expect(highlights).toHaveLength(3);

    const overall = highlights[0];
    expect(overall.type).toBe("positive");
    expect(overall.category).toBeUndefined();
    expectMessageWithPercent(overall.message, 25);
    expect(overall.message).toContain("نسبت به ماه قبل");

    const warning = highlights.find((h) => h.type === "warning")!;
    expect(warning.category).toBe("خوراک");
    expectMessageWithCategory(warning.message, "خوراک");
    expectMessageWithPercent(warning.message, 60);

    const savings = highlights.find((h) => h.type === "positive" && h.category)!;
    expect(savings.category).toBe("سرگرمی");
    expectMessageWithCategory(savings.message, "سرگرمی");
    expectMessageWithPercent(savings.message, 55);
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

    expect(highlights).toHaveLength(2);

    const warning = highlights.find((h) => h.category === "پوشاک")!;
    expect(warning.type).toBe("warning");
    expectMessageWithCategory(warning.message, "پوشاک");
    expectMessageWithPercent(warning.message, 75);

    const total = highlights.find((h) => h.amount !== undefined)!;
    expect(total.type).toBe("warning");
    expect(total.amount).toBe(discretionaryTotal);
    expect(total.message).toContain(formatToman(discretionaryTotal));
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

    expect(highlights).toHaveLength(2);

    const total = highlights.find((h) => h.amount !== undefined)!;
    expect(total.type).toBe("warning");
    expect(total.amount).toBe(discretionaryTotal);
    expect(total.message).toContain(formatToman(discretionaryTotal));

    const savings = highlights.find((h) => h.category === "سفر")!;
    expect(savings.type).toBe("positive");
    expectMessageWithCategory(savings.message, "سفر");
    expectMessageWithPercent(savings.message, 90);
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

    expect(highlights).toHaveLength(3);
    for (const highlight of highlights) {
      expect(highlight.message).toContain("نسبت به هفته قبل");
      expect(highlight.message).not.toContain("نسبت به ماه قبل");
    }
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

    expect(highlights).toHaveLength(2);

    const warning = highlights.find((h) => h.category === "سفر")!;
    expect(warning.type).toBe("warning");
    expectMessageWithCategory(warning.message, "سفر");
    expectMessageWithPercent(warning.message, 23);

    const total = highlights.find((h) => h.amount !== undefined)!;
    expect(total.amount).toBe(3700000);
    expect(total.message).toContain(formatToman(3700000));
  });

  it("phrases an essential category's cost increase neutrally, as an 'info' highlight rather than a warning", () => {
    const input = result({
      categories: [category({ category: "اجاره", percentChange: 60, isEssential: true })],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toHaveLength(1);
    const [highlight] = highlights;
    expect(highlight.type).toBe("info");
    expect(highlight.category).toBe("اجاره");
    expectMessageWithCategory(highlight.message, "اجاره");
    expectMessageWithPercent(highlight.message, 60);
    // Neutral, not the actionable/warning tone used for discretionary increases - no call to cut
    // or watch an essential cost, per docs/jib-persona.md's "don't tell the user to cut an
    // essential cost" instruction.
    expect(highlight.message).not.toContain("مراقب باشید");
    expect(highlight.message).not.toContain("کم کن");
  });

  it("still surfaces a category-savings highlight for an essential category's large decrease", () => {
    const input = result({
      categories: [category({ category: "بیمه", percentChange: -60, isEssential: true })],
    });

    const highlights = generateHighlights(input);

    expect(highlights).toHaveLength(1);
    const [highlight] = highlights;
    expect(highlight.type).toBe("positive");
    expect(highlight.category).toBe("بیمه");
    expectMessageWithCategory(highlight.message, "بیمه");
    expectMessageWithPercent(highlight.message, 60);
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
    expect(highlights).toHaveLength(3);
    expect(highlights.some((h) => h.type === "info")).toBe(false);

    const savings = highlights.find((h) => h.category === "سرگرمی")!;
    expect(savings.type).toBe("positive");
    expectMessageWithPercent(savings.message, 70);

    const warning = highlights.find((h) => h.category === "سفر")!;
    expect(warning.type).toBe("warning");
    expectMessageWithPercent(warning.message, 60);

    const total = highlights.find((h) => h.amount !== undefined)!;
    expect(total.amount).toBe(discretionaryTotal);
    expect(total.message).toContain(formatToman(discretionaryTotal));
  });

  // Persona (docs/jib-persona.md v1.1) coverage: each positive/warning highlight type should open
  // with an idiomatic, non-generic phrase (not just the bare fact), while the essential-increase
  // "info" highlight stays plain/reassuring rather than picking up a forced idiom.
  it("opens the overall-savings highlight with expression-bank framing, not the old flat sentence", () => {
    const input = result({ totalPercentChange: -25 });
    const [highlight] = generateHighlights(input);

    expect(highlight.message).not.toContain("عالی! هزینه‌های شما");
    expectMessageWithPercent(highlight.message, 25);
  });

  it("opens the discretionary-total highlight with expression-bank framing distinct from narrative-report.ts's opportunity line", () => {
    const input = result({
      categories: [category({ category: "سرگرمی", percentChange: 5 })],
    });
    const highlight = generateHighlights(input).find((h) => h.amount !== undefined)!;

    // narrative-report.ts's resolveOpportunity uses "یه‌جای خالی برای پس‌انداز پیدا کردم" for the
    // same situation - this highlight must not repeat it verbatim (see the in-code comment on
    // discretionaryTotalCandidate for why).
    expect(highlight.message).not.toContain("یه‌جای خالی برای پس‌انداز پیدا کردم");
    expect(highlight.message).toContain(formatToman(highlight.amount!));
  });

  it("keeps the essential-increase highlight non-judgmental and free of a cut-spending call to action", () => {
    const input = result({
      categories: [category({ category: "اجاره", percentChange: 80, isEssential: true })],
    });
    const [highlight] = generateHighlights(input);

    expect(highlight.type).toBe("info");
    expect(highlight.message).not.toMatch(/کم(تر)? کن/);
    expect(highlight.message).not.toContain("مراقب باشید");
  });
});
