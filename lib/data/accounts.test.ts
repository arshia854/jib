import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import {
  updateAccount,
  deleteAccount,
  getTotalBalance,
  getSavingsBalance,
  getBalances,
  getSavingsTransferredThisMonth,
  getAccountBalance,
  AccountNotFoundError,
  AccountInUseError,
} from "@/lib/data/accounts";

// Old, pre-Phase-17 calculation (docs/roadmap-status.md) - loads every
// transaction row for the user's accounts and sums in JS, exactly what
// getTotalBalance() replaced. Kept here, standalone, only to prove the new
// bounded-aggregate query produces an identical result - not reintroduced
// anywhere in application code.
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

// Phase 3.2 regression coverage: proves the { id, userId } ownership check
// on updateAccount/deleteAccount actually blocks cross-user access. No
// vulnerability was found here (see security-audit-report.md and the
// Phase 0 audit) - this locks the already-correct behavior in place
// against future regressions.
describe("cross-user ownership", () => {
  let userAId: number;
  let userBId: number;
  let accountAId: number;

  beforeAll(async () => {
    const userA = await prisma.user.create({ data: { phoneNumber: `TEST-ACCOUNT-OWNERSHIP-A-${Date.now()}` } });
    userAId = userA.id;
    const userB = await prisma.user.create({ data: { phoneNumber: `TEST-ACCOUNT-OWNERSHIP-B-${Date.now()}` } });
    userBId = userB.id;

    const accountA = await prisma.financeAccount.create({
      data: { userId: userAId, name: "حساب اصلی الف", type: "cash", initialBalance: 500000 },
    });
    accountAId = accountA.id;
  }, 20000);

  afterAll(async () => {
    await prisma.financeAccount.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  }, 20000);

  // See the matching comment in lib/data/transactions.test.ts's "cross-user
  // ownership" block: generous explicit timeouts here account for real
  // live-Turso network latency (T-1 in security-audit-report.md), not a
  // slow assertion.
  it(
    "updateAccount throws AccountNotFoundError when called by another user, and leaves the row untouched",
    async () => {
      await expect(updateAccount(userBId, accountAId, { name: "دستکاری شده" })).rejects.toBeInstanceOf(
        AccountNotFoundError
      );

      const untouched = await prisma.financeAccount.findUnique({ where: { id: accountAId } });
      expect(untouched?.name).toBe("حساب اصلی الف");
    },
    15000
  );

  it(
    "deleteAccount throws AccountNotFoundError when called by another user, and the row still exists after",
    async () => {
      await expect(deleteAccount(userBId, accountAId)).rejects.toBeInstanceOf(AccountNotFoundError);

      const stillThere = await prisma.financeAccount.findUnique({ where: { id: accountAId } });
      expect(stillThere).not.toBeNull();
    },
    15000
  );

  it(
    "the owner can still update their own account (sanity check the block above is ownership-specific)",
    async () => {
      const updated = await updateAccount(userAId, accountAId, { name: "حساب اصلی الف - ویرایش شده" });
      expect(updated.name).toBe("حساب اصلی الف - ویرایش شده");
    },
    15000
  );
});

