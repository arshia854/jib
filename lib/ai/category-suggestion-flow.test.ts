import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveNewCategoryIcon, type CategoryType } from "@/lib/categories";
import { listCategories } from "@/lib/data/categories";
import { updateTransaction } from "@/lib/data/transactions";
import { findMerchant } from "@/lib/merchant-lookup";

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { chatCompletion } from "@/lib/nvidia-ai";
import { getSession } from "@/lib/auth/session";
import { parseTransactionWithAI, FALLBACK_EXPENSE_CATEGORY, type CategoryOption } from "@/lib/ai/parse-transaction";
import { POST } from "@/app/api/categories/route";

const mockedGetSession = vi.mocked(getSession);

function makeCategoryRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-CATEGORY-SUGGESTION-FLOW-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return user.id;
}

// Merchant mappings and child categories before their parent, transactions
// before their category - same FK (onDelete: Restrict) ordering already
// established in app/api/categories/route.test.ts and lib/data/transactions.test.ts.
async function cleanupUser(userId: number) {
  await prisma.merchantMapping.deleteMany({ where: { userId } });
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

// Mirrors the exact CategoryOption[] construction used by the real callers
// of parseTransactionWithAI (app/api/transactions/parse/route.ts) and of
// findSimilarCategory (app/api/categories/route.ts) - loaded fresh wherever
// the flow below needs to observe a just-created category.
async function loadCategoryOptions(userId: number): Promise<CategoryOption[]> {
  const categories = await listCategories(userId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return categories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
  }));
}

