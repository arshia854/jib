import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getSpendingSummary } from "@/lib/analytics/spending-summary";

// getSpendingSummary() fans out to several queries (plus a cache
// upsert/lookup) against the remote dev DB, so a single call already runs
// close to the default 5s test timeout under real network latency - and gets
// tighter under the full suite's concurrent DB load. Widen it for this file
// rather than for every test project-wide.
vi.setConfig({ testTimeout: 15000 });

const currentRange = getJalaaliMonthRange();
// A date guaranteed to fall inside the previous Jalali month.
const previousRange = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));

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

    [emptyUserId, singleMonthUserId, partialOverlapUserId, merchantsUserId, cacheUserId, discretionaryUserId] =
      await Promise.all([
        setupEmpty(),
        setupSingleMonth(),
        setupPartialOverlap(),
        setupMerchants(),
        setupCache(),
        setupDiscretionary(),
      ]);
  }, 20000);

  afterAll(async () => {
    await Promise.all(
      [emptyUserId, singleMonthUserId, partialOverlapUserId, merchantsUserId, cacheUserId, discretionaryUserId].map(
        cleanup
      )
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
});