// Database checklist (docs/roadmap-status.md, Phase 16): "Deletion
// behavior: onDelete: Restrict on... FinanceAccount->Transaction... a
// category/account with existing transactions can't be deleted - confirm
// this is tested, not just declared in schema." deleteAccount() already
// enforces this at the application level via a pre-check (see
// lib/data/accounts.ts) - this had zero test coverage before this session.
describe("deleteAccount - in-use protection (Restrict)", () => {
  let userId: number;
  let categoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-ACCOUNT-INUSE-${Date.now()}` } });
    userId = user.id;
    const category = await prisma.category.create({
      data: { userId, name: "دسته تست حساب در حال استفاده", icon: "🧪", color: "#333333", type: "expense" },
    });
    categoryId = category.id;
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "rejects deleting an account referenced by an existing transaction, and leaves both rows intact",
    async () => {
      const account = await prisma.financeAccount.create({
        data: { userId, name: "حساب در حال استفاده", type: "cash", initialBalance: 0 },
      });
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          accountId: account.id,
          categoryId,
          amount: 50000,
          type: "expense",
          date: new Date(),
          rawInput: "تست",
        },
      });

      await expect(deleteAccount(userId, account.id)).rejects.toBeInstanceOf(AccountInUseError);

      expect(await prisma.financeAccount.findUnique({ where: { id: account.id } })).not.toBeNull();
      expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).not.toBeNull();
    },
    15000
  );

  it(
    "succeeds once the referencing transaction is gone",
    async () => {
      const account = await prisma.financeAccount.create({
        data: { userId, name: "حساب موقتاً در حال استفاده", type: "cash", initialBalance: 0 },
      });
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          accountId: account.id,
          categoryId,
          amount: 30000,
          type: "expense",
          date: new Date(),
          rawInput: "تست",
        },
      });

      await expect(deleteAccount(userId, account.id)).rejects.toBeInstanceOf(AccountInUseError);

      await prisma.transaction.delete({ where: { id: transaction.id } });

      await expect(deleteAccount(userId, account.id)).resolves.toMatchObject({ id: account.id });
      expect(await prisma.financeAccount.findUnique({ where: { id: account.id } })).toBeNull();
    },
    15000
  );
});

// Phase 17 (docs/roadmap-status.md): getTotalBalance() replaced
// lib/data/dashboard.ts's/lib/analytics/spending-summary.ts's identical
// "load every transaction row, sum in JS" pattern with a bounded aggregate
// (financeAccount.findMany for id/initialBalance + transaction.groupBy by
// accountId+type with _sum(amount)). This proves the new query produces the
// exact same result as the old full-load calculation (oldFullLoadTotalBalance
// above) for a nontrivial history: 3 accounts, mixed income/expense,
// transactions spread across several months and both transfer/non-transfer
// categories (totalBalance must still include transfers - see
// dashboard.test.ts's identical rule).
describe("getTotalBalance", () => {
  let userId: number;
  let accountAId: number;
  let accountBId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-TOTAL-BALANCE-${Date.now()}` } });
    userId = user.id;

    const [accountA, accountB] = await Promise.all([
      prisma.financeAccount.create({ data: { userId, name: "حساب نقدی", type: "cash", initialBalance: 500000 } }),
      prisma.financeAccount.create({ data: { userId, name: "حساب بانکی", type: "bank", initialBalance: 1200000 } }),
      // Zero transactions at all - must still contribute its initialBalance,
      // and must not make the groupBy-based join drop it (it produces no
      // groupBy rows, unlike A/B). Not asserted on directly by id (no
      // transaction ever references it), only through its initialBalance's
      // contribution to the final totalBalance below.
      prisma.financeAccount.create({ data: { userId, name: "حساب خالی", type: "cash", initialBalance: 75000 } }),
    ]);
    accountAId = accountA.id;
    accountBId = accountB.id;

    const [expenseCategory, incomeCategory, transferExpenseCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه تست موجودی", icon: "🧾", color: "#111111", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد تست موجودی", icon: "💵", color: "#222222", type: "income" },
      }),
      prisma.category.create({
        data: { userId, name: "انتقال تست موجودی", icon: "🔁", color: "#333333", type: "expense", isTransfer: true },
      }),
    ]);

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    // Spread across several months (not just the current one) and across
    // both accounts A and B, mixing income/expense/transfer - a single
    // month's worth wouldn't exercise "nontrivial history" the way this
    // task asks for.
    await Promise.all([
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: expenseCategory.id, amount: 40000, type: "expense", rawInput: "تست", date: new Date(now - 200 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: incomeCategory.id, amount: 900000, type: "income", rawInput: "تست", date: new Date(now - 150 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountAId, categoryId: expenseCategory.id, amount: 65000, type: "expense", rawInput: "تست", date: new Date(now - 20 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: incomeCategory.id, amount: 300000, type: "income", rawInput: "تست", date: new Date(now - 90 * dayMs) },
      }),
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: expenseCategory.id, amount: 250000, type: "expense", rawInput: "تست", date: new Date(now - 5 * dayMs) },
      }),
      // A transfer - must still count toward totalBalance (it moves real
      // money between real account balances), unlike currentMonth's income/
      // expense aggregates elsewhere in the app.
      prisma.transaction.create({
        data: { userId, accountId: accountBId, categoryId: transferExpenseCategory.id, amount: 80000, type: "expense", rawInput: "تست", date: new Date(now - 2 * dayMs) },
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

  it("matches the old full-load calculation for a nontrivial multi-account, mixed income/expense history", async () => {
    const [expected, actual] = await Promise.all([oldFullLoadTotalBalance(userId), getTotalBalance(userId)]);

    // Not just equal to each other - pinned to the actual expected number so
    // a bug shared by both implementations couldn't silently pass this
    // test: 500000 + 1200000 + 75000 (initial balances) + 900000 + 300000
    // (income) - 40000 - 65000 - 250000 - 80000 (expense, incl. the
    // transfer) = 2540000.
    expect(expected).toBe(2540000);
    expect(actual).toBe(expected);
  });

  it("accepts an explicit client override (mirrors getSpendingSummary's own DI pattern)", async () => {
    const actual = await getTotalBalance(userId, prisma);
    expect(actual).toBe(2540000);
  });
});

