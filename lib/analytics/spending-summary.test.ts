import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import {
  getSpendingSummary,
  invalidateSpendingSummaryCache,
  computeOverallChange,
  computeSavingsRate,
  computeUnusualTransactions,
  computeRecurringExpenses,
} from "@/lib/analytics/spending-summary";

// getSpendingSummary() fans out to several queries (plus a cache
// upsert/lookup) against the remote dev DB, so a single call already runs
// close to the default 5s test timeout under real network latency - and gets
// tighter under the full suite's concurrent DB load. Widen it for this file
// rather than for every test project-wide.
vi.setConfig({ testTimeout: 15000 });

const currentRange = getJalaaliMonthRange();
// A date guaranteed to fall inside the previous Jalali month.
const previousRange = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));
// A date guaranteed to fall inside the Jalali month before that - used by
// the Phase 10 recurring-expense/cash-flow integration test below.
const monthTwoBackRange = getJalaaliMonthRange(new Date(previousRange.start.getTime() - 1));

// A date guaranteed to land inside the Jalali month `range` describes -
// every Jalali month is at least 29 days, so start+N stays inside for the
// small offsets used below, without reimplementing Jalali month-length logic.
function dateInMonth(range: { start: Date }, dayOffset: number): Date {
  return new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + dayOffset);
}

