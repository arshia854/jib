import "server-only";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";
import { getJalaaliMonthRange } from "@/lib/format";

type PrismaClient = typeof prisma;

// Phase 17 (docs/roadmap-status.md): the shared totalBalance calculation
// for a user's accounts, used by both lib/data/dashboard.ts and
// lib/analytics/spending-summary.ts (previously two separate, identical
// copies of the same bug). The old approach in both places was
// `financeAccount.findMany({ include: { transactions: { select: {amount,
// type} } } })` - loading EVERY transaction row ever created for the
// user's accounts just to sum them in JS, unbounded growth with usage.
// Replaced with a bounded aggregate: the accounts themselves (small,
// bounded by how many real financial accounts a person has - see the
// Phase 4.1 follow-up #3 entry's identical reasoning for why GET
// /api/accounts was left unpaginated) plus one groupBy over
// accountId+type with _sum(amount) - output is at most
// (account count x 2 types) rows, regardless of how many transactions
// exist. `client` defaults to the shared `prisma` singleton but can be
// swapped (mirrors getSpendingSummary's own `client` param in
// lib/analytics/spending-summary.ts) so that caller can pass its own
// client through unchanged.
//
// Measured (local SQLite test DB, 3 accounts, 20,000 seeded transactions,
// through the real generated Prisma Client + @prisma/adapter-libsql - see
// docs/roadmap-status.md's Phase 17 entry for the full script/output):
// old pattern loaded 20,000 rows into JS in ~786ms; this loads 9 rows
// (3 accounts + 6 groupBy rows) in ~81ms - ~9.7x faster locally, with the
// gap only growing with transaction history size and widening further
// once real Turso network round-trip cost (not just local-file I/O) is
// factored in for every one of those 20,000 rows. Verified to produce the
// exact same totalBalance as the old calculation in that same run.
// Shared by getTotalBalance and getSavingsBalance (Phase A3, savings
// roadmap) below - both need the exact same "accounts' initialBalance +
// net(income - expense) per account" arithmetic, only differing in which
// accounts they scope to. Pulled out rather than duplicated so the savings
// card's number is provably computed the same way total balance is, not a
// second, independently-written (and independently-buggable) copy.
function sumAccountBalances(
  accounts: { id: number; initialBalance: number }[],
  balanceGroups: { accountId: number; type: string; _sum: { amount: number | null } }[]
): number {
  const netByAccount = new Map<number, number>();
  for (const g of balanceGroups) {
    const delta = g.type === "income" ? (g._sum.amount ?? 0) : -(g._sum.amount ?? 0);
    netByAccount.set(g.accountId, (netByAccount.get(g.accountId) ?? 0) + delta);
  }

  return accounts.reduce((sum, a) => sum + a.initialBalance + (netByAccount.get(a.id) ?? 0), 0);
}

// The queries getTotalBalance/getSavingsBalance/getAccountBalance all run,
// optionally scoped to one FinanceAccount.type and/or one specific account
// id. `type` filters both the accounts themselves and, via the relation,
// which of their transactions get grouped - a transaction whose account
// isn't of the requested type is excluded from the groupBy the same way its
// account is excluded from the findMany, so the two inputs to
// sumAccountBalances above stay consistent with each other. `accountId`
// (Phase B1, savings roadmap - getAccountBalance below) narrows the same way,
// down to exactly one account - both filters can combine, though no current
// caller passes both at once.
async function loadAccountBalanceInputs(userId: number, client: PrismaClient, type?: string, accountId?: number) {
  const [accounts, balanceGroups] = await Promise.all([
    client.financeAccount.findMany({
      where: { userId, ...(type ? { type } : {}), ...(accountId ? { id: accountId } : {}) },
      // `type` included alongside the pre-existing id/initialBalance so
      // getBalances() below can split one unscoped call's accounts into
      // "all" vs "savings only" in JS, without a second, type-scoped query -
      // sumAccountBalances only ever reads id/initialBalance, so this extra
      // field is inert for every other caller.
      select: { id: true, initialBalance: true, type: true },
    }),
    client.transaction.groupBy({
      by: ["accountId", "type"],
      where: { userId, ...(type ? { account: { type } } : {}), ...(accountId ? { accountId } : {}) },
      _sum: { amount: true },
    }),
  ]);
  return { accounts, balanceGroups };
}

export async function getTotalBalance(userId: number, client: PrismaClient = prisma): Promise<number> {
  const { accounts, balanceGroups } = await loadAccountBalanceInputs(userId, client);
  return sumAccountBalances(accounts, balanceGroups);
}

// Phase A3 (docs/roadmap-status.md savings roadmap): same bounded-aggregate
// approach as getTotalBalance above, scoped to `type: "savings"` accounts
// only - backs the dashboard's savings card. Not a second, slower N+1
// version (looping accounts and querying each one's transactions
// individually) - reuses the identical two-query-then-reduce shape via
// loadAccountBalanceInputs/sumAccountBalances above, just with the type
// filter applied to both queries.
export async function getSavingsBalance(userId: number, client: PrismaClient = prisma): Promise<number> {
  const { accounts, balanceGroups } = await loadAccountBalanceInputs(userId, client, "savings");
  return sumAccountBalances(accounts, balanceGroups);
}