// Phase A3 (docs/roadmap-status.md savings roadmap). Reuses the same
// loadAccountBalanceInputs/sumAccountBalances plumbing getTotalBalance's own
// suite above already exercises for the unscoped case - this only needs to
// prove the `type: "savings"` scoping itself: a non-savings account's
// activity must not leak into the sum, and a savings account with zero
// transactions still contributes its own initialBalance.
describe("getSavingsBalance", () => {
  let userId: number;
  let savingsAccountId: number;
  let cashAccountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-BALANCE-${Date.now()}` } });
    userId = user.id;

    const [savingsAccount, , cashAccount] = await Promise.all([
      prisma.financeAccount.create({
        data: { userId, name: "پس‌انداز اول", type: "savings", initialBalance: 1_000_000 },
      }),
      // Zero transactions - must still contribute its initialBalance to the
      // savings-scoped sum, same "empty account still counts" case
      // getTotalBalance's own suite covers above. Its own id is never
      // needed (no transaction references it), same as that suite's own
      // "حساب خالی" fixture.
      prisma.financeAccount.create({
        data: { userId, name: "پس‌انداز دوم", type: "savings", initialBalance: 250000 },
      }),
      // A non-savings account with its own real activity - must be entirely
      // excluded from getSavingsBalance's sum despite belonging to the same
      // user, which is the actual behavior this suite exists to prove
      // (getTotalBalance's own suite already covers the unscoped case).
      prisma.financeAccount.create({ data: { userId, name: "نقدی", type: "cash", initialBalance: 5_000_000 } }),
    ]);
    savingsAccountId = savingsAccount.id;
    cashAccountId = cashAccount.id;

    const [expenseCategory, incomeCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه تست پس‌انداز", icon: "🧾", color: "#111111", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد تست پس‌انداز", icon: "💵", color: "#222222", type: "income" },
      }),
    ]);

    await Promise.all([
      prisma.transaction.create({
        data: {
          userId,
          accountId: savingsAccountId,
          categoryId: incomeCategory.id,
          amount: 300000,
          type: "income",
          rawInput: "تست",
          date: new Date(),
        },
      }),
      prisma.transaction.create({
        data: {
          userId,
          accountId: savingsAccountId,
          categoryId: expenseCategory.id,
          amount: 50000,
          type: "expense",
          rawInput: "تست",
          date: new Date(),
        },
      }),
      // Real activity on the non-savings account - must not affect
      // getSavingsBalance's result at all.
      prisma.transaction.create({
        data: {
          userId,
          accountId: cashAccountId,
          categoryId: incomeCategory.id,
          amount: 9_000_000,
          type: "income",
          rawInput: "تست",
          date: new Date(),
        },
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

  it("sums only savings-type accounts: (1,000,000 + 300,000 - 50,000) + 250,000 = 1,500,000, ignoring the cash account entirely", async () => {
    const actual = await getSavingsBalance(userId);
    expect(actual).toBe(1_500_000);
  });

  it("accepts an explicit client override, same DI pattern as getTotalBalance", async () => {
    const actual = await getSavingsBalance(userId, prisma);
    expect(actual).toBe(1_500_000);
  });
});

// Turso latency fix (docs/roadmap-status.md): getBalances() runs
// loadAccountBalanceInputs ONCE (unscoped) and derives both figures in JS,
// replacing getDashboardData()'s previous two separate calls to
// getTotalBalance()/getSavingsBalance() (4 queries total). This proves the
// merged call produces the exact same {totalBalance, savingsBalance} pair as
// calling the two old functions separately, across several seeded scenarios:
// mixed account types with income/expense activity on each, a user with no
// savings account at all, and a user with only savings accounts.
describe("getBalances", () => {
  let mixedUserId: number;
  let noSavingsUserId: number;
  let onlySavingsUserId: number;

  async function seedAccountWithActivity(
    userId: number,
    type: string,
    initialBalance: number,
    activity: { income?: number; expense?: number }
  ) {
    const account = await prisma.financeAccount.create({ data: { userId, name: `حساب ${type}`, type, initialBalance } });
    const [incomeCategory, expenseCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: `درآمد تست ${type} ${account.id}`, icon: "💵", color: "#222222", type: "income" },
      }),
      prisma.category.create({
        data: { userId, name: `هزینه تست ${type} ${account.id}`, icon: "🧾", color: "#111111", type: "expense" },
      }),
    ]);
    await Promise.all([
      activity.income
        ? prisma.transaction.create({
            data: {
              userId,
              accountId: account.id,
              categoryId: incomeCategory.id,
              amount: activity.income,
              type: "income",
              rawInput: "تست",
              date: new Date(),
            },
          })
        : null,
      activity.expense
        ? prisma.transaction.create({
            data: {
              userId,
              accountId: account.id,
              categoryId: expenseCategory.id,
              amount: activity.expense,
              type: "expense",
              rawInput: "تست",
              date: new Date(),
            },
          })
        : null,
    ]);
    return account.id;
  }

  beforeAll(async () => {
    const [mixedUser, noSavingsUser, onlySavingsUser] = await Promise.all([
      prisma.user.create({ data: { phoneNumber: `TEST-GET-BALANCES-MIXED-${Date.now()}` } }),
      prisma.user.create({ data: { phoneNumber: `TEST-GET-BALANCES-NO-SAVINGS-${Date.now()}` } }),
      prisma.user.create({ data: { phoneNumber: `TEST-GET-BALANCES-ONLY-SAVINGS-${Date.now()}` } }),
    ]);
    mixedUserId = mixedUser.id;
    noSavingsUserId = noSavingsUser.id;
    onlySavingsUserId = onlySavingsUser.id;

    // Mixed: cash + savings + bank, each with its own income/expense activity.
    await Promise.all([
      seedAccountWithActivity(mixedUserId, "cash", 500_000, { income: 200_000, expense: 80_000 }),
      seedAccountWithActivity(mixedUserId, "savings", 300_000, { income: 150_000, expense: 50_000 }),
      seedAccountWithActivity(mixedUserId, "bank", 100_000, { income: 50_000 }),
    ]);

    // No savings account at all - getBalances' savingsBalance must come back
    // as sumAccountBalances([], []) = 0, not error or leak in other types.
    await Promise.all([
      seedAccountWithActivity(noSavingsUserId, "cash", 1_000_000, { expense: 200_000 }),
      seedAccountWithActivity(noSavingsUserId, "bank", 2_000_000, { income: 500_000 }),
    ]);

    // Only savings accounts - totalBalance and savingsBalance must be equal.
    await Promise.all([
      seedAccountWithActivity(onlySavingsUserId, "savings", 700_000, { income: 100_000, expense: 30_000 }),
      // Second savings account with zero transactions - still counted.
      prisma.financeAccount.create({
        data: { userId: onlySavingsUserId, name: "پس‌انداز دوم بدون تراکنش", type: "savings", initialBalance: 200_000 },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    const userIds = [mixedUserId, noSavingsUserId, onlySavingsUserId];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 20000);

  it("matches getTotalBalance/getSavingsBalance called separately: mixed account types with activity on each", async () => {
    const [expectedTotal, expectedSavings, actual] = await Promise.all([
      getTotalBalance(mixedUserId),
      getSavingsBalance(mixedUserId),
      getBalances(mixedUserId),
    ]);

    // 620,000 (cash) + 400,000 (savings) + 150,000 (bank) = 1,170,000
    expect(expectedTotal).toBe(1_170_000);
    expect(expectedSavings).toBe(400_000);
    expect(actual).toEqual({ totalBalance: expectedTotal, savingsBalance: expectedSavings });
  });

  it("matches getTotalBalance/getSavingsBalance called separately: no savings account at all", async () => {
    const [expectedTotal, expectedSavings, actual] = await Promise.all([
      getTotalBalance(noSavingsUserId),
      getSavingsBalance(noSavingsUserId),
      getBalances(noSavingsUserId),
    ]);

    expect(expectedTotal).toBe(3_300_000);
    expect(expectedSavings).toBe(0);
    expect(actual).toEqual({ totalBalance: expectedTotal, savingsBalance: expectedSavings });
  });

  it("matches getTotalBalance/getSavingsBalance called separately: only savings accounts (total equals savings)", async () => {
    const [expectedTotal, expectedSavings, actual] = await Promise.all([
      getTotalBalance(onlySavingsUserId),
      getSavingsBalance(onlySavingsUserId),
      getBalances(onlySavingsUserId),
    ]);

    expect(expectedTotal).toBe(970_000);
    expect(expectedSavings).toBe(970_000);
    expect(actual).toEqual({ totalBalance: expectedTotal, savingsBalance: expectedSavings });
  });

  it("accepts an explicit client override, same DI pattern as getTotalBalance/getSavingsBalance", async () => {
    const actual = await getBalances(mixedUserId, prisma);
    expect(actual).toEqual({ totalBalance: 1_170_000, savingsBalance: 400_000 });
  });
});

// Phase B1 (docs/roadmap-status.md savings roadmap): getAccountBalance()
// backs Goal.savingsAccountId (see lib/goals/feasibility.ts's
// getGoalBalanceInputs) - one account's own balance, ownership-checked.
// Reuses the identical loadAccountBalanceInputs/sumAccountBalances plumbing
// getTotalBalance/getSavingsBalance's own suites above already exercise for
// the unscoped/type-scoped cases - this only needs to prove the single-
// account scoping and the ownership check itself.
describe("getAccountBalance", () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-ACCOUNT-BALANCE-${Date.now()}` } });
    userId = user.id;
    const otherUser = await prisma.user.create({ data: { phoneNumber: `TEST-ACCOUNT-BALANCE-OTHER-${Date.now()}` } });
    otherUserId = otherUser.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "پس‌انداز تست موجودی حساب", type: "savings", initialBalance: 2_000_000 },
    });
    accountId = account.id;
    // A second account for the same user - proves getAccountBalance sums
    // only the one requested account, not every account this user owns
    // (unlike getTotalBalance/getSavingsBalance).
    const otherAccount = await prisma.financeAccount.create({
      data: { userId, name: "نقدی دیگر", type: "cash", initialBalance: 9_000_000 },
    });

    const [expenseCategory, incomeCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "هزینه تست موجودی حساب", icon: "🧾", color: "#111111", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: "درآمد تست موجودی حساب", icon: "💵", color: "#222222", type: "income" },
      }),
    ]);

    await Promise.all([
      prisma.transaction.create({
        data: { userId, accountId, categoryId: incomeCategory.id, amount: 500_000, type: "income", rawInput: "تست", date: new Date() },
      }),
      prisma.transaction.create({
        data: { userId, accountId, categoryId: expenseCategory.id, amount: 200_000, type: "expense", rawInput: "تست", date: new Date() },
      }),
      // Real activity on the user's *other* account - must not leak into
      // getAccountBalance(accountId)'s result.
      prisma.transaction.create({
        data: { userId, accountId: otherAccount.id, categoryId: incomeCategory.id, amount: 7_000_000, type: "income", rawInput: "تست", date: new Date() },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  }, 20000);

  it("sums only the requested account: 2,000,000 + 500,000 - 200,000 = 2,300,000, ignoring the user's other account entirely", async () => {
    const actual = await getAccountBalance(userId, accountId);
    expect(actual).toBe(2_300_000);
  });

  it(
    "rejects a different user's account with AccountNotFoundError (same ownership check as updateAccount/deleteAccount)",
    async () => {
      await expect(getAccountBalance(otherUserId, accountId)).rejects.toBeInstanceOf(AccountNotFoundError);
    },
    15000
  );
});

