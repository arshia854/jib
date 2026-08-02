import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";

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
