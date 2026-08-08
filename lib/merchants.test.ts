import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEFAULT_MERCHANTS } from "@/lib/merchants";
import type { CategoryType } from "@/lib/categories";

// Flattens every (category, subcategory) pair actually reachable from
// DEFAULT_MERCHANTS - both each merchant's own default and every
// keywordOverride nested inside it - into one flat list of cases, built
// from the real data structure rather than copy-pasted. A new merchant or
// override added later is covered automatically; there's no separate list
// to remember to update.
interface CategoryPairCase {
  label: string;
  category: string;
  subcategory?: string;
  type: CategoryType;
}

function collectCategoryPairs(): CategoryPairCase[] {
  const cases: CategoryPairCase[] = [];
  for (const merchant of DEFAULT_MERCHANTS) {
    cases.push({
      label: `${merchant.name} (default)`,
      category: merchant.defaultCategory,
      subcategory: merchant.defaultSubcategory,
      type: merchant.type,
    });
    for (const override of merchant.keywordOverrides ?? []) {
      cases.push({
        label: `${merchant.name} (keyword: "${override.keyword}")`,
        category: override.category,
        subcategory: override.subcategory,
        type: merchant.type,
      });
    }
  }
  return cases;
}

// Guards against the class of bug fixed across this whole file in the
// 2026-08-06 category audit: a defaultCategory/defaultSubcategory (or
// keywordOverride category/subcategory) string that doesn't exactly match
// a real seeded DefaultCategory name+parent relationship (see
// lib/merchants.ts's top-of-file comment on why matching is by exact
// name - lib/ai/parse-transaction.ts's resolveCategoryOverride silently
// drops any pair that doesn't). Checked against the live DefaultCategory
// table - the actual seed source (prisma/seed.ts) - rather than a
// hardcoded expected list, so a future rename on either side still gets
// caught instead of two copies of the same typo agreeing with each other.
// Supersedes (covers a superset of) the narrower اسنپ/تپسی-only check in
// lib/merchant-lookup.test.ts.
describe("every DEFAULT_MERCHANTS category/subcategory pair resolves to a real seeded DefaultCategory", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(collectCategoryPairs())("$label", async ({ category, subcategory, type }) => {
    const topLevel = await prisma.defaultCategory.findFirst({
      where: { name: category, type, parentId: null },
    });
    expect(
      topLevel,
      `top-level category "${category}" (type: ${type}) not found in seeded DefaultCategory`
    ).not.toBeNull();

    if (!subcategory) return;

    const child = await prisma.defaultCategory.findFirst({
      where: { name: subcategory, type },
      include: { parent: true },
    });
    expect(
      child,
      `subcategory "${subcategory}" (type: ${type}) not found in seeded DefaultCategory`
    ).not.toBeNull();
    expect(
      child?.parent?.name,
      `subcategory "${subcategory}" exists but its parent is "${child?.parent?.name}", not "${category}"`
    ).toBe(category);
  });
});
