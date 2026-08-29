import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateAccount, deleteAccount, getTotalBalance, AccountNotFoundError, AccountInUseError } from "@/lib/data/accounts";

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
