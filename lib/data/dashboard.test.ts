import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getDashboardData, INCOME_REACTION_WINDOW_MS } from "@/lib/data/dashboard";
import { listAccounts } from "@/lib/data/accounts";

// Wraps (doesn't replace) listAccounts so the income-reaction tests below can
// assert it's never called when there's no active percent-based strategy -
// getDashboardData's own imported binding is what gets spied on, which a
// vi.spyOn on the module namespace wouldn't reliably reach.
vi.mock("@/lib/data/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/accounts")>();
  return { ...actual, listAccounts: vi.fn(actual.listAccounts) };
});

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

// Savings accounts are earmarked, so getDashboardData()'s `totalBalance`
// means "spendable balance, savings excluded" (getTotalBalance() -
// getSavingsBalance()) - see the comment at that line in
// lib/data/dashboard.ts. savingsBalance is returned separately, unchanged.
describe("getDashboardData - totalBalance excludes savings-account balance", () => {
  let withSavingsUserId: number;
  let noSavingsUserId: number;

  beforeAll(async () => {
    const [withSavings, noSavings] = await Promise.all([
      prisma.user.create({ data: { phoneNumber: `TEST-DASHBOARD-SAVINGS-${Date.now()}` } }),
      prisma.user.create({ data: { phoneNumber: `TEST-DASHBOARD-NO-SAVINGS-${Date.now()}` } }),
    ]);
    withSavingsUserId = withSavings.id;
    noSavingsUserId = noSavings.id;

    const [cashAccount, savingsAccount, plainAccount] = await Promise.all([
      prisma.financeAccount.create({
        data: { userId: withSavingsUserId, name: "نقدی", type: "cash", initialBalance: 500000 },
      }),
      prisma.financeAccount.create({
        data: { userId: withSavingsUserId, name: "پس‌انداز", type: "savings", initialBalance: 2000000 },
      }),
      prisma.financeAccount.create({
        data: { userId: noSavingsUserId, name: "بانکی", type: "bank", initialBalance: 750000 },
      }),
    ]);

    const [withSavingsExpense, withSavingsIncome, noSavingsIncome] = await Promise.all([
      prisma.category.create({
        data: { userId: withSavingsUserId, name: "هزینه تست پس‌انداز داشبورد", icon: "🧾", color: "#310001", type: "expense" },
      }),
      prisma.category.create({
        data: { userId: withSavingsUserId, name: "درآمد تست پس‌انداز داشبورد", icon: "💵", color: "#310002", type: "income" },
      }),
      prisma.category.create({
        data: { userId: noSavingsUserId, name: "درآمد تست بدون پس‌انداز داشبورد", icon: "💵", color: "#310003", type: "income" },
      }),
    ]);

    const date = dateInCurrentMonth();
    await Promise.all([
      // cash: 500000 + 300000 - 50000 = 750000
      prisma.transaction.create({
        data: { userId: withSavingsUserId, accountId: cashAccount.id, categoryId: withSavingsIncome.id, amount: 300000, type: "income", rawInput: "تست", date },
      }),
      prisma.transaction.create({
        data: { userId: withSavingsUserId, accountId: cashAccount.id, categoryId: withSavingsExpense.id, amount: 50000, type: "expense", rawInput: "تست", date },
      }),
      // savings: 2000000 + 100000 = 2100000
      prisma.transaction.create({
        data: { userId: withSavingsUserId, accountId: savingsAccount.id, categoryId: withSavingsIncome.id, amount: 100000, type: "income", rawInput: "تست", date },
      }),
      // bank (no savings account at all): 750000 + 250000 = 1000000
      prisma.transaction.create({
        data: { userId: noSavingsUserId, accountId: plainAccount.id, categoryId: noSavingsIncome.id, amount: 250000, type: "income", rawInput: "تست", date },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    for (const userId of [withSavingsUserId, noSavingsUserId]) {
      await prisma.transaction.deleteMany({ where: { userId } });
      await prisma.category.deleteMany({ where: { userId } });
      await prisma.financeAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  }, 20000);

  it("returns totalBalance as the spendable balance (savings excluded) and savingsBalance separately", async () => {
    const result = await getDashboardData(withSavingsUserId);

    // Grand total would be 750000 + 2100000 = 2850000; totalBalance here
    // must be only the non-savings part.
    expect(result.totalBalance).toBe(750000);
    expect(result.savingsBalance).toBe(2100000);
    expect(result.totalBalance + result.savingsBalance).toBe(2850000);
    expect(result.hasSavingsAccount).toBe(true);
  });

  it("with no savings account, totalBalance is the full balance and savingsBalance is 0", async () => {
    const result = await getDashboardData(noSavingsUserId);

    expect(result.totalBalance).toBe(1000000);
    expect(result.savingsBalance).toBe(0);
    expect(result.hasSavingsAccount).toBe(false);
  });
});

// incomeReaction: what the user's active percent-based savings strategies say
// to set aside from income they just logged. Each case gets its own user so
// their strategies/transactions can't bleed into one another.
describe("getDashboardData - incomeReaction", () => {
  const userIds: number[] = [];

  async function createReactionUser(
    label: string,
    options: { withSavingsAccount?: boolean } = { withSavingsAccount: true }
  ) {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-DASHBOARD-REACTION-${label}-${Date.now()}` } });
    userIds.push(user.id);
    const cash = await prisma.financeAccount.create({
      data: { userId: user.id, name: "نقدی", type: "cash", initialBalance: 0 },
    });
    const savings = options.withSavingsAccount
      ? await prisma.financeAccount.create({
          data: { userId: user.id, name: "پس‌انداز", type: "savings", initialBalance: 0 },
        })
      : null;
    const [incomeCategory, transferIncomeCategory] = await Promise.all([
      prisma.category.create({
        data: { userId: user.id, name: "درآمد تست واکنش", icon: "💰", color: "#320001", type: "income" },
      }),
      prisma.category.create({
        data: {
          userId: user.id,
          name: "انتقال درآمد تست واکنش",
          icon: "🔄",
          color: "#320002",
          type: "income",
          isTransfer: true,
        },
      }),
    ]);
    return { userId: user.id, cash, savings, incomeCategory, transferIncomeCategory };
  }

  function createIncome(
    ctx: { userId: number; cash: { id: number } },
    categoryId: number,
    amount: number,
    createdAt: Date
  ) {
    return prisma.transaction.create({
      data: { userId: ctx.userId, accountId: ctx.cash.id, categoryId, amount, type: "income", rawInput: "تست", createdAt },
    });
  }

  afterEach(() => {
    vi.mocked(listAccounts).mockClear();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    for (const userId of userIds) {
      await prisma.savingsStrategy.deleteMany({ where: { userId } });
      await prisma.transaction.deleteMany({ where: { userId } });
      await prisma.category.deleteMany({ where: { userId } });
      await prisma.financeAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  }, 20000);

  it("is null, and skips both extra queries entirely, when there's no active percent-based strategy", async () => {
    const ctx = await createReactionUser("NO-STRATEGY");
    // A fresh real income that WOULD trigger the reaction if a percent-based
    // strategy existed - plus the two kinds of strategy that must not count:
    // amount-based, and percent-based but paused.
    await createIncome(ctx, ctx.incomeCategory.id, 1_000_000, new Date());
    await prisma.savingsStrategy.createMany({
      data: [
        { userId: ctx.userId, formulaType: "leftover", targetAmount: 500_000, status: "active" },
        { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "paused" },
      ],
    });

    const findFirstSpy = vi.spyOn(prisma.transaction, "findFirst");
    vi.mocked(listAccounts).mockClear();

    const result = await getDashboardData(ctx.userId);

    expect(result.incomeReaction).toBeNull();
    expect(findFirstSpy).not.toHaveBeenCalled();
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it("returns the suggested amount and transfer shortcut for each active percent-based strategy after a recent real income", async () => {
    const ctx = await createReactionUser("RECENT");
    const income = await createIncome(ctx, ctx.incomeCategory.id, 1_000_000, new Date());
    const [twenty, twelveAndHalf] = await Promise.all([
      prisma.savingsStrategy.create({
        data: { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "active" },
      }),
      prisma.savingsStrategy.create({
        data: { userId: ctx.userId, formulaType: "pay_yourself_first", targetPercent: 12.5, status: "active" },
      }),
      // Excluded: amount-based, and percent-based but paused.
      prisma.savingsStrategy.create({
        data: { userId: ctx.userId, formulaType: "leftover", targetAmount: 500_000, status: "active" },
      }),
      prisma.savingsStrategy.create({
        data: { userId: ctx.userId, formulaType: "custom", targetPercent: 30, status: "paused" },
      }),
    ]);

    // Positive control for the "skips both extra queries" test above: the
    // same spies must actually observe the calls when the reaction does run.
    const findFirstSpy = vi.spyOn(prisma.transaction, "findFirst");
    vi.mocked(listAccounts).mockClear();

    const { incomeReaction } = await getDashboardData(ctx.userId);

    expect(findFirstSpy).toHaveBeenCalledTimes(1);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(incomeReaction).not.toBeNull();
    // The income transaction's own id - the per-event key the banner's
    // persisted dismissal is keyed on.
    expect(incomeReaction!.incomeTransactionId).toBe(income.id);
    expect(incomeReaction!.incomeAmount).toBe(1_000_000);
    expect(incomeReaction!.items).toHaveLength(2);

    const byId = new Map(incomeReaction!.items.map((item) => [item.strategyId, item]));
    expect(byId.get(twenty.id)).toEqual({
      strategyId: twenty.id,
      label: "۵۰/۳۰/۲۰",
      percent: 20,
      suggestedAmount: 200_000,
      transferHref: `/app/transfer?from=${ctx.cash.id}&to=${ctx.savings!.id}&amount=200000&note=${encodeURIComponent(
        "پیاده‌سازی استراتژی ۵۰/۳۰/۲۰"
      )}`,
    });
    expect(byId.get(twelveAndHalf.id)).toEqual({
      strategyId: twelveAndHalf.id,
      label: "اول به خودت پرداخت کن",
      percent: 12.5,
      suggestedAmount: 125_000,
      transferHref: `/app/transfer?from=${ctx.cash.id}&to=${ctx.savings!.id}&amount=125000&note=${encodeURIComponent(
        "پیاده‌سازی استراتژی اول به خودت پرداخت کن"
      )}`,
    });
  });

  it("uses the most recent real income, not just any recent one", async () => {
    const ctx = await createReactionUser("LATEST");
    await createIncome(ctx, ctx.incomeCategory.id, 9_000_000, new Date(Date.now() - 60_000));
    await createIncome(ctx, ctx.incomeCategory.id, 500_000, new Date());
    await prisma.savingsStrategy.create({
      data: { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "active" },
    });

    const { incomeReaction } = await getDashboardData(ctx.userId);

    expect(incomeReaction!.incomeAmount).toBe(500_000);
    expect(incomeReaction!.items[0].suggestedAmount).toBe(100_000);
  });

  it("omits transferHref (but keeps the item) when there's no savings account to transfer into", async () => {
    const ctx = await createReactionUser("NO-SAVINGS-ACCOUNT", { withSavingsAccount: false });
    await createIncome(ctx, ctx.incomeCategory.id, 1_000_000, new Date());
    await prisma.savingsStrategy.create({
      data: { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "active" },
    });

    const { incomeReaction } = await getDashboardData(ctx.userId);

    expect(incomeReaction!.items).toHaveLength(1);
    expect(incomeReaction!.items[0].suggestedAmount).toBe(200_000);
    expect(incomeReaction!.items[0].transferHref).toBeNull();
  });

  it("is null when the most recent real income is older than INCOME_REACTION_WINDOW_MS", async () => {
    const ctx = await createReactionUser("STALE");
    await createIncome(ctx, ctx.incomeCategory.id, 1_000_000, new Date(Date.now() - INCOME_REACTION_WINDOW_MS - 60_000));
    await prisma.savingsStrategy.create({
      data: { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "active" },
    });

    const { incomeReaction } = await getDashboardData(ctx.userId);

    expect(incomeReaction).toBeNull();
  });

  it("ignores a fresh Category.isTransfer income leg - it isn't income the user earned", async () => {
    const ctx = await createReactionUser("TRANSFER-LEG");
    // Only a transfer's destination leg is recent; the real income is stale,
    // so if the transfer leg were mistaken for income it would be the one
    // picked as "latest" and trigger the reaction.
    await createIncome(ctx, ctx.incomeCategory.id, 1_000_000, new Date(Date.now() - INCOME_REACTION_WINDOW_MS - 60_000));
    await createIncome(ctx, ctx.transferIncomeCategory.id, 700_000, new Date());
    await prisma.savingsStrategy.create({
      data: { userId: ctx.userId, formulaType: "fifty_thirty_twenty", targetPercent: 20, status: "active" },
    });

    const { incomeReaction } = await getDashboardData(ctx.userId);

    expect(incomeReaction).toBeNull();
  });
});
