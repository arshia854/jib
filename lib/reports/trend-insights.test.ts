import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { jalaaliMonthKeyToFullLabel, jalaaliWeekKeyToLabel } from "@/lib/format";
import { periodToGregorianRange } from "@/lib/reports/period-range";
import {
  getPeriodTrend,
  getRecurringExpenses,
  getUnusualTransactions,
  getExpensePatterns,
  getPeriodSavingsRate,
} from "@/lib/reports/trend-insights";

describe("trend-insights", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-TREND-INSIGHTS-${Date.now()}` } });
    userId = user.id;

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  function makeTxn(
    categoryId: number,
    type: "income" | "expense",
    amount: number,
    date: Date,
    description?: string
  ) {
    return prisma.transaction.create({
      data: { userId, accountId, categoryId, amount, type, rawInput: "تست", date, description },
    });
  }

  describe("getPeriodTrend", () => {
    const FOOD_NAME = "خوراک روند تست";
    const INCOME_NAME = "درآمد روند تست";
    const TRANSFER_NAME = "انتقال روند تست";

    let foodId: number;
    let incomeId: number;
    let transferId: number;

    beforeAll(async () => {
      const [food, income, transfer] = await Promise.all([
        prisma.category.create({
          data: { userId, name: FOOD_NAME, icon: "🍔", color: "#100001", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: INCOME_NAME, icon: "💰", color: "#100002", type: "income" },
        }),
        prisma.category.create({
          data: { userId, name: TRANSFER_NAME, icon: "🔄", color: "#100003", type: "expense", isTransfer: true },
        }),
      ]);
      foodId = food.id;
      incomeId = income.id;
      transferId = transfer.id;

      // "1404-W01"/"1403-W52" crosses a Jalaali year boundary the same way
      // lib/reports/monthly-comparison.test.ts's month test does - see
      // lib/reports/period-range.test.ts for these exact week keys.
      const previousWeekStart = periodToGregorianRange("1403-W52", "week").start;
      const currentWeekStart = periodToGregorianRange("1404-W01", "week").start;

      await Promise.all([
        makeTxn(foodId, "expense", 40000, previousWeekStart),
        makeTxn(incomeId, "income", 200000, previousWeekStart),

        makeTxn(foodId, "expense", 60000, currentWeekStart),
        makeTxn(incomeId, "income", 300000, currentWeekStart),
        // Must not inflate either period's income or expense.
        makeTxn(transferId, "expense", 999999, currentWeekStart),
      ]);

      // A second, month-granularity boundary ("1402-11" -> "1402-12" ->
      // "1403-01") for the periodsBack > 1 / multi-period ordering test
      // below - deliberately different categories/dates from the week case
      // above so the two tests can't interfere with each other.
      const [monthA, monthB, monthC] = [
        periodToGregorianRange("1402-11", "month").start,
        periodToGregorianRange("1402-12", "month").start,
        periodToGregorianRange("1403-01", "month").start,
      ];
      await Promise.all([
        makeTxn(foodId, "expense", 10000, monthA),
        makeTxn(incomeId, "income", 50000, monthA),
        makeTxn(foodId, "expense", 20000, monthB),
        makeTxn(incomeId, "income", 60000, monthB),
        makeTxn(foodId, "expense", 30000, monthC),
        makeTxn(incomeId, "income", 70000, monthC),
      ]);
    });

    it("computes income/expense/net per period across a Jalaali year boundary, oldest first, excluding transfers", async () => {
      const periods = await getPeriodTrend(String(userId), "1404-W01", "week", 1);

      expect(periods).toHaveLength(2);

      expect(periods[0].periodKey).toBe("1403-W52");
      expect(periods[0].income).toBe(200000);
      expect(periods[0].expense).toBe(40000);
      expect(periods[0].net).toBe(160000);
      expect(periods[0].label).toBe(jalaaliWeekKeyToLabel("1403-W52"));

      expect(periods[1].periodKey).toBe("1404-W01");
      expect(periods[1].income).toBe(300000);
      // 999999 transfer excluded - would dwarf every other assertion in this
      // file if it leaked in.
      expect(periods[1].expense).toBe(60000);
      expect(periods[1].net).toBe(240000);
      expect(periods[1].label).toBe(jalaaliWeekKeyToLabel("1404-W01"));
    });

    it("returns periodsBack + 1 periods, oldest first, for a multi-period month trend crossing a year boundary", async () => {
      const periods = await getPeriodTrend(String(userId), "1403-01", "month", 2);

      expect(periods.map((p) => p.periodKey)).toEqual(["1402-11", "1402-12", "1403-01"]);
      expect(periods.map((p) => p.label)).toEqual([
        jalaaliMonthKeyToFullLabel("1402-11"),
        jalaaliMonthKeyToFullLabel("1402-12"),
        jalaaliMonthKeyToFullLabel("1403-01"),
      ]);
      expect(periods.map((p) => p.net)).toEqual([40000, 40000, 40000]);
    });
  });

  describe("getRecurringExpenses", () => {
    const RECURRING_NAME = "هزینه تکرارشونده تست";
    const TRANSFER_NAME = "انتقال تکرارشونده تست";
    const RECURRING_DESCRIPTION = "اشتراک نتفلیکس";
    const ONE_OFF_DESCRIPTION = "خرید یکبار";
    const ANNUAL_DESCRIPTION = "اشتراک سالانه";
    const OLD_DESCRIPTION = "خرید دو سال پیش";

    let categoryId: number;
    let transferId: number;

    beforeAll(async () => {
      const [category, transfer] = await Promise.all([
        prisma.category.create({
          data: { userId, name: RECURRING_NAME, icon: "🔁", color: "#100004", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: TRANSFER_NAME, icon: "🔄", color: "#100005", type: "expense", isTransfer: true },
        }),
      ]);
      categoryId = category.id;
      transferId = transfer.id;

      // Month granularity: current "1403-02" + 2 prior ("1403-01", "1402-12") -
      // crosses a Jalaali year boundary, same as getPeriodTrend's month case.
      const currentStart = periodToGregorianRange("1403-02", "month").start;
      const prev1Start = periodToGregorianRange("1403-01", "month").start;
      const prev2Start = periodToGregorianRange("1402-12", "month").start;

      await Promise.all([
        makeTxn(categoryId, "expense", 50000, currentStart, RECURRING_DESCRIPTION),
        makeTxn(categoryId, "expense", 50000, prev1Start, RECURRING_DESCRIPTION),
        makeTxn(categoryId, "expense", 50000, prev2Start, RECURRING_DESCRIPTION),
        // Only ever appears once - must not be flagged recurring.
        makeTxn(categoryId, "expense", 15000, currentStart, ONE_OFF_DESCRIPTION),
        // Same description, but on an isTransfer category - must be excluded
        // even though it repeats every month too.
        makeTxn(transferId, "expense", 999999, currentStart, RECURRING_DESCRIPTION),
        makeTxn(transferId, "expense", 999999, prev1Start, RECURRING_DESCRIPTION),
      ]);

      // Year granularity: current "1404" + prior "1403" only (lookback = 2,
      // not 3 - see trend-insights.ts's own reasoning comment). A
      // description present in 1404 and 1402 (but not 1403) must NOT be
      // flagged, proving the lookback doesn't reach back to 1402.
      const year1404Start = periodToGregorianRange("1404", "year").start;
      const year1403Start = periodToGregorianRange("1403", "year").start;
      const year1402Start = periodToGregorianRange("1402", "year").start;

      await Promise.all([
        makeTxn(categoryId, "expense", 100000, year1404Start, ANNUAL_DESCRIPTION),
        makeTxn(categoryId, "expense", 100000, year1403Start, ANNUAL_DESCRIPTION),
        makeTxn(categoryId, "expense", 80000, year1404Start, OLD_DESCRIPTION),
        makeTxn(categoryId, "expense", 80000, year1402Start, OLD_DESCRIPTION),
      ]);
    });

    it("flags a description present in at least 2 of the last 3 months, excludes isTransfer categories", async () => {
      const recurring = await getRecurringExpenses(String(userId), "1403-02", "month");

      const netflix = recurring.find((r) => r.description === RECURRING_DESCRIPTION);
      expect(netflix).toBeDefined();
      expect(netflix?.monthsPresent).toBe(3);
      expect(netflix?.monthsChecked).toBe(3);
      expect(netflix?.averageAmount).toBe(50000);

      expect(recurring.find((r) => r.description === ONE_OFF_DESCRIPTION)).toBeUndefined();
    });

    it("uses a 2-period lookback for year granularity, not 3", async () => {
      const recurring = await getRecurringExpenses(String(userId), "1404", "year");

      const annual = recurring.find((r) => r.description === ANNUAL_DESCRIPTION);
      expect(annual).toBeDefined();
      expect(annual?.monthsPresent).toBe(2);
      expect(annual?.monthsChecked).toBe(2);

      // Present in 1404 and 1402, but 1402 is outside the 2-period lookback
      // (1404, 1403) - so it only counts as present in 1 of the 2 checked
      // periods, below the >= 2 threshold.
      expect(recurring.find((r) => r.description === OLD_DESCRIPTION)).toBeUndefined();
    });
  });

  describe("getUnusualTransactions", () => {
    const UNUSUAL_NAME = "دسته تراکنش غیرعادی تست";
    const TRANSFER_NAME = "انتقال غیرعادی تست";
    const SPARSE_NAME = "دسته کم‌نمونه غیرعادی تست";
    const LUMP_SUM_NAME = "دسته یک‌قلم غیرعادی تست";
    const CURRENT_PERIOD = "1403-03";

    let categoryId: number;

    beforeAll(async () => {
      const [category, transfer, sparse, lumpSum] = await Promise.all([
        prisma.category.create({
          data: { userId, name: UNUSUAL_NAME, icon: "❗", color: "#100006", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: TRANSFER_NAME, icon: "🔄", color: "#100007", type: "expense", isTransfer: true },
        }),
        prisma.category.create({
          data: { userId, name: SPARSE_NAME, icon: "🕳️", color: "#100008", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: LUMP_SUM_NAME, icon: "🏠", color: "#100009", type: "expense" },
        }),
      ]);
      categoryId = category.id;

      // The same 3-period lookback getRecurringExpenses uses at month
      // granularity: current "1403-03" + "1403-02" + "1403-01".
      const start = periodToGregorianRange(CURRENT_PERIOD, "month").start;
      const prev1Start = periodToGregorianRange("1403-02", "month").start;
      const prev2Start = periodToGregorianRange("1403-01", "month").start;

      await Promise.all([
        makeTxn(categoryId, "expense", 10000, start, "خرید عادی ۱"),
        makeTxn(categoryId, "expense", 10000, start, "خرید عادی ۲"),
        // 5x the average of the category's other 4 transactions (10000
        // each, two of them from the prior periods below) -> flagged.
        makeTxn(categoryId, "expense", 50000, start, "خرید غیرعادی"),
        makeTxn(categoryId, "expense", 10000, prev1Start, "خرید ماه قبل"),
        makeTxn(categoryId, "expense", 10000, prev2Start, "خرید دو ماه قبل"),
        // A huge transfer - must never be considered, even though it would
        // dwarf everything else in the category average if it leaked in.
        makeTxn(transfer.id, "expense", 5000000, start, "انتقال بزرگ"),

        // Only 2 other transactions anywhere in the window - below the
        // minimum baseline sample size, so nothing here is flagged even
        // though 900000 vs. a 15000-ish "average" would look enormous.
        makeTxn(sparse.id, "expense", 900000, start, "تراکنش بزرگ کم‌نمونه"),
        makeTxn(sparse.id, "expense", 15000, start, "تراکنش کوچک کم‌نمونه"),
        makeTxn(sparse.id, "expense", 15000, prev1Start, "تراکنش کوچک ماه قبل"),

        // One lump sum per period plus one small item: against this period
        // alone the lump sum is ~50x the "average", against the category's
        // real history it's an ordinary payment.
        makeTxn(lumpSum.id, "expense", 5000000, start, "اجاره این ماه"),
        makeTxn(lumpSum.id, "expense", 100000, start, "شارژ ساختمان"),
        makeTxn(lumpSum.id, "expense", 4800000, prev1Start, "اجاره ماه قبل"),
        makeTxn(lumpSum.id, "expense", 5200000, prev2Start, "اجاره دو ماه قبل"),
      ]);
    });

    it("flags a transaction at least 3x its category's average across the 3-period lookback window", async () => {
      const unusual = await getUnusualTransactions(String(userId), CURRENT_PERIOD, "month");

      expect(unusual).toHaveLength(1);
      expect(unusual[0].description).toBe("خرید غیرعادی");
      expect(unusual[0].amount).toBe(50000);
      expect(unusual[0].categoryAverage).toBe(10000);
      expect(unusual[0].multiple).toBe(5);
      expect(unusual[0].category).toBe(UNUSUAL_NAME);
      // No explicit isEssential on the fixture category -> schema default.
      expect(unusual[0].isEssential).toBe(true);
    });

    it("skips a category with fewer than the minimum number of baseline transactions in the window", async () => {
      const unusual = await getUnusualTransactions(String(userId), CURRENT_PERIOD, "month");

      expect(unusual.map((t) => t.category)).not.toContain(SPARSE_NAME);
    });

    it("does not flag a per-period lump sum that is normal against the category's own history", async () => {
      const unusual = await getUnusualTransactions(String(userId), CURRENT_PERIOD, "month");

      // Baseline for the 5,000,000: (100000 + 4800000 + 5200000) / 3 =
      // 3,366,666 -> 1.5x, below the 3x threshold. A current-period-only
      // baseline would have been the lone 100,000 -> 50x, flagged.
      expect(unusual.map((t) => t.category)).not.toContain(LUMP_SUM_NAME);
    });
  });

  // Both getPeriodTrend and getPeriodExpenseBuckets now fetch their whole
  // window in one query and split it per period in JS, so the split itself
  // (not just the aggregation on top of it) is what needs covering: rows
  // landing in different periods, a row dated exactly on a period boundary,
  // and a period with no rows at all. Deliberately in 1401 - every other
  // fixture in this file lives in 1402-1404, so these rows can't perturb
  // any of their assertions, or vice versa.
  describe("period bucketing", () => {
    const BUCKET_NAME = "دسته باکت تست";
    const BUCKET_INCOME_NAME = "درآمد باکت تست";
    const RECURRING_DESCRIPTION = "قبض برق";
    const BOUNDARY_DESCRIPTION = "خرید لحظه آخر";
    const CURRENT_PERIOD = "1401-07";

    beforeAll(async () => {
      const [expense, income] = await Promise.all([
        prisma.category.create({
          data: { userId, name: BUCKET_NAME, icon: "🧺", color: "#10000A", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: BUCKET_INCOME_NAME, icon: "💵", color: "#10000B", type: "income" },
        }),
      ]);

      const month05Start = periodToGregorianRange("1401-05", "month").start;
      const month06Start = periodToGregorianRange("1401-06", "month").start;
      const month07Start = periodToGregorianRange(CURRENT_PERIOD, "month").start;
      // The last instant before 1401-06 begins - must bucket into 1401-05.
      const lastInstantOf05 = new Date(month06Start.getTime() - 1);

      await Promise.all([
        makeTxn(income.id, "income", 100000, month05Start),
        makeTxn(expense.id, "expense", 10000, month05Start, RECURRING_DESCRIPTION),
        makeTxn(expense.id, "expense", 5000, lastInstantOf05, BOUNDARY_DESCRIPTION),

        // 1401-06 deliberately has no transactions at all.

        // Dated exactly on 1401-07's start - the [start, end) bounds put it
        // in the period that starts there, never in the one that ends there.
        makeTxn(expense.id, "expense", 30000, month07Start, RECURRING_DESCRIPTION),
        makeTxn(income.id, "income", 70000, month07Start),
      ]);
    });

    it("buckets trend rows into the right period, including a boundary row and an empty period", async () => {
      const periods = await getPeriodTrend(String(userId), CURRENT_PERIOD, "month", 2);

      expect(periods.map((p) => p.periodKey)).toEqual(["1401-05", "1401-06", "1401-07"]);

      // 10000 + the 5000 dated one millisecond before 1401-06 starts.
      expect(periods[0]).toMatchObject({ income: 100000, expense: 15000, net: 85000 });
      expect(periods[1]).toMatchObject({ income: 0, expense: 0, net: 0 });
      // The 30000 dated exactly on 1401-07's start belongs here, not to 1401-06.
      expect(periods[2]).toMatchObject({ income: 70000, expense: 30000, net: 40000 });
    });

    it("buckets expense rows per period across an empty period", async () => {
      const { recurringExpenses, unusualTransactions } = await getExpensePatterns(
        String(userId),
        CURRENT_PERIOD,
        "month"
      );

      const recurring = recurringExpenses.find((r) => r.description === RECURRING_DESCRIPTION);
      expect(recurring).toBeDefined();
      // Present in 1401-05 and 1401-07 but not the empty 1401-06 - so 2 of
      // the 3 checked periods, averaged across the two it appeared in.
      expect(recurring?.monthsPresent).toBe(2);
      expect(recurring?.monthsChecked).toBe(3);
      expect(recurring?.averageAmount).toBe(20000);

      // Only ever in 1401-05 - one of three periods, below the threshold.
      expect(recurringExpenses.find((r) => r.description === BOUNDARY_DESCRIPTION)).toBeUndefined();

      // Only 2 other rows in this category across the whole window, below
      // the minimum baseline sample size - nothing to flag.
      expect(unusualTransactions.map((t) => t.category)).not.toContain(BUCKET_NAME);
    });

    it("returns the same results from one shared fetch as the separate per-consumer fetches", async () => {
      const [shared, recurring, unusual] = await Promise.all([
        getExpensePatterns(String(userId), CURRENT_PERIOD, "month"),
        getRecurringExpenses(String(userId), CURRENT_PERIOD, "month"),
        getUnusualTransactions(String(userId), CURRENT_PERIOD, "month"),
      ]);

      expect(shared.recurringExpenses).toEqual(recurring);
      expect(shared.unusualTransactions).toEqual(unusual);
    });
  });

  describe("getPeriodSavingsRate", () => {
    it("returns (income - expense) / income as a rounded percent", () => {
      expect(getPeriodSavingsRate(100000, 70000)).toBe(30);
    });

    it("returns undefined when income is 0", () => {
      expect(getPeriodSavingsRate(0, 50000)).toBeUndefined();
    });
  });
});
