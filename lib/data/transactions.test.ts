import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { toJalaali } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { buildMerchantKey, findMerchant } from "@/lib/merchant-lookup";
import {
  updateTransaction,
  createTransaction,
  getTransaction,
  deleteTransaction,
  listTransactions,
  applyTransactionEnrichment,
  applySuggestedCategory,
  dismissSuggestedCategory,
  markEnrichmentFailed,
  TransactionNotFoundError,
  InvalidAccountError,
} from "@/lib/data/transactions";
import { DEFAULT_TRANSACTIONS_PAGE_SIZE, MAX_TRANSACTIONS_PAGE_SIZE } from "@/lib/limits";
import { FALLBACK_INCOME_CATEGORY } from "@/lib/categories";

// Independent re-implementation of lib/analytics/spending-summary.ts's
// private monthKeyFor() - deliberately not imported, so these tests prove
// the cache row keyed the way SpendingSummaryCache is actually queried
// elsewhere gets removed, rather than just trusting the same helper the
// production code itself uses internally.
function jalaaliMonthKey(date: Date): string {
  const { jy, jm } = toJalaali(date);
  return `${jy}-${String(jm).padStart(2, "0")}`;
}

describe("updateTransaction (merchant-mapping learning)", () => {
  let userId: number;
  let accountId: number;
  let categoryAId: number;
  let categoryBId: number;
  const categoryAName = "دسته الف تست";
  const categoryBName = "دسته ب تست";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-UPDATE-TRANSACTION-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const categoryA = await prisma.category.create({
      data: { userId, name: categoryAName, icon: "🧪", color: "#000000", type: "expense" },
    });
    categoryAId = categoryA.id;

    const categoryB = await prisma.category.create({
      data: { userId, name: categoryBName, icon: "🧪", color: "#111111", type: "expense" },
    });
    categoryBId = categoryB.id;
  });

  afterAll(async () => {
    await prisma.merchantMapping.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("creates a MerchantMapping when the category changes on a transaction with non-empty rawInput", async () => {
    const rawInput = "فروشگاه یک ۵۰۰۰۰";
    const merchantKey = buildMerchantKey(rawInput);

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 50000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-01"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 60000,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      description: "خرید یک",
      date: new Date("2026-01-02"),
    });

    expect(updated.amount).toBe(60000);
    expect(updated.description).toBe("خرید یک");
    expect(updated.date.toISOString()).toBe(new Date("2026-01-02").toISOString());
    expect(updated.categoryId).toBe(categoryBId);
    expect(updated.category.name).toBe(categoryBName);

    const mapping = await prisma.merchantMapping.findUnique({
      where: { userId_merchantKey: { userId, merchantKey } },
    });
    expect(mapping).not.toBeNull();
    expect(mapping?.categoryId).toBe(categoryBId);
  });

  it("updates (not duplicates) an existing MerchantMapping when a later change resolves to the same merchantKey", async () => {
    const rawInput = "کافه دو ۲۰۰۰۰";
    const merchantKey = buildMerchantKey(rawInput);

    await prisma.merchantMapping.create({
      data: { userId, merchantKey, categoryId: categoryAId },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 20000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-03"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 20000,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      date: new Date("2026-01-03"),
    });

    expect(updated.categoryId).toBe(categoryBId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey } });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].categoryId).toBe(categoryBId);
  });

  it("leaves MerchantMapping untouched when the category is unchanged", async () => {
    const rawInput = "سوپرمارکت سه ۱۰۰۰۰";
    const merchantKey = buildMerchantKey(rawInput);

    const existingMapping = await prisma.merchantMapping.create({
      data: { userId, merchantKey, categoryId: categoryBId },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 10000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-04"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 15000,
      type: "expense",
      categoryName: categoryAName,
      accountId,
      description: "بدون تغییر دسته",
      date: new Date("2026-01-05"),
    });

    expect(updated.amount).toBe(15000);
    expect(updated.description).toBe("بدون تغییر دسته");
    expect(updated.date.toISOString()).toBe(new Date("2026-01-05").toISOString());
    expect(updated.categoryId).toBe(categoryAId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey } });
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toEqual(existingMapping);
  });

  it("does not create or modify a MerchantMapping when rawInput is empty, even if the category changes", async () => {
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 5000,
        type: "expense",
        rawInput: "",
        date: new Date("2026-01-06"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 5500,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      date: new Date("2026-01-07"),
    });

    expect(updated.amount).toBe(5500);
    expect(updated.categoryId).toBe(categoryBId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey: "" } });
    expect(mappings).toHaveLength(0);
  });

  // Regression (docs/roadmap-status.md, Phase 7/8 correction): merchantKey
  // used to be normalizeText(rawInput) verbatim, amount digits included, so
  // a learned mapping only ever re-matched a *later* transaction quoting
  // the exact same amount - defeating the feature for ordinary
  // variable-amount purchases at the same merchant. buildMerchantKey
  // (lib/merchant-lookup.ts) now strips amount digits before the key is
  // stored, so this must resolve via userMapping even though the amount
  // below ("۷۵۰۰۰") never appears anywhere in the corrected transaction.
  it("resolves via userMapping for a later transaction at the same merchant with a different amount", async () => {
    const rawInput = "فروشگاه پنج ۴۰۰۰۰";

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 40000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-08"),
      },
    });

    // The one real "learning" step - a single correction.
    await updateTransaction(userId, txn.id, {
      amount: 40000,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      date: new Date("2026-01-08"),
    });

    const result = await findMerchant(userId, "فروشگاه پنج ۷۵۰۰۰ تومن خریدم");
    expect(result.source).toBe("userMapping");
    expect(result.category).toBe(categoryBName);
  });
});

