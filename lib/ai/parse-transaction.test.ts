import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/nvidia-ai";
import {
  parseTransactionWithAI,
  FALLBACK_EXPENSE_CATEGORY,
  FALLBACK_INCOME_CATEGORY,
  type CategoryOption,
} from "@/lib/ai/parse-transaction";

// No fixture rows exist for this id - lookupUserMapping's findMany just
// returns [] for a non-matching userId, so findMerchant() falls through
// to the global merchant list without needing a real User row.
const NO_MAPPING_USER_ID = 999999;

const CATEGORIES_WITH_SHOPPING: CategoryOption[] = [
  { name: "خرید", type: "expense" },
  { name: "خرید آنلاین", type: "expense", parentName: "خرید" },
  { name: FALLBACK_EXPENSE_CATEGORY, type: "expense" },
];

const CATEGORIES_WITHOUT_SHOPPING: CategoryOption[] = [{ name: FALLBACK_EXPENSE_CATEGORY, type: "expense" }];

// Fuller fixture for the confidence-bucket tests below: needs a
// hierarchy (parentName) so (category, subcategory) pair validation is
// actually exercised, plus a category with no subcategories at all
// (قبوض و اشتراک), the expense fallback as the low-confidence landing
// spot, and the income fallback for type: "income" cases (e.g. the
// AI-parsed "حقوق" test and the low-confidence income test below).
const CATEGORIES_FULL: CategoryOption[] = [
  { name: "خرید", type: "expense" },
  { name: "خرید آنلاین", type: "expense", parentName: "خرید" },
  { name: "دیجیتال/الکترونیک", type: "expense", parentName: "خرید" },
  { name: "قبوض و اشتراک", type: "expense" },
  { name: FALLBACK_EXPENSE_CATEGORY, type: "expense" },
  { name: "حقوق", type: "income" },
  { name: FALLBACK_INCOME_CATEGORY, type: "income" },
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
        category: FALLBACK_EXPENSE_CATEGORY,
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
    // findMerchant() now returns a hit (دیجی‌کالا -> خرید, category-only,
    // type "expense" - see lib/merchants.ts on why دیجی‌کالا has no default
    // subcategory).
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

      expect(result.category).toBe("خرید");
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

    it("falls back to the income fallback category/bank-sms, unchanged, when the matched merchant's type disagrees with the bank SMS's detected type", async () => {
      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        TEJARAT_SMS_INCOME_WITH_MERCHANT,
        CATEGORIES_FULL
      );

      // bankResult.type is "income" here (دیجی‌کالا's merchant type is
      // "expense", so the override is rejected and buildBankSmsResult falls
      // back on the bank SMS's own type) - this must land on
      // FALLBACK_INCOME_CATEGORY, not the expense fallback, which is exactly
      // the bug fixed in buildBankSmsResult/resolveFallbackCategory.
      expect(result.category).toBe(FALLBACK_INCOME_CATEGORY);
      expect(result.source).toBe("bank-sms");
      expect(result.needsConfirmation).toBe(true);
      expect(result.type).toBe("income");
      expect(chatCompletion).not.toHaveBeenCalled();
    });

    // The "no merchant match at all" case (source === "none") is already
    // covered by "parses a confidently-detected bank SMS deterministically"
    // above - TEJARAT_SMS contains no merchant name, so findMerchant()
    // returns source "none" there and category falls back to
    // FALLBACK_EXPENSE_CATEGORY.

    it("falls back to the expense fallback category/bank-sms, unchanged, when the merchant-resolved category fails validation (deleted/renamed category)", async () => {
      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        TEJARAT_SMS_WITH_MERCHANT,
        CATEGORIES_WITHOUT_SHOPPING
      );

      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
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
      category: "خرید",
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
    expect(result.category).toBe("خرید");
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
    expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
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

    it("falls back to FALLBACK_EXPENSE_CATEGORY when confidence is < 0.50, even though the suggested pair is valid", async () => {
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

      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
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

      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
      expect(result.confidence).toBe(0.9); // raw reported value still surfaced...
      expect(result.needsConfirmation).toBe(true); // ...but never auto-assigned
    });
  });

  describe("newCategorySuggestion (last-resort new-category suggestion)", () => {
    // "دخانیات" ("tobacco") deliberately has no existing category/subcategory
    // in CATEGORIES_FULL, mirroring the last-resort scenario the قوانین
    // section describes - category still safely falls back to
    // FALLBACK_EXPENSE_CATEGORY while newCategorySuggestion carries the
    // additive proposal.
    it("surfaces a well-formed suggestion as suggestedCategory", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 80,
          type: "expense",
          description: "خرید سیگار",
          date: "2026-07-30",
          category: "سایر",
          subcategory: null,
          confidence: 0.3,
          reason: "هیچ دسته‌ی موجودی برای دخانیات مناسب نیست",
          newCategorySuggestion: {
            name: "دخانیات",
            parentName: null,
            reason: "یک مفهوم هزینه‌ی تکرارشونده است که دسته‌ی مجزایی ندارد",
          },
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "سیگار خریدم ۸۰ تومن", CATEGORIES_FULL);

      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
      expect(result.suggestedCategory).toEqual({
        name: "دخانیات",
        parentName: null,
        reason: "یک مفهوم هزینه‌ی تکرارشونده است که دسته‌ی مجزایی ندارد",
        icon: "🚬",
      });
    });

    it("resolves via findSimilarCategory instead when the suggestion actually matches an existing category (here, via alias), overwriting category/subcategory and flagging needsConfirmation rather than attaching suggestedCategory", async () => {
      // "دخانیات" already exists for this user (unlike CATEGORIES_FULL above)
      // - the AI still proposed a "new" category, but under an alias name
      // ("سیگار") of one that's already there, so findSimilarCategory must
      // catch it and win over the AI's own "سایر" guess.
      const categoriesWithDokhaniyat: CategoryOption[] = [...CATEGORIES_FULL, { name: "دخانیات", type: "expense" }];

      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 80,
          type: "expense",
          description: "خرید سیگار",
          date: "2026-07-30",
          category: "سایر",
          subcategory: null,
          confidence: 0.3,
          reason: "هیچ دسته‌ی موجودی برای دخانیات مناسب نیست",
          newCategorySuggestion: {
            name: "سیگار",
            parentName: null,
            reason: "یک مفهوم هزینه‌ی تکرارشونده است",
          },
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "سیگار خریدم ۸۰ تومن", categoriesWithDokhaniyat);

      expect(result.suggestedCategory).toBeUndefined();
      expect(result.category).toBe("دخانیات");
      expect(result.needsConfirmation).toBe(true);
    });

    it("drops a suggestion missing a required field, without throwing", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 80,
          type: "expense",
          description: "خرید سیگار",
          date: "2026-07-30",
          category: "سایر",
          subcategory: null,
          confidence: 0.3,
          reason: "هیچ دسته‌ی موجودی برای دخانیات مناسب نیست",
          newCategorySuggestion: {
            name: "دخانیات",
            // parentName omitted entirely
            reason: "یک مفهوم هزینه‌ی تکرارشونده است",
          },
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "سیگار خریدم ۸۰ تومن", CATEGORIES_FULL);

      expect(result.suggestedCategory).toBeUndefined();
      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
    });

    it("drops a suggestion carrying an extra icon field, without throwing (icon isn't part of this schema)", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 80,
          type: "expense",
          description: "خرید سیگار",
          date: "2026-07-30",
          category: "سایر",
          subcategory: null,
          confidence: 0.3,
          reason: "هیچ دسته‌ی موجودی برای دخانیات مناسب نیست",
          newCategorySuggestion: {
            name: "دخانیات",
            parentName: null,
            reason: "یک مفهوم هزینه‌ی تکرارشونده است",
            icon: "🚬",
          },
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "سیگار خریدم ۸۰ تومن", CATEGORIES_FULL);

      expect(result.suggestedCategory).toBeUndefined();
    });

    it("leaves suggestedCategory as undefined, not null, when the AI omits newCategorySuggestion entirely", async () => {
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

      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        "قبض برق رو پرداخت کردم ۳۵۰ تومن",
        CATEGORIES_FULL
      );

      expect(result.suggestedCategory).toBeUndefined();
    });

    // buildSystemPrompt() itself isn't exported, so its output is captured
  // the same way the rest of this file already exercises the AI path: via
  // the mocked chatCompletion's own call arguments, rather than importing
  // an internal helper or adding a new export.
  describe("few-shot categorization examples in the system prompt (Subtask 5.2)", () => {
    it("includes the confused-category few-shot example lines added in Subtask 5.2", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 100,
          type: "expense",
          category: "سایر",
          subcategory: null,
          description: "تراکنش نامشخص",
          date: "2026-07-30",
          confidence: 0.3,
          reason: "متن مبهم است",
        })
      );

      await parseTransactionWithAI(NO_MAPPING_USER_ID, "یک تراکنش نامشخص", CATEGORIES_FULL);

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      const [messages] = vi.mocked(chatCompletion).mock.calls[0];
      const systemPrompt = messages[0].content;

      expect(systemPrompt).toContain(
        "«نون و ماست خریدم» → category: «خوراک و رستوران»، subcategory: «سوپرمارکت» (نه «رستوران و کافه»، چون خرید برای خانه است نه صرف بیرون از خانه)"
      );
      expect(systemPrompt).toContain("«با دوستام قهوه خوردیم» → category: «خوراک و رستوران»، subcategory: «رستوران و کافه»");
      expect(systemPrompt).toContain(
        "«اسنپ گرفتم برم فرودگاه» → category: «حمل‌ونقل»، subcategory: «تاکسی و اسنپ» (نه «بنزین»، چون اسنپ سرویس تاکسی است نه خرید مستقیم سوخت)"
      );
      expect(systemPrompt).toContain(
        "«قبض اینترنت خونه رو پرداخت کردم» → category: «قبوض و اشتراک»، subcategory: «اینترنت و تلفن» (نه «برق، آب و گاز»، با اینکه هر دو «قبض» هستند)"
      );
      expect(systemPrompt).toContain(
        "«رفتم دکتر و ویزیت دادم» → category: «سلامت»، subcategory: «ویزیت پزشک» (نه «دارو»، چون هزینه ویزیت است نه خرید دارو)"
      );
      expect(systemPrompt).toContain(
        "«حقوق این ماه ریخت» → category: «حقوق» | «بابت یه پروژه فریلنس پول گرفتم» → category: «درآمد آزاد»"
      );
    });
  });

  // Behavioral coverage for the confused-category pairs the Subtask 5.2
  // examples target: not testing the model's own judgment (out of scope for
  // a unit test) - testing that a well-formed AI response naming one of
  // these pairs correctly threads through findValidatedLeafCategory and
  // resolveAiCategory, so a future refactor of that path can't silently
  // regress exactly the pairs the prompt calls out as easy to confuse.
  describe("confused-category pairs from the Subtask 5.2 few-shot examples", () => {
    // None of "سوپرمارکت"/"رستوران"/"تاکسی"/"بنزین"/"اینترنت"/"برق" (unlike
    // e.g. "دیجی کالا" or "اسنپ" elsewhere in this file) match any global
    // merchant name/alias/keywordOverride in lib/merchants.ts, so
    // findMerchant() falls through to source "none" for all three inputs
    // below and the AI's mocked category is what actually resolves - the
    // thing under test here, not a merchant-lookup shortcut.
    const CATEGORIES_FEW_SHOT_PAIRS: CategoryOption[] = [
      { name: "خوراک و رستوران", type: "expense" },
      { name: "سوپرمارکت", type: "expense", parentName: "خوراک و رستوران" },
      { name: "رستوران و کافه", type: "expense", parentName: "خوراک و رستوران" },
      { name: "حمل‌ونقل", type: "expense" },
      { name: "بنزین", type: "expense", parentName: "حمل‌ونقل" },
      { name: "تاکسی و اسنپ", type: "expense", parentName: "حمل‌ونقل" },
      { name: "قبوض و اشتراک", type: "expense" },
      { name: "برق، آب و گاز", type: "expense", parentName: "قبوض و اشتراک" },
      { name: "اینترنت و تلفن", type: "expense", parentName: "قبوض و اشتراک" },
      { name: FALLBACK_EXPENSE_CATEGORY, type: "expense" },
    ];

    it("resolves سوپرمارکت (not رستوران و کافه) for a home-grocery sentence", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 80,
          type: "expense",
          category: "خوراک و رستوران",
          subcategory: "سوپرمارکت",
          description: "نون و ماست",
          date: "2026-07-30",
          confidence: 0.9,
          reason: "خرید مواد غذایی برای خانه است",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "نون و ماست خریدم ۸۰ تومن", CATEGORIES_FEW_SHOT_PAIRS);

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("ai");
      expect(result.category).toBe("سوپرمارکت");
      expect(result.needsConfirmation).toBe(false);
    });

    it("resolves تاکسی و اسنپ (not بنزین) for a taxi-ride sentence", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 120,
          type: "expense",
          category: "حمل‌ونقل",
          subcategory: "تاکسی و اسنپ",
          description: "تاکسی به فرودگاه",
          date: "2026-07-30",
          confidence: 0.9,
          reason: "سرویس تاکسی است نه خرید سوخت",
        })
      );

      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        "برای رفتن به فرودگاه با تاکسی ۱۲۰ تومن دادم",
        CATEGORIES_FEW_SHOT_PAIRS
      );

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("ai");
      expect(result.category).toBe("تاکسی و اسنپ");
      expect(result.needsConfirmation).toBe(false);
    });

    it("resolves اینترنت و تلفن (not برق، آب و گاز) for a home-internet-bill sentence", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 60,
          type: "expense",
          category: "قبوض و اشتراک",
          subcategory: "اینترنت و تلفن",
          description: "قبض اینترنت",
          date: "2026-07-30",
          confidence: 0.9,
          reason: "قبض اینترنت خانه است نه برق/آب/گاز",
        })
      );

      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        "قبض اینترنت خونه رو پرداخت کردم ۶۰ تومن",
        CATEGORIES_FEW_SHOT_PAIRS
      );

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(result.source).toBe("ai");
      expect(result.category).toBe("اینترنت و تلفن");
      expect(result.needsConfirmation).toBe(false);
    });
  });

  it("drops an explicit null newCategorySuggestion the same way as an omitted one", async () => {
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
          newCategorySuggestion: null,
        })
      );

      const result = await parseTransactionWithAI(
        NO_MAPPING_USER_ID,
        "قبض برق رو پرداخت کردم ۳۵۰ تومن",
        CATEGORIES_FULL
      );

      expect(result.suggestedCategory).toBeUndefined();
    });
  });

  // Guards against the exact bug fixed for the bare "سایر" fallback:
  // FALLBACK_EXPENSE_CATEGORY/FALLBACK_INCOME_CATEGORY (see
  // resolveFallbackCategory in parse-transaction.ts) must exactly match
  // real seeded DefaultCategory names (prisma/seed.ts), or
  // createTransaction's exact-name lookup throws InvalidCategoryError for
  // every transaction landing on the fallback. Checked against the live
  // DefaultCategory table - the actual seed source - rather than a
  // hardcoded expected string, so a future rename on either side still
  // gets caught instead of two copies of the same typo agreeing with each
  // other (same pattern as lib/merchant-lookup.test.ts's اسنپ/تپسی guard).
  describe("fallback categories resolve to real seeded DefaultCategory names", () => {
    it("a low-confidence AI expense parse's fallback category matches a real seeded DefaultCategory", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 40,
          type: "expense",
          description: "خرید نامشخص",
          date: "2026-07-30",
          category: "این دسته وجود ندارد",
          subcategory: null,
          confidence: 0.2,
          reason: "متن مبهم است و نمی‌توان با اطمینان دسته را تعیین کرد",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "یه چیز نامشخصی خریدم ۴۰ تومن", CATEGORIES_FULL);

      expect(result.type).toBe("expense");
      const seeded = await prisma.defaultCategory.findFirst({
        where: { name: result.category, type: "expense" },
      });
      expect(seeded).not.toBeNull();
    });

    it("a low-confidence AI income parse's fallback category matches a real seeded DefaultCategory", async () => {
      vi.mocked(chatCompletion).mockResolvedValue(
        JSON.stringify({
          amount: 500,
          type: "income",
          description: "دریافتی نامشخص",
          date: "2026-07-30",
          category: "این دسته وجود ندارد",
          subcategory: null,
          confidence: 0.2,
          reason: "متن مبهم است و نمی‌توان با اطمینان دسته را تعیین کرد",
        })
      );

      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, "یه پول نامشخصی گرفتم ۵۰۰ تومن", CATEGORIES_FULL);

      expect(result.type).toBe("income");
      const seeded = await prisma.defaultCategory.findFirst({
        where: { name: result.category, type: "income" },
      });
      expect(seeded).not.toBeNull();
    });

    it("a bank-SMS parse result's fallback category matches a real seeded DefaultCategory", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, TEJARAT_SMS, CATEGORIES_FULL);

      expect(result.source).toBe("bank-sms");
      const seeded = await prisma.defaultCategory.findFirst({
        where: { name: result.category, type: result.type },
      });
      expect(seeded).not.toBeNull();
    });
  });
});