// Savings page's "this month" progress figure. One aggregate over
// destination-leg transfer transactions (type "income", transferGroupId set)
// into savings-type accounts within the current Jalali month, [start, end).
// Fixtures pin each exclusion rule individually so a regression in any one
// filter (type, transferGroupId, account type, date window, userId) flips
// exactly one assertion's expected number.
describe("getSavingsTransferredThisMonth", () => {
  let userId: number;
  let otherUserId: number;
  let emptyUserId: number;

  beforeAll(async () => {
    const [user, otherUser, emptyUser] = await Promise.all([
      prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-TRANSFERRED-${Date.now()}` } }),
      prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-TRANSFERRED-OTHER-${Date.now()}` } }),
      prisma.user.create({ data: { phoneNumber: `TEST-SAVINGS-TRANSFERRED-EMPTY-${Date.now()}` } }),
    ]);
    userId = user.id;
    otherUserId = otherUser.id;
    emptyUserId = emptyUser.id;

    const [savingsAccount, bankAccount, otherSavingsAccount] = await Promise.all([
      prisma.financeAccount.create({ data: { userId, name: "پس‌انداز", type: "savings", initialBalance: 0 } }),
      prisma.financeAccount.create({ data: { userId, name: "بانک", type: "bank", initialBalance: 0 } }),
      prisma.financeAccount.create({
        data: { userId: otherUserId, name: "پس‌انداز کاربر دیگر", type: "savings", initialBalance: 0 },
      }),
    ]);

    const [category, otherCategory] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "انتقال تست پس‌انداز ماهانه", icon: "🔁", color: "#333333", type: "income", isTransfer: true },
      }),
      prisma.category.create({
        data: {
          userId: otherUserId,
          name: "انتقال تست پس‌انداز ماهانه کاربر دیگر",
          icon: "🔁",
          color: "#333333",
          type: "income",
          isTransfer: true,
        },
      }),
    ]);

    const { start, end } = getJalaaliMonthRange();
    const lastMonth = new Date(start.getTime() - 1);
    const now = new Date();

    const base = { userId, categoryId: category.id, rawInput: "تست" };
    await Promise.all([
      // Counts: two destination legs into savings this month (summed).
      prisma.transaction.create({
        data: { ...base, accountId: savingsAccount.id, amount: 400_000, type: "income", date: now, transferGroupId: "TEST-STM-1" },
      }),
      prisma.transaction.create({
        // Exactly at the month's start - the window is inclusive here.
        data: { ...base, accountId: savingsAccount.id, amount: 100_000, type: "income", date: start, transferGroupId: "TEST-STM-2" },
      }),
      // The matching source leg of the first transfer (expense, on the bank
      // account) - not income, not on a savings account.
      prisma.transaction.create({
        data: { ...base, accountId: bankAccount.id, amount: 400_000, type: "expense", date: now, transferGroupId: "TEST-STM-1" },
      }),
      // Plain income logged directly against the savings account (no
      // transferGroupId) - deliberately not counted.
      prisma.transaction.create({
        data: { ...base, accountId: savingsAccount.id, amount: 9_000_000, type: "income", date: now },
      }),
      // Transfer into savings from last month - out of window.
      prisma.transaction.create({
        data: { ...base, accountId: savingsAccount.id, amount: 7_000_000, type: "income", date: lastMonth, transferGroupId: "TEST-STM-3" },
      }),
      // Transfer into savings dated at the next month's first instant - the
      // window's end is exclusive.
      prisma.transaction.create({
        data: { ...base, accountId: savingsAccount.id, amount: 6_000_000, type: "income", date: end, transferGroupId: "TEST-STM-4" },
      }),
      // Transfer income into a non-savings account this month.
      prisma.transaction.create({
        data: { ...base, accountId: bankAccount.id, amount: 5_000_000, type: "income", date: now, transferGroupId: "TEST-STM-5" },
      }),
      // Another user's qualifying transfer - must not leak in.
      prisma.transaction.create({
        data: {
          userId: otherUserId,
          categoryId: otherCategory.id,
          rawInput: "تست",
          accountId: otherSavingsAccount.id,
          amount: 3_000_000,
          type: "income",
          date: now,
          transferGroupId: "TEST-STM-6",
        },
      }),
    ]);
  }, 20000);

  afterAll(async () => {
    const userIds = [userId, otherUserId, emptyUserId];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  }, 20000);

  it("sums only this month's transfer-tagged income into savings accounts: 400,000 + 100,000 = 500,000", async () => {
    // Excluded by construction: the expense leg (type), the plain 9,000,000
    // income (no transferGroupId), last month's 7,000,000 and next month's
    // 6,000,000 (date window), the 5,000,000 into a bank account (account
    // type), and the other user's 3,000,000 (userId).
    expect(await getSavingsTransferredThisMonth(userId)).toBe(500_000);
  });

  it("returns 0 for a user with no qualifying transfers", async () => {
    expect(await getSavingsTransferredThisMonth(emptyUserId)).toBe(0);
  });

  it("accepts an explicit client override, same DI pattern as getSavingsBalance", async () => {
    expect(await getSavingsTransferredThisMonth(userId, prisma)).toBe(500_000);
  });
});