describe("category-suggestion pipeline (Phase 10 integration)", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("suggestion -> category creation -> merchant learning -> deterministic re-resolution", () => {
    let userId: number;
    let accountId: number;
    let sayerCategoryId: number;
    const rawInput = "سیگار از دکه کوروش ۸۰ هزار تومن";

    beforeAll(async () => {
      userId = await createTestUser("main-flow");
      const account = await prisma.financeAccount.create({
        data: { userId, name: "حساب تست جریان دسته‌بندی", type: "cash" },
      });
      accountId = account.id;
      const sayer = await prisma.category.create({
        data: { userId, name: FALLBACK_EXPENSE_CATEGORY, icon: "📦", color: "#64748B", type: "expense" },
      });
      sayerCategoryId = sayer.id;
    });

    afterAll(async () => {
      await cleanupUser(userId);
    });

    it("parses an unrecognized merchant into a newCategorySuggestion, creates the category, learns the merchant on confirmation, then resolves deterministically without a second AI call", async () => {
      // This walks the full pipeline (2 parses, 1 route call, 1 direct
      // transaction write, 1 updateTransaction) in one test, so it needs
      // more headroom than vitest's 5000ms default under concurrent
      // test-file load against the real DB.
      // Step 1: unrecognized merchant + concept with no fitting existing
      // category - the AI's only escape hatch is newCategorySuggestion;
      // category itself still falls back to FALLBACK_EXPENSE_CATEGORY
      // (buildSystemPrompt's قوانین tells the AI to emit the bare "سایر"
      // string here, which resolveAiCategory then treats as an invalid/
      // unmatched category regardless of confidence, landing on the real
      // fallback name).
      vi.mocked(chatCompletion).mockResolvedValueOnce(
        JSON.stringify({
          amount: 80000,
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
          },
        })
      );

      const categoriesBeforeCreation = await loadCategoryOptions(userId);
      const firstParse = await parseTransactionWithAI(userId, rawInput, categoriesBeforeCreation);

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(firstParse.category).toBe(FALLBACK_EXPENSE_CATEGORY);
      expect(firstParse.suggestedCategory).toEqual({
        name: "دخانیات",
        parentName: null,
        reason: "یک مفهوم هزینه‌ی تکرارشونده است",
        icon: resolveNewCategoryIcon("دخانیات"),
      });

      // Step 2: accepting the suggestion goes through the real route.
      mockedGetSession.mockResolvedValue(asSession(userId));
      const countBeforeCreate = await prisma.category.count({ where: { userId } });

      const createRes = await POST(
        makeCategoryRequest({
          name: firstParse.suggestedCategory!.name,
          type: firstParse.type,
          parentName: firstParse.suggestedCategory!.parentName,
          source: "ai-suggestion",
        })
      );
      expect(createRes.status).toBe(201);
      const createData = await createRes.json();
      expect(createData.resolvedExisting).toBe(false);
      expect(createData.category.icon).toBe(resolveNewCategoryIcon("دخانیات"));

      const countAfterCreate = await prisma.category.count({ where: { userId } });
      expect(countAfterCreate).toBe(countBeforeCreate + 1);

      const newCategoryId: number = createData.category.id;
      const newCategoryName: string = createData.category.name;

      // Step 3: simulate confirming the suggestion on the actual transaction -
      // create it with the AI's fallback category (as parseTransactionWithAI
      // returned it), then edit it to the newly created category. Per
      // lib/data/transactions.ts's updateTransaction (the Subtask 10.7
      // write path), an edit that changes the category on a transaction with
      // non-empty rawInput is exactly what upserts the learned MerchantMapping.
      const createdTxn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId: sayerCategoryId,
          amount: firstParse.amount,
          type: firstParse.type,
          description: firstParse.description,
          rawInput,
          date: new Date(firstParse.date),
        },
      });

      const updatedTxn = await updateTransaction(userId, createdTxn.id, {
        amount: firstParse.amount,
        type: firstParse.type,
        categoryName: newCategoryName,
        accountId,
        date: new Date(firstParse.date),
      });
      expect(updatedTxn.categoryId).toBe(newCategoryId);

      const learned = await findMerchant(userId, rawInput);
      expect(learned.source).toBe("userMapping");
      expect(learned.category).toBe(newCategoryName);
      expect(learned.type).toBe("expense");

      // Step 4: the same merchant text, parsed again, resolves via the
      // learned mapping - deterministically, with no further AI call.
      const categoriesAfterCreation = await loadCategoryOptions(userId);
      const secondParse = await parseTransactionWithAI(userId, rawInput, categoriesAfterCreation);

      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(secondParse.source).toBe("userMapping");
      expect(secondParse.category).toBe(newCategoryName);
      expect(secondParse.needsConfirmation).toBe(false);
      expect(secondParse.confidence).toBe(1);
      expect(secondParse.amount).toBe(80000);
    }, 20000);
  });

  describe("newCategorySuggestion resolving to an existing category via alias", () => {
    let userId: number;
    let dokhaniyatId: number;

    beforeAll(async () => {
      userId = await createTestUser("alias-match");
      await prisma.category.create({
        data: { userId, name: FALLBACK_EXPENSE_CATEGORY, icon: "📦", color: "#64748B", type: "expense" },
      });
      const dokhaniyat = await prisma.category.create({
        data: { userId, name: "دخانیات", icon: "🚬", color: "#64748B", type: "expense" },
      });
      dokhaniyatId = dokhaniyat.id;
    });

    afterAll(async () => {
      await cleanupUser(userId);
    });

    it("never surfaces suggestedCategory or creates a category - resolves to the matched existing category with needsConfirmation, and the route independently agrees (200, resolvedExisting, no new row)", async () => {
      vi.mocked(chatCompletion).mockResolvedValueOnce(
        JSON.stringify({
          amount: 50000,
          type: "expense",
          description: "خرید سیگار",
          date: "2026-07-30",
          category: "سایر",
          subcategory: null,
          confidence: 0.3,
          reason: "هیچ دسته‌ی موجودی برای دخانیات مناسب نیست",
          newCategorySuggestion: {
            name: "سیگار", // alias of "دخانیات" per lib/category-aliases.ts
            parentName: null,
            reason: "یک مفهوم هزینه‌ی تکرارشونده است",
          },
        })
      );

      const categories = await loadCategoryOptions(userId);
      const result = await parseTransactionWithAI(userId, "سیگار از بقالی محل ۵۰ هزار تومن", categories);

      expect(result.suggestedCategory).toBeUndefined();
      expect(result.category).toBe("دخانیات");
      expect(result.needsConfirmation).toBe(true);

      // The route's own independent findSimilarCategory call agrees: 200 +
      // resolvedExisting, no new row - proving both call sites of
      // findSimilarCategory (inside parseTransactionWithAI and inside the
      // route) treat this suggestion identically.
      mockedGetSession.mockResolvedValue(asSession(userId));
      const countBefore = await prisma.category.count({ where: { userId } });

      const res = await POST(
        makeCategoryRequest({ name: "سیگار", type: "expense", parentName: null, source: "ai-suggestion" })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resolvedExisting).toBe(true);
      expect(data.category.id).toBe(dokhaniyatId);

      const countAfter = await prisma.category.count({ where: { userId } });
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("bank-sms input never reaches the AI category-suggestion path", () => {
    // Same fixture/rationale as lib/ai/parse-transaction.test.ts's
    // TEJARAT_SMS: bank + amount + type all resolve deterministically, so
    // parseBankSms succeeds and parseTransactionWithAI returns before ever
    // reaching findMerchant's "no match" fallback or the AI call.
    const TEJARAT_SMS = `بانک تجارت
حساب:0145059220990
برداشت:1,500,000 ریال
از طريق: شتاب
مانده:134,866 ریال`;

    // No fixture rows exist for this id, so findMerchant's lookupUserMapping
    // just returns [] - no real User/Category DB rows are needed at all
    // here. The in-memory categories array below still needs
    // FALLBACK_EXPENSE_CATEGORY present, though: buildBankSmsResult never
    // uses it to resolve the category (that's always
    // resolveFallbackCategory(bankResult.type)), but it does read the list
    // for warnIfFallbackCategoryMissing's dev-only sanity check, and an
    // empty list would otherwise trip that warning here for no reason.
    const NO_MAPPING_USER_ID = 999999;

    it("resolves deterministically via parseBankSms, confirming chatCompletion is never called end-to-end", async () => {
      const result = await parseTransactionWithAI(NO_MAPPING_USER_ID, TEJARAT_SMS, [
        { name: FALLBACK_EXPENSE_CATEGORY, type: "expense" },
      ]);

      expect(result.source).toBe("bank-sms");
      expect(result.category).toBe(FALLBACK_EXPENSE_CATEGORY);
      expect(result.needsConfirmation).toBe(true);
      expect(chatCompletion).not.toHaveBeenCalled();
    });
  });

  describe("rate limit boundary (ai-suggestion source only), exercised through the real route", () => {
    let userId: number;

    // MAX_CATEGORIES_PER_24H in app/api/categories/route.ts is 10 and not
    // exported - mirrored here as a literal, same as
    // app/api/categories/route.test.ts's own FILLER_CATEGORY_NAMES. 9
    // distinct, non-overlapping single-word fillers (no shared tokens, so
    // none can trip findSimilarCategory's token-overlap fallback against
    // each other) plus one more ai-suggestion create below reaches exactly
    // the 10th.
    const FILLER_NAMES = ["سیب", "پرتقال", "موز", "انگور", "هلو", "گلابی", "آلبالو", "زردآلو", "انار"];

    beforeAll(async () => {
      userId = await createTestUser("rate-limit");
      for (const name of FILLER_NAMES) {
        await prisma.category.create({ data: { userId, name, icon: "🧪", color: "#64748B", type: "expense" } });
      }
    });

    afterAll(async () => {
      await cleanupUser(userId);
    });

    it("allows the 10th ai-suggestion creation (== MAX_CATEGORIES_PER_24H) within the window", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(
        makeCategoryRequest({ name: "کیوی", type: "expense", parentName: null, source: "ai-suggestion" })
      );
      expect(res.status).toBe(201);
    });

    it("rejects the 11th ai-suggestion creation within 24h with 429 and the expected Persian message", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(
        makeCategoryRequest({ name: "نارگیل", type: "expense", parentName: null, source: "ai-suggestion" })
      );
      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.error).toBe(
        "در ۲۴ ساعت گذشته دسته‌بندی زیادی ساخته‌اید؛ لطفاً از دسته‌های موجود استفاده کنید."
      );
    });

    it("still allows a manual-source creation for the same user in the same window - the limit is source-scoped", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(
        makeCategoryRequest({
          name: "دسته دستی هنگام محدودیت پایپ‌لاین",
          type: "expense",
          icon: "🎯",
          color: "#3B82F6",
        })
      );
      expect(res.status).toBe(201);
    });
  });
});
