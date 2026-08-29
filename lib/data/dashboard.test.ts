import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getDashboardData } from "@/lib/data/dashboard";

// Old, pre-Phase-17 totalBalance calculation (docs/roadmap-status.md) -
// loaded every transaction row for the user's accounts and summed in JS.
// Kept here, standalone, only as a reference to prove getDashboardData()'s
// new bounded-aggregate query (via lib/data/accounts.ts's getTotalBalance)
// produces an identical result - not reintroduced anywhere in application
// code. See lib/data/accounts.test.ts's own equivalence test for the
// function-level version of this same proof.
async function oldFullLoadTotalBalance(userId: number): Promise<number> {
  const accounts = await prisma.financeAccount.findMany({
    where: { userId },
    include: { transactions: { select: { amount: true, type: true } } },
  });
  return accounts.reduce((sum, account) => {
    const net = account.transactions.reduce((acc, t) => acc + (t.type === "income" ? t.amount : -t.amount), 0);
    return sum + account.initialBalance + net;
  }, 0);
}

const currentRange = getJalaaliMonthRange();

// A date guaranteed to land inside the current Jalali month - every Jalali
// month is at least 29 days, so start+1 stays inside it.
function dateInCurrentMonth(): Date {
  return new Date(
    currentRange.start.getFullYear(),
    currentRange.start.getMonth(),
    currentRange.start.getDate() + 1
  );
}

// Phase 5.1: getDashboardData's monthIncome/monthExpense/categoryBreakdown
// must exclude Category.isTransfer transactions the same way
// lib/analytics/spending-summary.ts's currentMonth does, while totalBalance
// (a real per-account balance, not a "spending this month" figure) must
// still reflect them - a transfer still moves real money between real
// account balances.
describe("getDashboardData", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-DASHBOARD-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash", initialBalance: 0 },
    });
    accountId = account.id;

    const [normalExpense, normalIncome, transferExpense, transferIncome] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه عادی تست داشبورد", icon: "🍔", color: "#300001", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد عادی تست داشبورد", icon: "💰", color: "#300002", type: "income" },
      }),
      prisma.category.create({
        data: {
          userId,
          name: "انتقال هزینه تست داشبورد",
          icon: "🔄",
          color: "#300003",
          type: "expense",
          isTransfer: true,
        },
      }),
      prisma.category.create({
        data: {
          userId,
          name: "انتقال درآمد تست داشبورد",
          icon: "🔄",
          color: "#300004",
          type: "income",
          isTransfer: true,
        },
      }),
    ]);

    const date = dateInCurrentMonth();
    await Promise.all([
      prisma.transaction.create({
        data: { userId, accountId, categoryId: normalExpense.id, amount: 30000, type: "expense", rawInput: "تست", date },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: normalIncome.id, amount: 400000, type: "income", rawInput: "تست", date },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: transferExpense.id, amount: 70000, type: "expense", rawInput: "تست", date },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: transferIncome.id, amount: 120000, type: "income", rawInput: "تست", date },
      }),
    ]);
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("excludes Category.isTransfer transactions from monthIncome/monthExpense/categoryBreakdown", async () => {
    const result = await getDashboardData(userId);

    expect(result.monthIncome).toBe(400000);
    expect(result.monthExpense).toBe(30000);
    expect(result.categoryBreakdown).toEqual([
      { name: "هزینه عادی تست داشبورد", icon: "🍔", color: "#300001", total: 30000 },
    ]);
  });

  it("still counts transfer transactions in totalBalance", async () => {
    const result = await getDashboardData(userId);

    // 0 (initial) + 400000 + 120000 (income, incl. transfer) - 30000 -
    // 70000 (expense, incl. transfer) = 420000.
    expect(result.totalBalance).toBe(420000);
  });
});

// Phase 17 (docs/roadmap-status.md): getDashboardData()'s totalBalance used
// to load every transaction row ever created for the user's accounts
// (financeAccount.findMany + include transactions), just to sum in JS -
// replaced with a bounded aggregate (lib/data/accounts.ts's
// getTotalBalance()). This proves getDashboardData()'s totalBalance is
// identical to the old full-load calculation for a nontrivial history: 2
// accounts, mixed income/expense spread across several months (not just the
// current one), not just that the new query runs without erroring.
describe("getDashboardData - totalBalance matches old full-load calculation", () => {
  let userId: number;
  let accountAId: number;
  let accountBId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-DASHBOARD-BALANCE-${Date.now()}` } });
    userId = user.id;

    const [accountA, accountB] = await Promise.all([
      prisma.financeAccount.create({ data: { userId, name: "حساب الف", type: "cash", initialBalance: 250000 } }),
      prisma.financeAccount.create({ data: { userId, name: "حساب ب", type: "bank", initialBalance: 900000 } }),
    ]);
    accountAId = accountA.id;
    accountBId = accountB.id;

    const [expenseCategory, incomeCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه تست موجودی داشبورد", icon: "🧾", color: "#151515", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد تست موجودی داشبورد", icon: "💵", color: "#252525", type: "income" },
      }),
    ]);

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    await Promise.all([
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: expenseCategory.id, amount: 55000, type: "expense", rawInput: "تست", date: new Date(now - 180 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: incomeCategory.id, amount: 700000, type: "income", rawInput: "تست", date: new Date(now - 100 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: expenseCategory.id, amount: 120000, type: "expense", rawInput: "تست", date: new Date(now - 45 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: incomeCategory.id, amount: 200000, type: "income", rawInput: "تست", date: new Date(now - 10 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: expenseCategory.id, amount: 30000, type: "expense", rawInput: "تست", date: new Date() },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it("totalBalance is identical to the old full-load calculation", async () => {
    const [expected, result] = await Promise.all([oldFullLoadTotalBalance(userId), getDashboardData(userId)]);

    // 250000 + 900000 (initial) + 700000 + 200000 (income) - 55000 -
    // 120000 - 30000 (expense) = 1845000.
    expect(expected).toBe(1845000);
    expect(result.totalBalance).toBe(expected);
  });
});
