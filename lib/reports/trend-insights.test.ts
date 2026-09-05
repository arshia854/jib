import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { jalaaliMonthKeyToFullLabel, jalaaliWeekKeyToLabel } from "@/lib/format";
import { periodToGregorianRange } from "@/lib/reports/period-range";
import {
  getPeriodTrend,
  getRecurringExpenses,
  getUnusualTransactions,
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
    const CURRENT_PERIOD = "1403-03";

    let categoryId: number;

    beforeAll(async () => {
      const [category, transfer] = await Promise.all([
        prisma.category.create({
          data: { userId, name: UNUSUAL_NAME, icon: "❗", color: "#100006", type: "expense" },
        }),
        prisma.category.create({
          data: { userId, name: TRANSFER_NAME, icon: "🔄", color: "#100007", type: "expense", isTransfer: true },
        }),
      ]);
      categoryId = category.id;

      const start = periodToGregorianRange(CURRENT_PERIOD, "month").start;

      await Promise.all([
        makeTxn(categoryId, "expense", 10000, start, "خرید عادی ۱"),
        makeTxn(categoryId, "expense", 10000, start, "خرید عادی ۲"),
        // 5x the average of the other two (10000) -> flagged.
        makeTxn(categoryId, "expense", 50000, start, "خرید غیرعادی"),
        // A huge transfer - must never be considered, even though it would
        // dwarf everything else in the category average if it leaked in.
        makeTxn(transfer.id, "expense", 5000000, start, "انتقال بزرگ"),
      ]);
    });

    it("flags a transaction at least 3x its category's other-transactions-this-period average", async () => {
      const unusual = await getUnusualTransactions(String(userId), CURRENT_PERIOD, "month");

      expect(unusual).toHaveLength(1);
      expect(unusual[0].description).toBe("خرید غیرعادی");
      expect(unusual[0].amount).toBe(50000);
      expect(unusual[0].categoryAverage).toBe(10000);
      expect(unusual[0].multiple).toBe(5);
      expect(unusual[0].category).toBe(UNUSUAL_NAME);
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
