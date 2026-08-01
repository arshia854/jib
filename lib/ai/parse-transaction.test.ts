import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { CategoryType } from "@/lib/categories";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/openrouter", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/openrouter";
import { parseTransactionWithAI } from "@/lib/ai/parse-transaction";

// No fixture rows exist for this id - lookupUserMapping's findMany just
// returns [] for a non-matching userId, so findMerchant() falls through
// to the global merchant list without needing a real User row.
const NO_MAPPING_USER_ID = 999999;

const CATEGORIES_WITH_SHOPPING: { name: string; type: CategoryType }[] = [
  { name: "خرید", type: "expense" },
  { name: "خرید آنلاین", type: "expense" },
  { name: "سایر", type: "expense" },
];

const CATEGORIES_WITHOUT_SHOPPING: { name: string; type: CategoryType }[] = [
  { name: "سایر", type: "expense" },
];

describe("parseTransactionWithAI", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("resolves fully deterministically on a merchant match with confident amount/date - no AI call", async () => {
    const result = await parseTransactionWithAI(
      NO_MAPPING_USER_ID,
      "دیجی کالا ۲۵۰ هزار تومن",
      CATEGORIES_WITH_SHOPPING
    );

    expect(result).toEqual({
      amount: 250000,
      type: "expense",
      category: "خرید آنلاین",
      description: "دیجی‌کالا",
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      source: "globalMerchant",
    });
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("falls back to AI when the amount can't be confidently extracted", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        amount: 150,
        type: "expense",
        category: "خرید آنلاین",
        description: "خرید از دیجی کالا",
        date: "2026-07-30",
      })
    );

    const result = await parseTransactionWithAI(
      NO_MAPPING_USER_ID,
      "دیجی کالا پنجاه و صد تومن",
      CATEGORIES_WITH_SHOPPING
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.amount).toBe(150);
    expect(result.category).toBe("خرید آنلاین");
    expect(result.source).toBe("globalMerchant"); // still overridden by the merchant match
  });

  it("falls back to AI when the merchant-resolved category fails validation (deleted/renamed category), rather than returning it anyway", async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      JSON.stringify({
        amount: 250000,
        type: "expense",
        category: "سایر",
        description: "خرید از دیجی کالا",
        date: "2026-07-30",
      })
    );

    // Same input as the fully-deterministic test above (merchant matches,
    // amount/date both extract fine) but "خرید"/"خرید آنلاین" are absent
    // from this user's live category list - simulating the category
    // having been deleted or renamed after the merchant list was seeded.
    const result = await parseTransactionWithAI(
      NO_MAPPING_USER_ID,
      "دیجی کالا ۲۵۰ هزار تومن",
      CATEGORIES_WITHOUT_SHOPPING
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.category).toBe("سایر");
    expect(result.source).toBe("ai");
  });
});