// Turso latency fix (docs/roadmap-status.md): getDashboardData() used to call
// getTotalBalance() and getSavingsBalance() separately, each independently
// running loadAccountBalanceInputs - 2 queries apiece, 4 round-trips total
// for one dashboard render, even though the unscoped (all-accounts) result
// already contains everything the savings-only result needs. This runs
// loadAccountBalanceInputs ONCE, unscoped, and derives both figures in JS
// from that one shared (accounts, balanceGroups) pair via the same
// sumAccountBalances arithmetic getTotalBalance/getSavingsBalance themselves
// use - not a second, independently-written calculation. getTotalBalance and
// getSavingsBalance above are untouched and still used by every other caller
// (lib/analytics/spending-summary.ts, getAccountBalance below) - this is
// purely an additional, dashboard-specific shortcut.
export async function getBalances(
  userId: number,
  client: PrismaClient = prisma
): Promise<{ totalBalance: number; savingsBalance: number }> {
  const { accounts, balanceGroups } = await loadAccountBalanceInputs(userId, client);
  const savingsAccounts = accounts.filter((a) => a.type === "savings");
  const savingsAccountIds = new Set(savingsAccounts.map((a) => a.id));
  const savingsBalanceGroups = balanceGroups.filter((g) => savingsAccountIds.has(g.accountId));
  return {
    totalBalance: sumAccountBalances(accounts, balanceGroups),
    savingsBalance: sumAccountBalances(savingsAccounts, savingsBalanceGroups),
  };
}

// Savings page's "this month" progress figure (per active SavingsStrategy row,
// components/savings/savings-manager.tsx): how much was actually transferred
// into a savings account during the current Jalali month. Derived from real
// transfer transactions, not a stored expected/actual event - one bounded
// aggregate (same discipline as getTotalBalance/getSavingsBalance above), not
// a findMany + JS reduce.
//
// Counts only the destination leg of an internal transfer (type "income" +
// non-null transferGroupId) whose account is savings-type. A plain income
// logged directly against a savings account (no transferGroupId) is
// deliberately excluded - it isn't the "did you actually do the transfer"
// signal this figure exists to show. `date` is bounded [start, end) - `end`
// from getJalaaliMonthRange is the first instant of the *next* month.
export async function getSavingsTransferredThisMonth(userId: number, client: PrismaClient = prisma): Promise<number> {
  const { start, end } = getJalaaliMonthRange();
  const result = await client.transaction.aggregate({
    where: {
      userId,
      type: "income",
      transferGroupId: { not: null },
      account: { type: "savings" },
      date: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

// Shared ownership-check shape reused wherever a foreign id into
// FinanceAccount needs validating against a userId before it's trusted -
// same `{ id, userId }` findFirst-then-throw pattern updateAccount/
// deleteAccount below already use inline, pulled out here so
// getAccountBalance and lib/data/goals.ts's createGoal/updateGoal (Phase B1,
// savings roadmap - validating Goal.savingsAccountId) share the exact same
// check instead of each re-writing it.
export async function assertAccountOwnership(
  userId: number,
  accountId: number,
  client: PrismaClient = prisma
): Promise<void> {
  const existing = await client.financeAccount.findFirst({ where: { id: accountId, userId } });
  if (!existing) {
    throw new AccountNotFoundError("حساب یافت نشد.");
  }
}

// Phase B1 (docs/roadmap-status.md savings roadmap): one account's own
// balance, for a Goal linked to it via Goal.savingsAccountId - same
// bounded-aggregate shape as getTotalBalance/getSavingsBalance above (no
// duplicated arithmetic), just scoped to a single account id instead of a
// type. Verifies ownership first (assertAccountOwnership) so a goal that
// somehow references another user's account - or an id that no longer
// exists - fails loudly with AccountNotFoundError rather than silently
// returning 0 (which loadAccountBalanceInputs' own userId-scoped queries
// would otherwise do for a non-owned/missing account, indistinguishable
// from a real, owned, zero-balance account).
export async function getAccountBalance(
  userId: number,
  accountId: number,
  client: PrismaClient = prisma
): Promise<number> {
  await assertAccountOwnership(userId, accountId, client);
  const { accounts, balanceGroups } = await loadAccountBalanceInputs(userId, client, undefined, accountId);
  return sumAccountBalances(accounts, balanceGroups);
}

export async function getDefaultAccount(userId: number) {
  const existing = await prisma.financeAccount.findFirst({ where: { userId }, orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.financeAccount.create({ data: { ...DEFAULT_ACCOUNT, userId } });
}

export async function listAccounts(userId: number) {
  return prisma.financeAccount.findMany({ where: { userId }, orderBy: { id: "asc" } });
}

export async function listAccountsWithUsage(userId: number) {
  const accounts = await listAccounts(userId);
  const counts = await prisma.transaction.groupBy({
    by: ["accountId"],
    where: { userId },
    _count: { accountId: true },
  });
  const countMap = new Map(counts.map((c) => [c.accountId, c._count.accountId]));
  return accounts.map((account) => ({
    ...account,
    transactionCount: countMap.get(account.id) ?? 0,
  }));
}

export async function createAccount(
  userId: number,
  data: { name: string; type: string; initialBalance?: number }
) {
  return prisma.financeAccount.create({
    data: { name: data.name, type: data.type, initialBalance: data.initialBalance ?? 0, userId },
  });
}

export class AccountNotFoundError extends Error {}
export class AccountInUseError extends Error {}

export async function updateAccount(
  userId: number,
  id: number,
  data: { name?: string; type?: string; initialBalance?: number }
) {
  const existing = await prisma.financeAccount.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new AccountNotFoundError("حساب یافت نشد.");
  }
  return prisma.financeAccount.update({ where: { id }, data });
}

export async function deleteAccount(userId: number, id: number) {
  const existing = await prisma.financeAccount.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new AccountNotFoundError("حساب یافت نشد.");
  }

  const usageCount = await prisma.transaction.count({ where: { accountId: id, userId } });
  if (usageCount > 0) {
    throw new AccountInUseError(`این حساب در ${usageCount} تراکنش استفاده شده و قابل حذف نیست.`);
  }

  return prisma.financeAccount.delete({ where: { id } });
}
