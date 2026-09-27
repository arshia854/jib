import { describe, expect, it } from "vitest";
import { GOAL_CATEGORY_META, GOAL_CATEGORY_OPTIONS, getGoalCategoryMeta } from "./categories";

describe("getGoalCategoryMeta", () => {
  it("returns the matching meta for each known category", () => {
    for (const [category, meta] of Object.entries(GOAL_CATEGORY_META)) {
      expect(getGoalCategoryMeta(category)).toEqual(meta);
    }
  });

  it("falls back to 'other' for a value outside the known 6", () => {
    expect(getGoalCategoryMeta("not_a_real_category")).toEqual(GOAL_CATEGORY_META.other);
  });
});

describe("GOAL_CATEGORY_OPTIONS", () => {
  it("has exactly one option per GOAL_CATEGORY_META entry, in the same order", () => {
    expect(GOAL_CATEGORY_OPTIONS.map((o) => o.value)).toEqual(Object.keys(GOAL_CATEGORY_META));
  });

  it("mirrors each entry's emoji/label", () => {
    for (const option of GOAL_CATEGORY_OPTIONS) {
      expect(option).toEqual({ value: option.value, ...GOAL_CATEGORY_META[option.value] });
    }
  });
});