async function makeUserWithAccount(label: string, initialBalance = 0) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-SPENDING-SUMMARY-${label}-${Date.now()}` },
  });
  const account = await prisma.financeAccount.create({
    data: { userId: user.id, name: "حساب تست", type: "cash", initialBalance },
  });
  return { userId: user.id, accountId: account.id };
}

async function cleanup(userId: number) {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.spendingSummaryCache.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

// All fixtures are set up here (in parallel, across independent users) and
// torn down in afterAll, rather than per-`it()` - each individual it() then
// only does the getSpendingSummary() call + assertions it's testing, well
// within the default test timeout even against a remote (network-latency-
// bound) database. beforeAll/afterAll get a longer default hook timeout,
// which is where the up-front writes and multi-step cleanup belong.
describe("getSpendingSummary", () => {
  let emptyUserId: number;
  let singleMonthUserId: number;
  let partialOverlapUserId: number;
  let merchantsUserId: number;
  let cacheUserId: number;
  let discretionaryUserId: number;
  let transferUserId: number;
  let invalidateUserId: number;

  beforeAll(async () => {
    async function setupEmpty() {
      const { userId } = await makeUserWithAccount("EMPTY", 50000);
      return userId;
    }

    async function setupSingleMonth() {
      const { userId, accountId } = await makeUserWithAccount("SINGLE-MONTH");
      const [food, salary] = await Promise.all([
        prisma.category.create({
          data: { userId, name: "خوراک تست خلاصه", icon: "🍔", color: "#100001", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: "حقوق تست خلاصه", icon: "💰", color: "#100002", type: "income" },
        }),
      ]);
      await Promise.all([
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: food.id,
            amount: 40000,
            type: "expense",
            rawInput: "تست",
            date: dateInMonth(currentRange, 3),
          },
        }),
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: salary.id,
            amount: 500000,
            type: "income",
            rawInput: "تست",
            date: dateInMonth(currentRange, 3),
          },
        }),
      ]);
      return userId;
    }

    async function setupPartialOverlap() {
      const { userId, accountId } = await makeUserWithAccount("PARTIAL-OVERLAP");
      const [both, currentOnly, previousOnly] = await Promise.all([
        prisma.category.create({
          data: { userId, name: "دسته مشترک تست", icon: "🛒", color: "#100003", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: "دسته فقط این ماه تست", icon: "🎯", color: "#100004", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: "دسته فقط ماه قبل تست", icon: "📦", color: "#100005", type: "expense" },
        }),
      ]);
      const makeTxn = (categoryId: number, amount: number, date: Date) =>
        prisma.transaction.create({
          data: { userId, accountId, categoryId, amount, type: "expense", rawInput: "تست", date },
        });
      await Promise.all([
        makeTxn(both.id, 60000, dateInMonth(currentRange, 4)),
        makeTxn(both.id, 40000, dateInMonth(previousRange, 4)),
        makeTxn(currentOnly.id, 20000, dateInMonth(currentRange, 5)),
        makeTxn(previousOnly.id, 15000, dateInMonth(previousRange, 5)),
      ]);
      return userId;
    }

    async function setupMerchants() {
      const { userId, accountId } = await makeUserWithAccount("MERCHANTS");
      const category = await prisma.category.create({
        data: { userId, name: "دسته فروشنده تست", icon: "🏪", color: "#100006", type: "expense" },
      });
      const makeTxn = (description: string, amount: number) =>
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: category.id,
            amount,
            type: "expense",
            rawInput: "تست",
            description,
            date: dateInMonth(currentRange, 2),
          },
        });
      await Promise.all([
        // Same merchant, varying whitespace/case -> must group into one.
        makeTxn("  کافه تست  ", 30000),
        makeTxn("کافه تست", 20000),
        // A different merchant -> must stay a separate group.
        makeTxn("KAFE TEST", 10000),
        makeTxn(" kafe test ", 5000),
      ]);
      return userId;
    }

    async function setupCache() {
      const { userId, accountId } = await makeUserWithAccount("CACHE");
      const category = await prisma.category.create({
        data: { userId, name: "دسته کش تست", icon: "🗄️", color: "#100007", type: "expense" },
      });
      await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId: category.id,
          amount: 25000,
          type: "expense",
          rawInput: "تست",
          date: dateInMonth(previousRange, 3),
        },
      });
      return userId;
    }

    // 6 discretionary (isEssential: false) categories - one more than
    // TOP_DISCRETIONARY_CATEGORIES_TAKE (5) - so topDiscretionaryCategories'
    // capping is actually exercised, plus one essential category to prove
    // discretionaryExpense/topDiscretionaryCategories both exclude it.
    async function setupDiscretionary() {
      const { userId, accountId } = await makeUserWithAccount("DISCRETIONARY");
      const discretionaryTotals = [60000, 50000, 40000, 30000, 20000, 10000];
      const [essential, ...discretionary] = await Promise.all([
        prisma.category.create({
          data: { userId, name: "دسته ضروری تست", icon: "🏠", color: "#100008", type: "expense", isEssential: true },
        }),
        ...discretionaryTotals.map((_, i) =>
          prisma.category.create({
            data: {
              userId,
              name: `دسته غیرضروری تست ${i}`,
              icon: "🎮",
              color: `#10000${i}`,
              type: "expense",
              isEssential: false,
            },
          })
        ),
      ]);
      await Promise.all([
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: essential.id,
            amount: 100000,
            type: "expense",
            rawInput: "تست",
            date: dateInMonth(currentRange, 6),
          },
        }),
        ...discretionary.map((category, i) =>
          prisma.transaction.create({
            data: {
              userId,
              accountId,
              categoryId: category.id,
              amount: discretionaryTotals[i],
              type: "expense",
              rawInput: "تست",
              date: dateInMonth(currentRange, 6),
            },
          })
        ),
      ]);
      return userId;
    }

    // Phase 5.1: proves a Category.isTransfer transaction (either type)
    // doesn't inflate income/expense/categories/discretionaryExpense/
    // topMerchants, while totalBalance - a real per-account balance, not a
    // "spending this month" figure - still reflects it.
    async function setupTransfer() {
      const { userId, accountId } = await makeUserWithAccount("TRANSFER", 0);
      const [normalExpense, normalIncome, transferExpense, transferIncome] = await Promise.all([
        prisma.category.create({
          data: { userId, name: "هزینه عادی تست انتقال", icon: "🍔", color: "#200001", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: "درآمد عادی تست انتقال", icon: "💰", color: "#200002", type: "income" },
        }),
        prisma.category.create({
          data: {
            userId,
            name: "انتقال هزینه تست",
            icon: "🔄",
            color: "#200003",
            type: "expense",
            isTransfer: true,
            // Non-essential on purpose - proves discretionaryExpense
            // excludes it because it's a transfer, not just because it
            // happens to already be essential.
            isEssential: false,
          },
        }),
        prisma.category.create({
          data: { userId, name: "انتقال درآمد تست", icon: "🔄", color: "#200004", type: "income", isTransfer: true },
        }),
      ]);
      await Promise.all([
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: normalExpense.id,
            amount: 20000,
            type: "expense",
            rawInput: "تست",
            description: "فروشگاه واقعی",
            date: dateInMonth(currentRange, 7),
          },
        }),
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: normalIncome.id,
            amount: 300000,
            type: "income",
            rawInput: "تست",
            date: dateInMonth(currentRange, 7),
          },
        }),
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: transferExpense.id,
            amount: 50000,
            type: "expense",
            rawInput: "تست",
            description: "انتقال به حساب دیگر",
            date: dateInMonth(currentRange, 7),
          },
        }),
        prisma.transaction.create({
          data: {
            userId,
            accountId,
            categoryId: transferIncome.id,
            amount: 100000,
            type: "income",
            rawInput: "تست",
            date: dateInMonth(currentRange, 7),
          },
        }),
      ]);
      return userId;
    }

    // Phase 5.3: separate fixture from setupCache above (not reused) so the
    // invalidateSpendingSummaryCache test below can mutate/invalidate its
    // cache without affecting the "reuses the cache" test's assertions.
    async function setupInvalidate() {
      const { userId, accountId } = await makeUserWithAccount("INVALIDATE");
      const category = await prisma.category.create({
        data: { userId, name: "دسته ابطال کش تست", icon: "🗑️", color: "#100009", type: "expense" },
      });
      await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId: category.id,
          amount: 25000,
          type: "expense",
          rawInput: "تست",
          date: dateInMonth(previousRange, 3),
        },
      });
      return userId;
    }

    [
      emptyUserId,
      singleMonthUserId,
      partialOverlapUserId,
      merchantsUserId,
      cacheUserId,
      discretionaryUserId,
      transferUserId,
      invalidateUserId,
    ] = await Promise.all([
      setupEmpty(),
      setupSingleMonth(),
      setupPartialOverlap(),
      setupMerchants(),
      setupCache(),
      setupDiscretionary(),
      setupTransfer(),
      setupInvalidate(),
    ]);
  }, 20000);

  afterAll(async () => {
    await Promise.all(
      [
        emptyUserId,
        singleMonthUserId,
        partialOverlapUserId,
        merchantsUserId,
        cacheUserId,
        discretionaryUserId,
        transferUserId,
        invalidateUserId,
      ].map(cleanup)
    );
    await prisma.$disconnect();
  }, 20000);

  it("returns zeroed-out totals and empty lists for an account with no transactions", async () => {
    const result = await getSpendingSummary(emptyUserId);

    expect(result.totalBalance).toBe(50000);
    expect(result.currentMonth).toEqual({
      label: currentRange.label,
      income: 0,
      expense: 0,
      categories: [],
      discretionaryExpense: 0,
    });
    expect(result.previousMonth).toEqual({
      label: previousRange.label,
      income: 0,
      expense: 0,
      categories: [],
      discretionaryExpense: 0,
    });
    expect(result.categoryTrends).toEqual([]);
    expect(result.topMerchants).toEqual([]);
    expect(result.topDiscretionaryCategories).toEqual([]);
    expect(result.recentTransactions).toEqual([]);
  });

  it("summarizes a single month of data with no previous-month activity", async () => {
    const result = await getSpendingSummary(singleMonthUserId);

    expect(result.currentMonth.income).toBe(500000);
    expect(result.currentMonth.expense).toBe(40000);
    expect(result.currentMonth.categories).toEqual([{ name: "خوراک تست خلاصه", total: 40000 }]);
    // The fixture's expense category has no explicit isEssential -> defaults
    // to true (see prisma/schema.prisma's Category.isEssential), so none of
    // this month's spending counts as discretionary.
    expect(result.currentMonth.discretionaryExpense).toBe(0);
    expect(result.previousMonth).toEqual({
      label: previousRange.label,
      income: 0,
      expense: 0,
      categories: [],
      discretionaryExpense: 0,
    });
    // No overlap between the two months -> nothing to compare.
    expect(result.categoryTrends).toEqual([]);
  });

  it("omits a category from trends when it only has activity in one of the two months", async () => {
    const result = await getSpendingSummary(partialOverlapUserId);

    const trendNames = result.categoryTrends.map((t) => t.category);
    expect(trendNames).toContain("دسته مشترک تست");
    expect(trendNames).not.toContain("دسته فقط این ماه تست");
    expect(trendNames).not.toContain("دسته فقط ماه قبل تست");

    const bothTrend = result.categoryTrends.find((t) => t.category === "دسته مشترک تست");
    expect(bothTrend).toEqual({
      category: "دسته مشترک تست",
      previousAmount: 40000,
      currentAmount: 60000,
      percentChange: 50,
    });
  });

  it("groups merchants by description case-insensitively and trimmed, with count and total", async () => {
    const result = await getSpendingSummary(merchantsUserId);

    const cafeGroup = result.topMerchants.find((m) => m.description.trim().toLowerCase() === "کافه تست");
    expect(cafeGroup).toBeDefined();
    expect(cafeGroup?.count).toBe(2);
    expect(cafeGroup?.total).toBe(50000);

    const kafeGroup = result.topMerchants.find((m) => m.description.trim().toLowerCase() === "kafe test");
    expect(kafeGroup).toBeDefined();
    expect(kafeGroup?.count).toBe(2);
    expect(kafeGroup?.total).toBe(15000);
  });

  it("caches the previous month and reuses it instead of recomputing from transactions", async () => {
    const first = await getSpendingSummary(cacheUserId);
    expect(first.previousMonth.expense).toBe(25000);

    const cacheRow = await prisma.spendingSummaryCache.findFirst({ where: { userId: cacheUserId } });
    expect(cacheRow).toBeTruthy();

    // Mutate the underlying data directly, bypassing the cache. If the
    // second call still reflects the old total, the cache was used instead
    // of recomputing from transactions.
    await prisma.transaction.updateMany({ where: { userId: cacheUserId }, data: { amount: 999999 } });

    const second = await getSpendingSummary(cacheUserId);
    expect(second.previousMonth.expense).toBe(25000);
  });

  it("sums discretionaryExpense from only isEssential: false categories, excluding essential spending", async () => {
    const result = await getSpendingSummary(discretionaryUserId);

    // 60000 + 50000 + 40000 + 30000 + 20000 + 10000 (discretionary) - the
    // 100000 essential-category transaction must not be counted in.
    expect(result.currentMonth.discretionaryExpense).toBe(210000);
    expect(result.currentMonth.expense).toBe(310000);
  });

  it("sorts topDiscretionaryCategories descending by total and caps it at 5, excluding the essential category entirely", async () => {
    const result = await getSpendingSummary(discretionaryUserId);

    expect(result.topDiscretionaryCategories).toHaveLength(5);
    expect(result.topDiscretionaryCategories.map((c) => c.total)).toEqual([60000, 50000, 40000, 30000, 20000]);
    // The lowest-total discretionary category (10000) is capped out, and the
    // essential category never appears here regardless of its amount.
    expect(result.topDiscretionaryCategories.map((c) => c.name)).not.toContain("دسته غیرضروری تست 5");
    expect(result.topDiscretionaryCategories.map((c) => c.name)).not.toContain("دسته ضروری تست");
  });

  it("excludes Category.isTransfer transactions from income/expense/categories/discretionaryExpense/topMerchants, but still counts them in totalBalance", async () => {
    const result = await getSpendingSummary(transferUserId);

    expect(result.currentMonth.income).toBe(300000);
    expect(result.currentMonth.expense).toBe(20000);
    expect(result.currentMonth.categories).toEqual([{ name: "هزینه عادی تست انتقال", total: 20000 }]);
    expect(result.currentMonth.discretionaryExpense).toBe(0);
    expect(result.topMerchants).toEqual([{ description: "فروشگاه واقعی", count: 1, total: 20000 }]);

    // Transfers still move real money between real account balances, so
    // totalBalance (unlike every figure above) must still reflect them:
    // 0 (initial) + 300000 + 100000 (income, incl. transfer) - 20000 -
    // 50000 (expense, incl. transfer) = 330000.
    expect(result.totalBalance).toBe(330000);
  });

  it("invalidateSpendingSummaryCache forces the next read to recompute instead of reusing a stale cache", async () => {
    const first = await getSpendingSummary(invalidateUserId);
    expect(first.previousMonth.expense).toBe(25000);

    // Same "mutate directly, bypassing the cache" technique as the "reuses
    // the cache" test above - proves the second read below reflects the
    // new data because invalidation actually happened, not because it was
    // recomputed anyway for some other reason.
    await prisma.transaction.updateMany({ where: { userId: invalidateUserId }, data: { amount: 999999 } });
    await invalidateSpendingSummaryCache(invalidateUserId, dateInMonth(previousRange, 3));

    const second = await getSpendingSummary(invalidateUserId);
    expect(second.previousMonth.expense).toBe(999999);
  });
});

