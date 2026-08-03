import { describe, it, expect } from "vitest";
import { findSimilarCategory, resolveNewCategoryIcon } from "@/lib/categories";
import type { CategoryOption } from "@/lib/ai/parse-transaction";

const EXPENSE_CATEGORIES: CategoryOption[] = [
  { name: "سوپرمارکت", type: "expense", parentName: "خوراک و رستوران" },
  { name: "دارو", type: "expense" },
  { name: "سایر", type: "expense" },
];

describe("findSimilarCategory", () => {
  it("returns the existing category on an exact (normalized) name match, with no alias registry involved", () => {
    const match = findSimilarCategory({ name: "سوپرمارکت", parentName: null }, EXPENSE_CATEGORIES, "expense", {});
    expect(match).toEqual(EXPENSE_CATEGORIES[0]);
  });

  it("returns null when nothing matches, directly or via alias", () => {
    const match = findSimilarCategory(
      { name: "لوازم حیوان خانگی", parentName: null },
      EXPENSE_CATEGORIES,
      "expense",
      {}
    );
    expect(match).toBeNull();
  });

  it("resolves a new alias purely from an injected registry, proving the matching function needs no changes to support it", () => {
    // Deliberately NOT the real CATEGORY_ALIASES - a custom registry with an
    // alias ("قرص") the real one doesn't have, pointing at "دارو".
    const customRegistry = { "دارو": ["قرص"] };

    const match = findSimilarCategory({ name: "قرص", parentName: null }, EXPENSE_CATEGORIES, "expense", customRegistry);

    expect(match).toEqual(EXPENSE_CATEGORIES[1]);
  });

  it("does not chase a two-hop alias relationship - only the direct alias->canonical lookup is used, never a walk", () => {
    // "الف" is an alias for "ب", and "ب" is separately also an alias for
    // "سوپرمارکت". A recursive/walking implementation would resolve
    // "الف" -> "ب" -> "سوپرمارکت"; findSimilarCategory must not do that -
    // "ب" is only ever treated as a canonical key when it's looked up
    // directly, never reached by chasing "الف"'s value further.
    const chainedRegistry = {
      "ب": ["الف"],
      "سوپرمارکت": ["ب"],
    };

    const match = findSimilarCategory({ name: "الف", parentName: null }, EXPENSE_CATEGORIES, "expense", chainedRegistry);

    // "ب" itself has no existing category named "ب", so the single-level
    // lookup ("الف" -> canonical "ب") correctly comes up empty instead of
    // walking further to "سوپرمارکت".
    expect(match).toBeNull();
  });

  it("only matches within the given type, even when the name matches", () => {
    const incomeVersion: CategoryOption = { name: "سوپرمارکت", type: "income" };
    const match = findSimilarCategory(
      { name: "سوپرمارکت", parentName: null },
      [...EXPENSE_CATEGORIES, incomeVersion],
      "income",
      {}
    );
    expect(match).toEqual(incomeVersion);
  });

  describe("stage 3: token-overlap fallback", () => {
    it("fires only once stages 1-2 both miss, matching on shared wording alone", () => {
      const categories: CategoryOption[] = [{ name: "خرید آنلاین", type: "expense" }];
      // "خرید حضوری" isn't an exact match for "خرید آنلاین" and isn't in the
      // (empty) alias registry, so this can only resolve via stage 3.
      const match = findSimilarCategory({ name: "خرید حضوری", parentName: null }, categories, "expense", {});
      expect(match).toEqual(categories[0]);
    });

    it("never runs when stage 1 already found a match, even if another candidate has stronger token overlap", () => {
      const exactMatch: CategoryOption = { name: "خرید آنلاین", type: "expense" };
      // Shares 3/3 tokens with the suggestion (a strictly higher ratio than
      // exactMatch's 2/2), but exactMatch must still win since stage 1
      // short-circuits before stage 3 ever runs.
      const higherOverlap: CategoryOption = { name: "خرید آنلاین فوری", type: "expense" };
      const match = findSimilarCategory(
        { name: "خرید آنلاین", parentName: null },
        [higherOverlap, exactMatch],
        "expense",
        {}
      );
      expect(match).toEqual(exactMatch);
    });

    it("matches at a ratio just above the 0.5 threshold (3/5 shared tokens)", () => {
      const categories: CategoryOption[] = [{ name: "یک دو سه شش هفت", type: "expense" }];
      // suggestion tokens: یک،دو،سه،چهار،پنج - shares یک/دو/سه (3) out of the
      // shorter (5-token) side -> 3/5 = 0.6, above the 0.5 threshold.
      const match = findSimilarCategory(
        { name: "یک دو سه چهار پنج", parentName: null },
        categories,
        "expense",
        {}
      );
      expect(match).toEqual(categories[0]);
    });

    it("does not match at a ratio just below the 0.5 threshold (2/5 shared tokens)", () => {
      const categories: CategoryOption[] = [{ name: "یک دو شش هفت هشت", type: "expense" }];
      // Same 5-token suggestion as above, but this candidate only shares
      // یک/دو (2) -> 2/5 = 0.4, below the 0.5 threshold.
      const match = findSimilarCategory(
        { name: "یک دو سه چهار پنج", parentName: null },
        categories,
        "expense",
        {}
      );
      expect(match).toBeNull();
    });

    it("breaks a tie between equal-ratio candidates by picking the first in existingCategories array order", () => {
      // Both share 2/3 tokens with the suggestion ("یک دو سه") - candidateA
      // (یک، دو) and candidateB (یک، سه) both land at ratio 2/3. candidateA
      // is listed first, so it must win over candidateB despite the equal
      // ratio, rather than leaving the outcome to incidental array order.
      const candidateA: CategoryOption = { name: "یک دو چهار", type: "expense" };
      const candidateB: CategoryOption = { name: "یک سه پنج", type: "expense" };
      const match = findSimilarCategory(
        { name: "یک دو سه", parentName: null },
        [candidateA, candidateB],
        "expense",
        {}
      );
      expect(match).toEqual(candidateA);
    });
  });

  describe("same-parent preference", () => {
    it("prefers a same-parent match over an earlier-in-array cross-parent match", () => {
      const crossParent: CategoryOption = { name: "قهوه", type: "expense", parentName: "خانه" };
      const sameParent: CategoryOption = { name: "قهوه", type: "expense", parentName: "کار" };
      // crossParent is listed first - without same-parent preference, a
      // plain .find() over the full list would hit it before sameParent.
      const match = findSimilarCategory(
        { name: "قهوه", parentName: "کار" },
        [crossParent, sameParent],
        "expense",
        {}
      );
      expect(match).toEqual(sameParent);
    });

    it("falls back to a cross-parent match when nothing matches within the same parent", () => {
      const crossParent: CategoryOption = { name: "قهوه", type: "expense", parentName: "خانه" };
      const match = findSimilarCategory(
        { name: "قهوه", parentName: "کار" }, // no existing category is parented under "کار"
        [crossParent],
        "expense",
        {}
      );
      expect(match).toEqual(crossParent);
    });
  });
});

describe("resolveNewCategoryIcon", () => {
  it("returns the same icon across repeated calls for the same input", () => {
    const first = resolveNewCategoryIcon("دخانیات");
    const second = resolveNewCategoryIcon("دخانیات");
    expect(first).toEqual(second);
  });

  it("returns the correct icon for a known name", () => {
    expect(resolveNewCategoryIcon("دخانیات")).toBe("🚬");
  });

  it("returns the default fallback icon for an unrecognized name", () => {
    expect(resolveNewCategoryIcon("سفر شمال")).toBe("📦");
  });
});