// Covers the new Transaction.source column (see prisma/migrations/
// 20260808153511_add_transaction_source and schema.prisma) - the chat
// assistant's suggest_transaction confirm/edit flow is the only caller that
// ever passes a source today (both going through this same createTransaction
// call - see app/api/chat/route.ts and components/transactions/
// add-transaction-form.tsx's initialTransaction path), so this exercises
// the field directly rather than only indirectly through those UIs.
describe("createTransaction (source field)", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-CREATE-TRANSACTION-SOURCE-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "دسته تست منبع", icon: "🧪", color: "#222222", type: "expense" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("stores source when explicitly passed", async () => {
    const created = await createTransaction(userId, {
      amount: 80000,
      type: "expense",
      categoryName: "دسته تست منبع",
      accountId,
      description: "اسنپ",
      rawInput: "دیروز ۸۰ تومن اسنپ گرفتم",
      date: new Date("2026-08-07"),
      source: "assistant-suggestion",
    });

    expect(created.source).toBe("assistant-suggestion");
  });

  it("leaves source null for the ordinary manual-entry path (no source passed)", async () => {
    const created = await createTransaction(userId, {
      amount: 50000,
      type: "expense",
      categoryName: "دسته تست منبع",
      accountId,
      description: "ناهار",
      rawInput: "۵۰ تومن ناهار",
      date: new Date("2026-08-07"),
    });

    expect(created.source).toBeNull();
  });
});

// Turso latency fix (docs/roadmap-status.md): both branches of
// createTransaction() used to call `prisma.transaction.create({ data,
// include: { category: true } })` - re-fetching the exact category row
// already loaded a few lines above (accountAndCategoryLookup) inside the
// same function call. Both now create without that include and attach the
// already-fetched category object by hand - this proves the returned
// `.category` is still byte-identical to what the old include would have
// produced, for both the with-asset and without-asset branches.
describe("createTransaction (category shape - redundant include removal)", () => {
  let userId: number;
  let accountId: number;
  const categoryName = "دسته تست شکل خروجی";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-CREATE-TRANSACTION-CATEGORY-SHAPE-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست شکل خروجی", type: "cash" },
    });
    accountId = account.id;

    await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#444444", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns a .category identical to what include: { category: true } would produce (no asset purchase)", async () => {
    const created = await createTransaction(userId, {
      amount: 45000,
      type: "expense",
      categoryName,
      accountId,
      rawInput: "تست شکل خروجی بدون دارایی",
      date: new Date("2026-08-07"),
    });

    const viaInclude = await prisma.transaction.findUniqueOrThrow({
      where: { id: created.id },
      include: { category: true },
    });
    expect(created.category).toEqual(viaInclude.category);
  });

  it("returns a .category identical to what include: { category: true } would produce (with asset purchase)", async () => {
    const created = await createTransaction(userId, {
      amount: 500000,
      type: "expense",
      categoryName,
      accountId,
      rawInput: "تست شکل خروجی با دارایی",
      date: new Date("2026-08-07"),
      assetPurchase: { type: "gold", quantity: 1, purchasePricePerUnit: 500000 },
    });

    expect(created.asset).not.toBeNull();

    const viaInclude = await prisma.transaction.findUniqueOrThrow({
      where: { id: created.id },
      include: { category: true },
    });
    expect(created.category).toEqual(viaInclude.category);
  });
});