// Phase 10 - direct, pure-function unit tests (no DB) for the new
// deterministic financial-fact helpers, per this phase's own instruction
// ("unit-testable without hitting the DB... not just integration coverage
// through the chat route"). The describe block above already covers all
// four of these indirectly through getSpendingSummary's real-DB fixtures
// (see "Phase 10 fields surfaced through getSpendingSummary" below); these
// exercise the pure logic directly and cheaply, including edge cases
// (zero baselines, single-sample categories) that would be awkward to set
// up as real DB fixtures.

describe("computeOverallChange", () => {
  it("computes a positive percent change against a previous-month baseline", () => {
    expect(computeOverallChange(1200, 1000)).toEqual({ previousAmount: 1000, currentAmount: 1200, percentChange: 20 });
  });

  it("computes a negative percent change", () => {
    expect(computeOverallChange(800, 1000)).toEqual({ previousAmount: 1000, currentAmount: 800, percentChange: -20 });
  });

  it("omits the result (not Infinity/NaN) when there's no previous-month baseline", () => {
    expect(computeOverallChange(500, 0)).toBeUndefined();
  });
});

describe("computeSavingsRate", () => {
  it("computes a positive savings rate as a rounded percent", () => {
    expect(computeSavingsRate(1000, 700)).toBe(30);
  });

  it("computes a negative savings rate when expense exceeds income", () => {
    expect(computeSavingsRate(1000, 1500)).toBe(-50);
  });

  it("omits the result when there's no income to divide by", () => {
    expect(computeSavingsRate(0, 500)).toBeUndefined();
  });
});

