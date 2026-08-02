import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/arvan-ai", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/arvan-ai";
import { parseTransactionWithAI, type CategoryOption } from "@/lib/ai/parse-transaction";

// No fixture rows exist for this id - lookupUserMapping's findMany just
// returns [] for a non-matching userId, so findMerchant() falls through
// to the global merchant list without needing a real User row.
const NO_MAPPING_USER_ID = 999999;

const CATEGORIES_WITH_SHOPPING: CategoryOption[] = [
  { name: "خرید", type: "expense" },
  { name: "خرید آنلاین", type: "expense", parentName: "خرید" },
  { name: "سایر", type: "expense" },
];

const CATEGORIES_WITHOUT_SHOPPING: CategoryOption[] = [{ name: "سایر", type: "expense" }];

// Fuller fixture for the confidence-bucket tests below: needs a
// hierarchy (parentName) so (category, subcategory) pair validation is
// actually exercised, plus a category with no subcategories at all
// (قبوض و اشتراک) and سایر as the low-confidence landing spot.
const CATEGORIES_FULL: CategoryOption[] = [
  { name: "خرید", type: "expense" },
  { name: "خرید آنلاین", type: "expense", parentName: "خرید" },
  { name: "دیجیتال/الکترونیک", type: "expense", parentName: "خرید" },
  { name: "قبوض و اشتراک", type: "expense" },
  { name: "سایر", type: "expense" },
];

// Reused verbatim from lib/bank/parse-bank-sms.test.ts - see that file's own
// provenance note (plausible/representative fixtures, not verified copies
// of actual received SMS).
const TEJARAT_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طريق: شتاب
مانده:134,866 ریال`;

const SEPAH_SMS = `بانک سپه
خريد پايانه فروش: 9,278,200
حساب :543133176713291
مانده:63,096,472`;

const BLU_SMS = `بلو
برداشت پول
علی عزیز، 7,000,000 ریال از حساب شما پرید.
موجودی:17,192,269`;

// Same fixture as parse-bank-sms.test.ts's TEJARAT_TYPE_AMBIGUOUS_SMS: bank
// and amount both resolve, but "برداشت" (expense) and "انتقال" (income) both
// appear, so extractBankType bails to null and parseBankSms returns null -
// used here to exercise parseTransactionWithAI's fallback to the AI path.
const TEJARAT_TYPE_AMBIGUOUS_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
انتقال به حساب دیگر
از طریق: شتاب
مانده:134,866 ریال`;