// SEC-10 (docs/roadmap-status.md): idempotency protection on transaction
// creation, deliberately deferred out of Phase 5 (see that phase's own
// "Explicitly not touched" note) and implemented here.
describe("createTransaction (idempotency - SEC-10)", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-CREATE-TRANSACTION-IDEMPOTENCY-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست idempotency", type: "cash" },
    });
    accountId = account.id;

    await prisma.category.create({
      data: { userId, name: "دسته تست idempotency", icon: "🧪", color: "#333333", type: "expense" },
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const baseInput = {
    amount: 10000,
    type: "expense" as const,
    categoryName: "دسته تست idempotency",
    description: "تست",
    rawInput: "تست idempotency",
    date: new Date("2026-08-10"),
  };

  it("creates normally when no idempotencyKey is given (existing behavior, unchanged)", async () => {
    const first = await createTransaction(userId, { ...baseInput, accountId });
    const second = await createTransaction(userId, { ...baseInput, accountId });

    expect(first.id).not.toBe(second.id);
    const count = await prisma.transaction.count({
      where: { userId, id: { in: [first.id, second.id] } },
    });
    expect(count).toBe(2);
  });

  it("creates normally on a first-seen idempotencyKey", async () => {
    const key = `test-key-${Date.now()}-a`;
    const created = await createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key });

    expect(created.idempotencyKey).toBe(key);
    expect(created.amount).toBe(10000);
  });

  it("returns the same row (no second insert) when the same key is reused", async () => {
    const key = `test-key-${Date.now()}-b`;
    const first = await createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key });
    // Different content on purpose - proves the replay branch short-circuits
    // before even looking at the rest of the input, matching the documented
    // "return the existing transaction... rather than erroring or
    // duplicating" behavior, not a content-diff/merge.
    const second = await createTransaction(userId, {
      ...baseInput,
      accountId,
      idempotencyKey: key,
      amount: 999999,
      description: "مقدار متفاوت",
    });

    expect(second.id).toBe(first.id);
    expect(second.amount).toBe(first.amount);

    const rows = await prisma.transaction.findMany({ where: { userId, idempotencyKey: key } });
    expect(rows).toHaveLength(1);
  });

  // Turso latency fix (docs/roadmap-status.md): createTransaction() used to
  // read-first (`prisma.transaction.findFirst` by {userId, idempotencyKey})
  // before ever attempting the insert - a replay never reached
  // `prisma.transaction.create` at all under that path. Now it goes straight
  // to the insert attempt and lets the catch block's unique-constraint
  // handling do the dedup - this proves that shape directly (not just the
  // end result the test above already covers): exactly one (failing) create
  // attempt, then exactly one refetch, no upfront read.
  it("a replay takes exactly one insert-then-refetch path, not a read-first-then-maybe-insert one", async () => {
    const key = `test-key-${Date.now()}-single-path`;
    const first = await createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key });

    const createSpy = vi.spyOn(prisma.transaction, "create");
    const findFirstSpy = vi.spyOn(prisma.transaction, "findFirst");

    const second = await createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key });

    expect(second.id).toBe(first.id);
    // The insert is actually attempted (and fails on the unique index) - the
    // old read-first code never reached this call at all for a replay.
    expect(createSpy).toHaveBeenCalledTimes(1);
    // Exactly one refetch (the catch block's), not an upfront read plus a
    // second lookup.
    expect(findFirstSpy).toHaveBeenCalledTimes(1);

    createSpy.mockRestore();
    findFirstSpy.mockRestore();
  });

  it("scopes the key per-user - the same key string for a different user creates its own row", async () => {
    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-CREATE-TRANSACTION-IDEMPOTENCY-OTHER-${Date.now()}` },
    });
    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUser.id, name: "حساب دیگر", type: "cash" },
    });
    await prisma.category.create({
      data: { userId: otherUser.id, name: "دسته تست idempotency", icon: "🧪", color: "#333333", type: "expense" },
    });

    const key = `test-key-${Date.now()}-shared`;
    const mine = await createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key });
    const theirs = await createTransaction(otherUser.id, {
      ...baseInput,
      accountId: otherAccount.id,
      idempotencyKey: key,
    });

    expect(theirs.id).not.toBe(mine.id);

    await prisma.transaction.deleteMany({ where: { userId: otherUser.id } });
    await prisma.category.deleteMany({ where: { userId: otherUser.id } });
    await prisma.financeAccount.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  it(
    "a concurrent double-submit with the same key produces exactly one row (DB-level dedup, not just read-first)",
    async () => {
      const key = `test-key-${Date.now()}-concurrent`;
      const [a, b] = await Promise.all([
        createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key }),
        createTransaction(userId, { ...baseInput, accountId, idempotencyKey: key }),
      ]);

      expect(a.id).toBe(b.id);
      const rows = await prisma.transaction.findMany({ where: { userId, idempotencyKey: key } });
      expect(rows).toHaveLength(1);
    },
    20000
  );
});

// Phase 3.2 regression coverage: proves the { id, userId } ownership check
// on every read/mutate path actually blocks cross-user access, rather than
// just trusting it by inspection. No vulnerability was found here (see
// security-audit-report.md and the Phase 0 audit) - this locks the
// already-correct behavior in place against future regressions.
describe("cross-user ownership", () => {
  let userAId: number;
  let userBId: number;
  let accountAId: number;
  let accountBId: number;
  let categoryAId: number;
  let txnAId: number;

  beforeAll(async () => {
    const userA = await prisma.user.create({ data: { phoneNumber: `TEST-OWNERSHIP-A-${Date.now()}` } });
    userAId = userA.id;
    const userB = await prisma.user.create({ data: { phoneNumber: `TEST-OWNERSHIP-B-${Date.now()}` } });
    userBId = userB.id;

    const accountA = await prisma.financeAccount.create({
      data: { userId: userAId, name: "حساب الف", type: "cash" },
    });
    accountAId = accountA.id;

    const accountB = await prisma.financeAccount.create({
      data: { userId: userBId, name: "حساب ب", type: "cash" },
    });
    accountBId = accountB.id;

    const categoryA = await prisma.category.create({
      data: { userId: userAId, name: "دسته مالکیت الف", icon: "🧪", color: "#333333", type: "expense" },
    });
    categoryAId = categoryA.id;

    const txnA = await prisma.transaction.create({
      data: {
        userId: userAId,
        accountId: accountAId,
        categoryId: categoryAId,
        amount: 100000,
        type: "expense",
        rawInput: "تراکنش مالکیت الف",
        date: new Date("2026-01-10"),
      },
    });
    txnAId = txnA.id;
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.category.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  }, 20000);

  // Explicit generous timeouts on this describe's tests/hooks (beyond
  // vitest's 5s/10s defaults) - this block does several sequential live
  // Turso round trips per test, and default timeouts were observed to be
  // too tight under real network latency to the remote DB (see T-1 in
  // security-audit-report.md). Not touching other describe blocks' timeouts
  // in this file - out of scope for this phase.
  it(
    "getTransaction returns null for another user's transaction",
    async () => {
      expect(await getTransaction(userBId, txnAId)).toBeNull();
      // Sanity: the owner can still read it.
      expect(await getTransaction(userAId, txnAId)).not.toBeNull();
    },
    15000
  );

  it(
    "updateTransaction throws TransactionNotFoundError when called by another user, and leaves the row untouched",
    async () => {
      await expect(
        updateTransaction(userBId, txnAId, {
          amount: 999,
          type: "expense",
          categoryName: "دسته مالکیت الف",
          accountId: accountAId,
          date: new Date("2026-01-11"),
        })
      ).rejects.toBeInstanceOf(TransactionNotFoundError);

      const untouched = await prisma.transaction.findUnique({ where: { id: txnAId } });
      expect(untouched?.amount).toBe(100000);
    },
    15000
  );

  it(
    "deleteTransaction throws TransactionNotFoundError when called by another user, and the row still exists after",
    async () => {
      await expect(deleteTransaction(userBId, txnAId)).rejects.toBeInstanceOf(TransactionNotFoundError);

      const stillThere = await prisma.transaction.findUnique({ where: { id: txnAId } });
      expect(stillThere).not.toBeNull();
    },
    15000
  );

  it(
    "updateTransaction rejects reassigning the caller's own transaction onto another user's account",
    async () => {
      await expect(
        updateTransaction(userAId, txnAId, {
          amount: 100000,
          type: "expense",
          categoryName: "دسته مالکیت الف",
          accountId: accountBId, // belongs to userB
          date: new Date("2026-01-12"),
        })
      ).rejects.toBeInstanceOf(InvalidAccountError);

      const untouched = await prisma.transaction.findUnique({ where: { id: txnAId } });
      expect(untouched?.accountId).toBe(accountAId);
    },
    15000
  );
});

// Phase 4.1 pagination coverage (docs/roadmap-status.md - "GET
// /api/transactions has zero pagination"). Seeds DEFAULT_TRANSACTIONS_PAGE_SIZE
// + 5 rows dated one calendar day apart so orderBy: date desc is verifiable
// by amount (amount N <-> day N, so the newest date has the highest amount).
describe("listTransactions (pagination)", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;
  const rowCount = DEFAULT_TRANSACTIONS_PAGE_SIZE + 5;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-LIST-TRANSACTIONS-PAGINATION-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست صفحه‌بندی", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "دسته تست صفحه‌بندی", icon: "🧪", color: "#444444", type: "expense" },
    });
    categoryId = category.id;

    await prisma.transaction.createMany({
      data: Array.from({ length: rowCount }, (_, i) => ({
        userId,
        accountId,
        categoryId,
        amount: i + 1,
        type: "expense",
        rawInput: `تراکنش صفحه‌بندی ${i + 1}`,
        date: new Date(2026, 0, i + 1),
      })),
    });
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("defaults to page 1 at DEFAULT_TRANSACTIONS_PAGE_SIZE, newest date first", async () => {
    const result = await listTransactions(userId);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(result.total).toBe(rowCount);
    expect(result.totalPages).toBe(2);
    expect(result.transactions).toHaveLength(DEFAULT_TRANSACTIONS_PAGE_SIZE);
    // Newest date (day rowCount, amount rowCount) first, descending.
    expect(result.transactions[0].amount).toBe(rowCount);
    expect(result.transactions[DEFAULT_TRANSACTIONS_PAGE_SIZE - 1].amount).toBe(rowCount - DEFAULT_TRANSACTIONS_PAGE_SIZE + 1);
  });

  it("returns the remainder on page 2, still newest-first within the page", async () => {
    const result = await listTransactions(userId, {}, 2);

    expect(result.page).toBe(2);
    expect(result.total).toBe(rowCount);
    expect(result.totalPages).toBe(2);
    expect(result.transactions).toHaveLength(rowCount - DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(result.transactions[0].amount).toBe(rowCount - DEFAULT_TRANSACTIONS_PAGE_SIZE);
    expect(result.transactions[result.transactions.length - 1].amount).toBe(1);
  });

  it("clamps an out-of-range page (0, negative) up to page 1", async () => {
    expect((await listTransactions(userId, {}, 0)).page).toBe(1);
    expect((await listTransactions(userId, {}, -3)).page).toBe(1);
  });

  it("composes with filters - total/totalPages reflect the filtered count, not the grand total", async () => {
    const result = await listTransactions(userId, { type: "income" });

    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(result.transactions).toHaveLength(0);
  });
});

// Separate describe (own fixture) so this doesn't distort the exact
// amount/ordering assertions above - proves MAX_TRANSACTIONS_PAGE_SIZE
// actually bounds the query (caps `take`) rather than just being a number
// reflected back in the response.
describe("listTransactions (hard max page size)", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;
  const rowCount = MAX_TRANSACTIONS_PAGE_SIZE + 5;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-LIST-TRANSACTIONS-MAX-PAGE-SIZE-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست حداکثر صفحه", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "دسته تست حداکثر صفحه", icon: "🧪", color: "#555555", type: "expense" },
    });
    categoryId = category.id;

    await prisma.transaction.createMany({
      data: Array.from({ length: rowCount }, (_, i) => ({
        userId,
        accountId,
        categoryId,
        amount: i + 1,
        type: "expense",
        rawInput: `تراکنش حداکثر ${i + 1}`,
        date: new Date(2026, 1, i + 1),
      })),
    });
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it("clamps a requested pageSize above MAX_TRANSACTIONS_PAGE_SIZE down to the cap", async () => {
    const result = await listTransactions(userId, {}, 1, 999999);

    expect(result.pageSize).toBe(MAX_TRANSACTIONS_PAGE_SIZE);
    expect(result.transactions).toHaveLength(MAX_TRANSACTIONS_PAGE_SIZE);
    expect(result.total).toBe(rowCount);
    expect(result.totalPages).toBe(2);
  });
});

// Phase 5.3: a cached SpendingSummaryCache row (see
// lib/analytics/spending-summary.ts) must not be left stale after a
// mutation that touches its month - createTransaction/updateTransaction/
// deleteTransaction all invalidate it. Each cache row here is seeded
// directly (not via a real getSpendingSummary() call) so each test only
// exercises the one thing it's checking.
describe("transaction mutations invalidate SpendingSummaryCache", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;
  const categoryName = "دسته کش‌ابطال تست";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-CACHE-INVALIDATION-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#222222", type: "expense" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.spendingSummaryCache.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function seedCache(monthKey: string) {
    await prisma.spendingSummaryCache.create({ data: { userId, monthKey, payload: "{}" } });
  }

  async function readCache(monthKey: string) {
    return prisma.spendingSummaryCache.findUnique({ where: { userId_monthKey: { userId, monthKey } } });
  }

  it("createTransaction removes a cached summary for the new transaction's month", async () => {
    const date = new Date("2021-03-15");
    const monthKey = jalaaliMonthKey(date);
    await seedCache(monthKey);

    await createTransaction(userId, {
      amount: 5000,
      type: "expense",
      categoryName,
      accountId,
      rawInput: "تست",
      date,
    });

    expect(await readCache(monthKey)).toBeNull();
  });

  it("deleteTransaction removes the cached summary for the deleted transaction's month", async () => {
    const date = new Date("2021-05-10");
    const monthKey = jalaaliMonthKey(date);
    const txn = await prisma.transaction.create({
      data: { userId, accountId, categoryId, amount: 10000, type: "expense", rawInput: "تست", date },
    });
    await seedCache(monthKey);

    await deleteTransaction(userId, txn.id);

    expect(await readCache(monthKey)).toBeNull();
  });

  it("updateTransaction removes cached summaries for both the old and new month when the date changes", async () => {
    const oldDate = new Date("2021-07-05");
    const newDate = new Date("2021-09-05");
    const oldMonthKey = jalaaliMonthKey(oldDate);
    const newMonthKey = jalaaliMonthKey(newDate);
    const txn = await prisma.transaction.create({
      data: { userId, accountId, categoryId, amount: 10000, type: "expense", rawInput: "تست", date: oldDate },
    });
    await Promise.all([seedCache(oldMonthKey), seedCache(newMonthKey)]);

    await updateTransaction(userId, txn.id, {
      amount: 20000,
      type: "expense",
      categoryName,
      accountId,
      date: newDate,
    });

    const [oldCache, newCache] = await Promise.all([readCache(oldMonthKey), readCache(newMonthKey)]);
    expect(oldCache).toBeNull();
    expect(newCache).toBeNull();
  });

  it("updateTransaction that keeps the same month leaves other months' caches untouched", async () => {
    const date = new Date("2021-11-12");
    const monthKey = jalaaliMonthKey(date);
    const unrelatedMonthKey = jalaaliMonthKey(new Date("2020-01-01"));
    const txn = await prisma.transaction.create({
      data: { userId, accountId, categoryId, amount: 10000, type: "expense", rawInput: "تست", date },
    });
    await Promise.all([seedCache(monthKey), seedCache(unrelatedMonthKey)]);

    await updateTransaction(userId, txn.id, {
      amount: 15000,
      type: "expense",
      categoryName,
      accountId,
      date,
    });

    expect(await readCache(monthKey)).toBeNull();
    expect(await readCache(unrelatedMonthKey)).not.toBeNull();
  });
});

// This task's own addition: schema.prisma's four suggestedCategory* columns
// on Transaction, and the three functions that read/write them -
// applyTransactionEnrichment's new suggestedCategory patch field,
// applySuggestedCategory, and dismissSuggestedCategory.
describe("Transaction.suggestedCategory* columns", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;
  let otherCategoryId: number;
  const categoryName = "دسته تست پیشنهاد";
  const otherCategoryName = "دسته دیگر تست پیشنهاد";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SUGGESTED-CATEGORY-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست پیشنهاد", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#666666", type: "expense" },
    });
    categoryId = category.id;

    const otherCategory = await prisma.category.create({
      data: { userId, name: otherCategoryName, icon: "🧪", color: "#777777", type: "expense" },
    });
    otherCategoryId = otherCategory.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe("applyTransactionEnrichment", () => {
    it("writes all four columns when patch.suggestedCategory is present", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 50000,
          type: "expense",
          rawInput: "۱۴۰ سیگار",
          date: new Date("2026-01-01"),
          enrichmentStatus: "pending",
        },
      });

      await applyTransactionEnrichment(userId, txn.id, {
        amount: 140000,
        type: "expense",
        categoryName,
        date: new Date("2026-01-01"),
        suggestedCategory: { name: "دخانیات", parentName: null, reason: "خرید سیگار", icon: "🚬" },
      });

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.suggestedCategoryName).toBe("دخانیات");
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBe("خرید سیگار");
      expect(updated?.suggestedCategoryIcon).toBe("🚬");
      expect(updated?.enrichmentStatus).toBeNull();
    });

    it("keeps the row's own date when patch.date is omitted (a hand-picked quick-submit date)", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 50000,
          type: "expense",
          rawInput: "۵۰ تومن قهوه",
          date: new Date("2026-01-01"),
          enrichmentStatus: "pending",
        },
      });

      await applyTransactionEnrichment(userId, txn.id, {
        amount: 55000,
        type: "expense",
        categoryName: otherCategoryName,
      });

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.date.toISOString().slice(0, 10)).toBe("2026-01-01");
      expect(updated?.amount).toBe(55000);
      expect(updated?.categoryId).toBe(otherCategoryId);
      expect(updated?.enrichmentStatus).toBeNull();
    });

    it("leaves all four columns null when patch.suggestedCategory is absent", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 50000,
          type: "expense",
          rawInput: "۵۰ تومن ناهار",
          date: new Date("2026-01-02"),
          enrichmentStatus: "pending",
        },
      });

      await applyTransactionEnrichment(userId, txn.id, {
        amount: 50000,
        type: "expense",
        categoryName,
        date: new Date("2026-01-02"),
      });

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.suggestedCategoryName).toBeNull();
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBeNull();
      expect(updated?.suggestedCategoryIcon).toBeNull();
    });
  });

  describe("updateTransaction clears a standing suggestion (manual edit wins)", () => {
    it("nulls all four columns on a manual edit", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 140000,
          type: "expense",
          rawInput: "۱۴۰ سیگار",
          date: new Date("2026-01-03"),
          suggestedCategoryName: "دخانیات",
          suggestedCategoryParentName: null,
          suggestedCategoryReason: "خرید سیگار",
          suggestedCategoryIcon: "🚬",
        },
      });

      await updateTransaction(userId, txn.id, {
        amount: 140000,
        type: "expense",
        categoryName,
        accountId,
        date: new Date("2026-01-03"),
      });

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.suggestedCategoryName).toBeNull();
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBeNull();
      expect(updated?.suggestedCategoryIcon).toBeNull();
    });
  });

  describe("applySuggestedCategory", () => {
    it("sets categoryId and clears all four columns", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 140000,
          type: "expense",
          rawInput: "۱۴۰ سیگار",
          date: new Date("2026-01-04"),
          suggestedCategoryName: "دخانیات",
          suggestedCategoryParentName: null,
          suggestedCategoryReason: "خرید سیگار",
          suggestedCategoryIcon: "🚬",
        },
      });

      await applySuggestedCategory(userId, txn.id, otherCategoryId);

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.categoryId).toBe(otherCategoryId);
      expect(updated?.suggestedCategoryName).toBeNull();
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBeNull();
      expect(updated?.suggestedCategoryIcon).toBeNull();
    });

    it("throws TransactionNotFoundError when the transaction has no standing suggestion", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 50000,
          type: "expense",
          rawInput: "۵۰ تومن ناهار",
          date: new Date("2026-01-05"),
        },
      });

      await expect(applySuggestedCategory(userId, txn.id, otherCategoryId)).rejects.toBeInstanceOf(
        TransactionNotFoundError
      );
    });

    it("throws TransactionNotFoundError (not a silent no-op) when called by another user", async () => {
      const otherUser = await prisma.user.create({
        data: { phoneNumber: `TEST-SUGGESTED-CATEGORY-OTHER-${Date.now()}` },
      });
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 140000,
          type: "expense",
          rawInput: "۱۴۰ سیگار",
          date: new Date("2026-01-06"),
          suggestedCategoryName: "دخانیات",
          suggestedCategoryParentName: null,
          suggestedCategoryReason: "خرید سیگار",
          suggestedCategoryIcon: "🚬",
        },
      });

      await expect(applySuggestedCategory(otherUser.id, txn.id, otherCategoryId)).rejects.toBeInstanceOf(
        TransactionNotFoundError
      );

      const untouched = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(untouched?.categoryId).toBe(categoryId);
      expect(untouched?.suggestedCategoryName).toBe("دخانیات");

      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe("dismissSuggestedCategory", () => {
    it("clears all four columns without touching categoryId", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 140000,
          type: "expense",
          rawInput: "۱۴۰ سیگار",
          date: new Date("2026-01-07"),
          suggestedCategoryName: "دخانیات",
          suggestedCategoryParentName: null,
          suggestedCategoryReason: "خرید سیگار",
          suggestedCategoryIcon: "🚬",
        },
      });

      await dismissSuggestedCategory(userId, txn.id);

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.categoryId).toBe(categoryId);
      expect(updated?.suggestedCategoryName).toBeNull();
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBeNull();
      expect(updated?.suggestedCategoryIcon).toBeNull();
    });

    it("throws TransactionNotFoundError when the transaction has no standing suggestion", async () => {
      const txn = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId,
          amount: 50000,
          type: "expense",
          rawInput: "۵۰ تومن ناهار",
          date: new Date("2026-01-08"),
        },
      });

      await expect(dismissSuggestedCategory(userId, txn.id)).rejects.toBeInstanceOf(TransactionNotFoundError);
    });
  });
});

// Covers the data-integrity bug this heuristic fallback exists to mitigate:
// a quick-submit transaction (add-transaction-form.tsx's handleQuickSubmit)
// whose background AI enrichment permanently fails must not stay silently
// mistyped forever - see markEnrichmentFailed's own comment in
// lib/data/transactions.ts and lib/extract-income-signal.ts.
describe("markEnrichmentFailed (heuristic fallback)", () => {
  let userId: number;
  let accountId: number;
  let expenseCategoryId: number;
  let incomeCategoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-MARK-ENRICHMENT-FAILED-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست شکست تحلیل", type: "cash" },
    });
    accountId = account.id;

    const expenseCategory = await prisma.category.create({
      data: { userId, name: "دسته هزینه تست شکست تحلیل", icon: "🧪", color: "#666666", type: "expense" },
    });
    expenseCategoryId = expenseCategory.id;

    // Named exactly like the real seeded fallback category
    // (prisma/seed.ts/DefaultCategory) - markEnrichmentFailed looks this up
    // by this exact (name, type) pair.
    const incomeCategory = await prisma.category.create({
      data: { userId, name: FALLBACK_INCOME_CATEGORY, icon: "🧪", color: "#777777", type: "income" },
    });
    incomeCategoryId = incomeCategory.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("flips a pending transaction to failed without touching type/category when the text has no income signal", async () => {
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: expenseCategoryId,
        amount: 50000,
        type: "expense",
        rawInput: "۵۰ تومن ناهار خوردم",
        date: new Date("2026-02-01"),
        enrichmentStatus: "pending",
      },
    });

    await markEnrichmentFailed(userId, txn.id, txn.rawInput);

    const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(updated?.enrichmentStatus).toBe("failed");
    expect(updated?.type).toBe("expense");
    expect(updated?.categoryId).toBe(expenseCategoryId);
  });

  it("corrects type and category to the income fallback when the text has a strong income signal", async () => {
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: expenseCategoryId,
        amount: 15_000_000,
        type: "expense",
        rawInput: "حقوق این ماه ریخت",
        date: new Date("2026-02-02"),
        enrichmentStatus: "pending",
      },
    });

    await markEnrichmentFailed(userId, txn.id, txn.rawInput);

    const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(updated?.enrichmentStatus).toBe("failed");
    expect(updated?.type).toBe("income");
    expect(updated?.categoryId).toBe(incomeCategoryId);
  });

  it("does not correct type/category when the text merely mentions the ambiguous verb form (واریز کردم)", async () => {
    // "واریز کردم" ("I deposited/paid") is first-person active - it usually
    // means money going OUT (paying someone), the opposite of income. See
    // lib/extract-income-signal.ts's own comment for why the bare word
    // "واریز" is deliberately excluded from the keyword list.
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: expenseCategoryId,
        amount: 500000,
        type: "expense",
        rawInput: "۵۰۰ به علی واریز کردم",
        date: new Date("2026-02-03"),
        enrichmentStatus: "pending",
      },
    });

    await markEnrichmentFailed(userId, txn.id, txn.rawInput);

    const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(updated?.enrichmentStatus).toBe("failed");
    expect(updated?.type).toBe("expense");
    expect(updated?.categoryId).toBe(expenseCategoryId);
  });

  it("does not touch a transaction whose enrichmentStatus is no longer pending (manual edit already won)", async () => {
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: expenseCategoryId,
        amount: 15_000_000,
        type: "expense",
        rawInput: "حقوق این ماه ریخت",
        date: new Date("2026-02-04"),
        enrichmentStatus: null,
      },
    });

    await markEnrichmentFailed(userId, txn.id, txn.rawInput);

    const untouched = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(untouched?.enrichmentStatus).toBeNull();
    expect(untouched?.type).toBe("expense");
    expect(untouched?.categoryId).toBe(expenseCategoryId);
  });

  it("still flips to failed, without a correction, when the income fallback category doesn't exist for this user", async () => {
    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-MARK-ENRICHMENT-FAILED-NO-INCOME-CAT-${Date.now()}` },
    });
    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUser.id, name: "حساب بدون دسته درآمد", type: "cash" },
    });
    const otherExpenseCategory = await prisma.category.create({
      data: { userId: otherUser.id, name: "دسته هزینه بدون درآمد", icon: "🧪", color: "#888888", type: "expense" },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId: otherUser.id,
        accountId: otherAccount.id,
        categoryId: otherExpenseCategory.id,
        amount: 15_000_000,
        type: "expense",
        rawInput: "حقوق این ماه ریخت",
        date: new Date("2026-02-05"),
        enrichmentStatus: "pending",
      },
    });

    await markEnrichmentFailed(otherUser.id, txn.id, txn.rawInput);

    const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
    expect(updated?.enrichmentStatus).toBe("failed");
    expect(updated?.type).toBe("expense");
    expect(updated?.categoryId).toBe(otherExpenseCategory.id);

    // Same explicit "transaction, then category, then account, then user"
    // teardown order this file's other describe blocks already use (see
    // e.g. the "Transaction.suggestedCategory* columns" afterAll above) -
    // Transaction's FKs to FinanceAccount/Category are onDelete: Restrict.
    await prisma.transaction.deleteMany({ where: { userId: otherUser.id } });
    await prisma.category.deleteMany({ where: { userId: otherUser.id } });
    await prisma.financeAccount.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
  });
});