describe("computeUnusualTransactions", () => {
  const base = { type: "expense", category: { name: "خوراک و رستوران", isEssential: false } };

  it("flags a transaction at or above the multiplier vs. the category's other transactions this month", () => {
    const result = computeUnusualTransactions([
      { ...base, id: 1, date: new Date("2026-01-05"), amount: 30000, description: "سوپرمارکت" },
      { ...base, id: 2, date: new Date("2026-01-10"), amount: 300000, description: "رستوران گران" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 2, categoryAverage: 30000, multiple: 10 });
  });

  it("does not flag a transaction below the multiplier", () => {
    const result = computeUnusualTransactions([
      { ...base, id: 1, date: new Date("2026-01-05"), amount: 30000, description: "سوپرمارکت" },
      { ...base, id: 2, date: new Date("2026-01-10"), amount: 60000, description: "خرید معمولی" },
    ]);

    expect(result).toEqual([]);
  });

  it("skips a category with only one transaction this month (no baseline to compare against)", () => {
    const result = computeUnusualTransactions([
      { ...base, id: 1, date: new Date("2026-01-05"), amount: 5000000, description: "تنها تراکنش این دسته" },
    ]);

    expect(result).toEqual([]);
  });

  it("ignores income transactions entirely", () => {
    const result = computeUnusualTransactions([
      { type: "income", category: { name: "حقوق", isEssential: true }, id: 1, date: new Date("2026-01-01"), amount: 1000000, description: "حقوق" },
      { type: "income", category: { name: "حقوق", isEssential: true }, id: 2, date: new Date("2026-01-15"), amount: 50000000, description: "پاداش" },
    ]);

    expect(result).toEqual([]);
  });

  it("sorts multiple flagged transactions descending by multiple", () => {
    // Two independent categories, each with its own baseline + outlier, so
    // each outlier's "others average" isn't skewed by the other category's
    // outlier (unlike putting all 4 in one category, where computing each
    // transaction's average against *every* other transaction in that same
    // category would make the two outliers pull each other's baseline up).
    const foodCategory = { type: "expense", category: { name: "خوراک و رستوران", isEssential: false } };
    const transportCategory = { type: "expense", category: { name: "حمل‌ونقل", isEssential: false } };

    const result = computeUnusualTransactions([
      { ...foodCategory, id: 1, date: new Date("2026-01-01"), amount: 10000, description: "پایه خوراک" },
      { ...foodCategory, id: 2, date: new Date("2026-01-10"), amount: 50000, description: "۵ برابر" }, // 5x the baseline
      { ...transportCategory, id: 3, date: new Date("2026-01-01"), amount: 10000, description: "پایه حمل‌ونقل" },
      { ...transportCategory, id: 4, date: new Date("2026-01-20"), amount: 100000, description: "۱۰ برابر" }, // 10x the baseline
    ]);

    expect(result.map((r) => r.id)).toEqual([4, 2]);
  });
});

describe("computeRecurringExpenses", () => {
  it("flags a description present in at least 2 of 3 months", () => {
    const result = computeRecurringExpenses([
      [{ description: "اشتراک نتفلیکس", amount: 200000 }],
      [{ description: "اشتراک نتفلیکس", amount: 200000 }],
      [{ description: "خرید یک‌باره", amount: 50000 }],
    ]);

    expect(result).toEqual([{ description: "اشتراک نتفلیکس", monthsPresent: 2, monthsChecked: 3, averageAmount: 200000 }]);
  });

  it("does not flag a description present in only one of three months", () => {
    const result = computeRecurringExpenses([
      [{ description: "خرید یک‌باره", amount: 50000 }],
      [],
      [],
    ]);

    expect(result).toEqual([]);
  });

  it("averages the amount across the months it appeared in (month-level, not per-occurrence)", () => {
    const result = computeRecurringExpenses([
      [{ description: "اجاره", amount: 5000000 }],
      [{ description: "اجاره", amount: 4000000 }],
      [{ description: "اجاره", amount: 6000000 }],
    ]);

    expect(result[0]).toMatchObject({ monthsPresent: 3, averageAmount: 5000000 });
  });

  it("groups case-insensitively and trims whitespace, same as computeTopMerchants", () => {
    const result = computeRecurringExpenses([
      [{ description: "  اسنپ‌فود  ", amount: 100000 }],
      [{ description: "اسنپ‌فود", amount: 120000 }],
      [],
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].monthsPresent).toBe(2);
  });

  it("reports monthsChecked to reflect however many months were actually passed in", () => {
    const result = computeRecurringExpenses([
      [{ description: "اشتراک", amount: 100000 }],
      [{ description: "اشتراک", amount: 100000 }],
    ]);

    expect(result[0].monthsChecked).toBe(2);
  });
});

// Phase 10 fields surfaced through getSpendingSummary - real DB, exercises
// the query-splitting/cache-reuse wiring the pure-function tests above
// can't (computeCashFlowTrend's getOrComputeMonth cache path, and
// getSpendingSummary's own current/previous/monthTwoBack split of one
// combined lookback query), not just the pure logic in isolation.
describe("getSpendingSummary - Phase 10 fields", () => {
  let userId: number;
  let accountId: number;
  let foodCategoryId: number;

  beforeAll(async () => {
    const setup = await makeUserWithAccount("PHASE10");
    userId = setup.userId;
    accountId = setup.accountId;

    const [food, salary] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "خوراک تست فاز۱۰", icon: "🍔", color: "#100003", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "حقوق تست فاز۱۰", icon: "💰", color: "#100004", type: "income" },
      }),
    ]);
    foodCategoryId = food.id;

    await Promise.all([
      // Current month: income (for incomeChange/savingsRate), plus two
      // same-category expenses - one baseline, one a clear (>=3x) outlier -
      // to also exercise unusualTransactions end-to-end.
      prisma.transaction.create({
        data: { userId, accountId, categoryId: salary.id, amount: 1200000, type: "income", rawInput: "تست", date: dateInMonth(currentRange, 1), description: "حقوق" },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 40000, type: "expense", rawInput: "تست", date: dateInMonth(currentRange, 2), description: "سوپرمارکت معمولی" },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 400000, type: "expense", rawInput: "تست", date: dateInMonth(currentRange, 3), description: "شام مهمانی بزرگ" },
      }),
      // Same normalized description recurring across all 3 lookback
      // months, for recurringExpenses.
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 150000, type: "expense", rawInput: "تست", date: dateInMonth(currentRange, 4), description: "اشتراک ماهانه" },
      }),
      // Previous month: lower income/expense than current, so
      // incomeChange/expenseChange both have a real (positive) baseline.
      prisma.transaction.create({
        data: { userId, accountId, categoryId: salary.id, amount: 1000000, type: "income", rawInput: "تست", date: dateInMonth(previousRange, 1), description: "حقوق" },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 30000, type: "expense", rawInput: "تست", date: dateInMonth(previousRange, 2), description: "خرید قبلی" },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 150000, type: "expense", rawInput: "تست", date: dateInMonth(previousRange, 3), description: "اشتراک ماهانه" },
      }),
      // Month two back: only the recurring item, to prove it's actually
      // reached by the combined lookback query (not just current+previous).
      prisma.transaction.create({
        data: { userId, accountId, categoryId: foodCategoryId, amount: 150000, type: "expense", rawInput: "تست", date: dateInMonth(monthTwoBackRange, 3), description: "اشتراک ماهانه" },
      }),
    ]);
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.spendingSummaryCache.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("computes incomeChange/expenseChange against the previous month", async () => {
    const result = await getSpendingSummary(userId);

    expect(result.incomeChange).toEqual({ previousAmount: 1000000, currentAmount: 1200000, percentChange: 20 });
    // previous month expense: 30000 + 150000 = 180000; current: 40000 + 400000 + 150000 = 590000.
    expect(result.expenseChange).toEqual({ previousAmount: 180000, currentAmount: 590000, percentChange: 228 });
  });

  it("computes savingsRate for the current month", async () => {
    const result = await getSpendingSummary(userId);
    // (1200000 - 590000) / 1200000 = 0.5083... -> 51% (rounded)
    expect(result.savingsRate).toBe(51);
  });

  it("flags the outlier expense in unusualTransactions, referencing the real transaction", async () => {
    const result = await getSpendingSummary(userId);

    expect(result.unusualTransactions.length).toBeGreaterThanOrEqual(1);
    const flagged = result.unusualTransactions.find((t) => t.description === "شام مهمانی بزرگ");
    expect(flagged).toBeDefined();
    expect(flagged!.amount).toBe(400000);
    expect(flagged!.category).toBe("خوراک تست فاز۱۰");
  });

  it("finds the recurring expense across all 3 lookback months, reaching monthTwoBack through the combined query", async () => {
    const result = await getSpendingSummary(userId);

    const recurring = result.recurringExpenses.find((r) => r.description === "اشتراک ماهانه");
    expect(recurring).toBeDefined();
    expect(recurring!.monthsPresent).toBe(3);
    expect(recurring!.monthsChecked).toBe(3);
    expect(recurring!.averageAmount).toBe(150000);
  });

  it("returns a cashFlowTrend with one entry per month, oldest first, ending with the current month", async () => {
    const result = await getSpendingSummary(userId);

    expect(result.cashFlowTrend.length).toBeGreaterThanOrEqual(2);
    const last = result.cashFlowTrend[result.cashFlowTrend.length - 1];
    expect(last.income).toBe(1200000);
    expect(last.expense).toBe(590000);
    expect(last.net).toBe(610000);

    const secondToLast = result.cashFlowTrend[result.cashFlowTrend.length - 2];
    expect(secondToLast.income).toBe(1000000);
    expect(secondToLast.expense).toBe(180000);
  });
});