describe("parseTransactionWithAI", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("bank SMS detection", () => {
    it("parses a confidently-detected bank SMS deterministically, without calling the AI", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, TEJARAT_SMS, CATEGORIES_FULL);

      expect(result).toEqual({
        amount: 150000,
        type: "expense",
        category: "سایر",
        description: expect.any(String),
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        source: "bank-sms",
        bank: "tejarat",
        bankConfidence: 1,
        needsConfirmation: true,
      });
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it("parses a second bank's SMS (Sepah, same-line label between keyword and amount)", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, SEPAH_SMS, CATEGORIES_FULL);

      expect(result.source).toBe("bank-sms");
      expect(result.bank).toBe("sepah");
      expect(result.amount).toBe(9278200);
      expect(result.type).toBe("expense");
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it("parses a third bank's SMS (Blu, narrative debit phrasing, rial converted to toman)", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, BLU_SMS, CATEGORIES_FULL);

      expect(result.source).toBe("bank-sms");
      expect(result.bank).toBe("blu");
      expect(result.amount).toBe(700000);
      expect(result.type).toBe("expense");
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it("falls back to the AI/merchant path when a bank is detected but parsing is incomplete (ambiguous type)", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 150000,
          type: "expense",
          category: "سایر",
          description: "انتقال بانکی",
          date: "2026-07-30",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, TEJARAT_TYPE_AMBIGUOUS_SMS, CATEGORIES_FULL);

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("ai");
      expect(result.bank).toBeUndefined();
      expect(result.amount).toBe(150000);
    });
  });

  describe("merchant override on a matched bank SMS", () => {
    // TEJARAT_SMS above with a recognizable global-merchant name added as
    // its own line - doesn't touch the "برداشت:"/"از طريق"/"شتاب" tokens
    // the bank engine keys off (see extract-bank-amount.ts/detect-bank.ts),
    // so bank/amount/type detection stays identical to TEJARAT_SMS; only
    // findMerchant() now returns a hit (دیجی‌کالا -> خرید/خرید آنلاین,
    // type "expense").
    const TEJARAT_SMS_WITH_MERCHANT = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
دیجی کالا
از طريق: شتاب
مانده:134,866 ریال`;

    // Same fixture with "واریز" (income) swapped in for "برداشت" (expense).
    // Bank and amount detection stay the same (واریز is also a direct
    // transaction keyword in extract-bank-amount.ts), but the resolved
    // type flips to "income", which no longer agrees with دیجی‌کالا's
    // "expense" merchant type below.
    const TEJARAT_SMS_INCOME_WITH_MERCHANT = `بانک تجارت
حساب:0145059220990
واریز:1,500,000 ریال
دیجی کالا
از طريق: شتاب
مانده:134,866 ریال`;

    it("overrides the category when the matched merchant's type agrees with the bank SMS's detected type", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, TEJARAT_SMS_WITH_MERCHANT, CATEGORIES_FULL);

      expect(result.category).toBe("خرید آنلاین");
      expect(result.source).toBe("globalMerchant");
      expect(result.needsConfirmation).toBe(false);
      // Unaffected by the override - still whatever buildBankSmsResult
      // alone would have produced from the bank engine.
      expect(result.amount).toBe(150000);
      expect(result.type).toBe("expense");
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.bank).toBe("tejarat");
      expect(result.bankConfidence).toBe(1);
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    it("falls back to سایر/bank-sms, unchanged, when the matched merchant's type disagrees with the bank SMS's detected type", async () => {
      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        TEJARAT_SMS_INCOME_WITH_MERCHANT,
        CATEGORIES_FULL
      );

      expect(result.category).toBe("سایر");
      expect(result.source).toBe("bank-sms");
      expect(result.needsConfirmation).toBe(true);
      expect(result.type).toBe("income");
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    // The "no merchant match at all" case (source === "none") is already
    // covered by "parses a confidently-detected bank SMS deterministically"
    // above - TEJARAT_SMS contains no merchant name, so findMerchant()
    // returns source "none" there and category falls back to سایر.

    it("falls back to سایر/bank-sms, unchanged, when the merchant-resolved category fails validation (deleted/renamed category)", async () => {
      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        TEJARAT_SMS_WITH_MERCHANT,
        CATEGORIES_WITHOUT_SHOPPING
      );

      expect(result.category).toBe("سایر");
      expect(result.source).toBe("bank-sms");
      expect(result.needsConfirmation).toBe(true);
      expect(chatCompletion).not.toHaveBeenCalled();
    });
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
      confidence: 1,
      needsConfirmation: false,
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

  describe("confidence handling (AI's own category decision, no merchant match)", () => {
    it("auto-assigns the category when confidence >= 0.80", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 350,
          type: "expense",
          description: "قبض برق",
          date: "2026-07-30",
          category: "قبوض و اشتراک",
          subcategory: null,
          confidence: 0.95,
          reason: "عبارت 'قبض برق' مستقیماً به دسته قبوض و اشتراک اشاره دارد",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "قبض برق رو پرداخت کردم ۳۵۰ تومن", CATEGORIES_FULL);

      expect(result.category).toBe("قبوض و اشتراک");
      expect(result.confidence).toBe(0.95);
      expect(result.needsConfirmation).toBe(false);
      expect(result.source).toBe("ai");
    });

    it("assigns the category but flags needsConfirmation when confidence is 0.50-0.79", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 120,
          type: "expense",
          description: "خرید از فروشگاه",
          date: "2026-07-30",
          category: "خرید",
          subcategory: "خرید آنلاین",
          confidence: 0.65,
          reason: "نام فروشگاه نامشخص است اما لحن متن به خرید آنلاین شبیه است",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "پرداخت به فروشگاه ناشناس ۱۲۰ تومن", CATEGORIES_FULL);

      expect(result.category).toBe("خرید آنلاین");
      expect(result.confidence).toBe(0.65);
      expect(result.needsConfirmation).toBe(true);
    });

    it("falls back to سایر when confidence is < 0.50, even though the suggested pair is valid", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 40,
          type: "expense",
          description: "خرید نامشخص",
          date: "2026-07-30",
          category: "خرید",
          subcategory: "دیجیتال/الکترونیک",
          confidence: 0.35,
          reason: "متن مبهم است و نمی‌توان با اطمینان دسته را تعیین کرد",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "یه چیزی خریدم ۴۰ تومن", CATEGORIES_FULL);

      expect(result.category).toBe("سایر");
      expect(result.confidence).toBe(0.35); // raw reported value preserved for observability
      expect(result.needsConfirmation).toBe(true);
    });

    it("treats a hallucinated (nonexistent) category as confidence 0, regardless of the AI's self-reported confidence", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 90,
          type: "expense",
          description: "خرید عجیب",
          date: "2026-07-30",
          category: "خوراکی‌های خارجی", // not a real category
          subcategory: null,
          confidence: 0.9,
          reason: "این یک دلیل ساختگی است",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "خرید عجیب ۹۰ تومن", CATEGORIES_FULL);

      expect(result.category).toBe("سایر");
      expect(result.confidence).toBe(0.9); // raw reported value still surfaced...
      expect(result.needsConfirmation).toBe(true); // ...but never auto-assigned
    });
  });
});
