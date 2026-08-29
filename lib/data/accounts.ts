import "server-only";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";

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
export async function getTotalBalance(userId: number, client: PrismaClient = prisma): Promise<number> {
  const [accounts, balanceGroups] = await Promise.all([
    client.financeAccount.findMany({ where: { userId }, select: { id: true, initialBalance: true } }),
    client.transaction.groupBy({ by: ["accountId", "type"], where: { userId }, _sum: { amount: true } }),
  ]);

  const netByAccount = new Map<number, number>();
  for (const g of balanceGroups) {
    const delta = g.type === "income" ? (g._sum.amount ?? 0) : -(g._sum.amount ?? 0);
    netByAccount.set(g.accountId, (netByAccount.get(g.accountId) ?? 0) + delta);
  }

  return accounts.reduce((sum, a) => sum + a.initialBalance + (netByAccount.get(a.id) ?? 0), 0);
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