// Phase 17 (docs/roadmap-status.md): getSpendingSummary()'s totalBalance
// used to load every transaction row ever created for the user's accounts
// (financeAccount.findMany + include transactions), just to sum in JS -
// the same bug lib/data/dashboard.ts had, and a hotter path here since
// getSpendingSummary runs on every chat message. Replaced with the shared
// lib/data/accounts.ts's getTotalBalance() bounded aggregate. This proves
// getSpendingSummary()'s totalBalance is identical to the old full-load
// calculation for a nontrivial history: 2 accounts, mixed income/expense
// spread across several months - see accounts.test.ts's getTotalBalance
// describe block for the function-level version of this same proof.
describe("getSpendingSummary - totalBalance matches old full-load calculation", () => {
  let userId: number;
  let accountAId: number;
  let accountBId: number;

  async function oldFullLoadTotalBalance(): Promise<number> {
    const accounts = await prisma.financeAccount.findMany({
      where: { userId },
      include: { transactions: { select: { amount: true, type: true } } },
    });
    return accounts.reduce((sum, account) => {
      const net = account.transactions.reduce((acc, t) => acc + (t.type === "income" ? t.amount : -t.amount), 0);
      return sum + account.initialBalance + net;
    }, 0);
  }

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-SPENDING-SUMMARY-BALANCE-${Date.now()}` } });
    userId = user.id;

    const [accountA, accountB] = await Promise.all([
      prisma.financeAccount.create({ data: { userId, name: "حساب الف", type: "cash", initialBalance: 150000 } }),
      prisma.financeAccount.create({ data: { userId, name: "حساب ب", type: "bank", initialBalance: 600000 } }),
    ]);
    accountAId = accountA.id;
    accountBId = accountB.id;

    const [expenseCategory, incomeCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه تست موجودی خلاصه", icon: "🧾", color: "#101010", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد تست موجودی خلاصه", icon: "💵", color: "#202020", type: "income" },
      }),
    ]);

    await Promise.all([
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: expenseCategory.id, amount: 45000, type: "expense", rawInput: "تست", date: dateInMonth(monthTwoBackRange, 2) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: incomeCategory.id, amount: 500000, type: "income", rawInput: "تست", date: dateInMonth(previousRange, 1) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: expenseCategory.id, amount: 80000, type: "expense", rawInput: "تست", date: dateInMonth(previousRange, 5) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: incomeCategory.id, amount: 90000, type: "income", rawInput: "تست", date: dateInMonth(currentRange, 1) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: expenseCategory.id, amount: 15000, type: "expense", rawInput: "تست", date: dateInMonth(currentRange, 2) },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.spendingSummaryCache.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }, 20000);

  it("totalBalance is identical to the old full-load calculation", async () => {
    const [expected, result] = await Promise.all([oldFullLoadTotalBalance(), getSpendingSummary(userId)]);

    // 150000 + 600000 (initial) + 500000 + 90000 (income) - 45000 - 80000 -
    // 15000 (expense) = 1200000.
    expect(expected).toBe(1200000);
    expect(result.totalBalance).toBe(expected);
  });
});
