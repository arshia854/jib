import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { jalaaliToDateObject } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { getMonthlyComparison } from "@/lib/reports/monthly-comparison";

describe("getMonthlyComparison", () => {
  let userId: number;
  let accountId: number;

  const FOOD_NAME = "خوراک تست";
  const TRANSPORT_NAME = "حمل‌ونقل تست";
  const INSURANCE_NAME = "بیمه تست";
  const UNUSED_NAME = "دسته بدون تراکنش در بازه تست";
  const INCOME_NAME = "درآمد تست";
  const TRANSFER_NAME = "انتقال تست";

  // Crosses a Jalaali year boundary: اسفند ۱۴۰۲ -> فروردین ۱۴۰۳.
  const PREVIOUS_MONTH = "1402-12";
  const CURRENT_MONTH = "1403-01";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-MONTHLY-COMPARISON-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const [food, transport, insurance, unused, income, transfer] = await Promise.all([
      prisma.category.create({
        data: { userId, name: FOOD_NAME, icon: "🍔", color: "#000001", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: TRANSPORT_NAME, icon: "🚌", color: "#000002", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: INSURANCE_NAME, icon: "🛡️", color: "#000003", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: UNUSED_NAME, icon: "❓", color: "#000004", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: INCOME_NAME, icon: "💰", color: "#000005", type: "income" },
      }),
      prisma.category.create({
        data: { userId, name: TRANSFER_NAME, icon: "🔄", color: "#000006", type: "expense", isTransfer: true },
      }),
    ]);

    const makeTxn = (categoryId: number, type: "income" | "expense", amount: number, date: Date) =>
      prisma.transaction.create({
        data: { userId, accountId, categoryId, amount, type, rawInput: "تست", date },
      });

    await Promise.all([
      // Normal case: 100,000 -> 150,000 (+50%)
      makeTxn(food.id, "expense", 60000, jalaaliToDateObject(1402, 12, 5)),
      makeTxn(food.id, "expense", 40000, jalaaliToDateObject(1402, 12, 20)),
      makeTxn(food.id, "expense", 150000, jalaaliToDateObject(1403, 1, 10)),

      // New this month: 0 -> 20,000 (capped at +100%)
      makeTxn(transport.id, "expense", 20000, jalaaliToDateObject(1403, 1, 15)),

      // Dropped to zero: 30,000 -> 0 (-100%)
      makeTxn(insurance.id, "expense", 30000, jalaaliToDateObject(1402, 12, 15)),

      // Only has a transaction outside both compared months -> must be excluded entirely
      makeTxn(unused.id, "expense", 5000, jalaaliToDateObject(1402, 11, 1)),

      // Income in both months -> must not be treated as "spending"
      makeTxn(income.id, "income", 500000, jalaaliToDateObject(1402, 12, 1)),
      makeTxn(income.id, "income", 500000, jalaaliToDateObject(1403, 1, 1)),

      // A transfer between the user's own accounts -> must not be treated
      // as spending either, despite being type "expense" like food/transport
      // above. Deliberately a large amount, so if the exclusion regresses,
      // "sums totals..." below would fail loudly rather than by a
      // hard-to-notice small drift.
      makeTxn(transfer.id, "expense", 999999, jalaaliToDateObject(1403, 1, 12)),
    ]);
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("computes the normal case, rounding the percent change to the nearest integer", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);

    const food = result.categories.find((c) => c.category === FOOD_NAME);
    expect(food).toBeDefined();
    expect(food?.previousAmount).toBe(100000);
    expect(food?.currentAmount).toBe(150000);
    expect(food?.percentChange).toBe(50);
    expect(food?.isIncrease).toBe(true);
  });

  it("caps percentChange at 100 when previousAmount is 0 and currentAmount > 0", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);

    const transport = result.categories.find((c) => c.category === TRANSPORT_NAME);
    expect(transport).toBeDefined();
    expect(transport?.previousAmount).toBe(0);
    expect(transport?.currentAmount).toBe(20000);
    expect(transport?.percentChange).toBe(100);
    expect(transport?.isIncrease).toBe(true);
  });

  it("returns -100 when previousAmount > 0 and currentAmount drops to 0", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);

    const insurance = result.categories.find((c) => c.category === INSURANCE_NAME);
    expect(insurance).toBeDefined();
    expect(insurance?.previousAmount).toBe(30000);
    expect(insurance?.currentAmount).toBe(0);
    expect(insurance?.percentChange).toBe(-100);
    expect(insurance?.isIncrease).toBe(false);
  });

  it("excludes a category entirely when both previousAmount and currentAmount are 0", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);
    expect(result.categories.find((c) => c.category === UNUSED_NAME)).toBeUndefined();
  });

  it("excludes income transactions from the spending comparison", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);
    expect(result.categories.find((c) => c.category === INCOME_NAME)).toBeUndefined();
  });

  it("excludes Category.isTransfer categories from the spending comparison", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);
    expect(result.categories.find((c) => c.category === TRANSFER_NAME)).toBeUndefined();
  });

  it("sums totals across all categories and computes the overall percent change", async () => {
    const result = await getMonthlyComparison(String(userId), CURRENT_MONTH, PREVIOUS_MONTH);

    // previous: food 100,000 + insurance 30,000 = 130,000
    // current: food 150,000 + transport 20,000 = 170,000
    expect(result.totalPrevious).toBe(130000);
    expect(result.totalCurrent).toBe(170000);
    expect(result.totalPercentChange).toBe(Math.round(((170000 - 130000) / 130000) * 100));
    expect(result.currentMonth).toBe(CURRENT_MONTH);
    expect(result.previousMonth).toBe(PREVIOUS_MONTH);
  });
});
