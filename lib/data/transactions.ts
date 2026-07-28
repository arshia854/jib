import { prisma } from "@/lib/prisma";
import { getDefaultAccount } from "@/lib/data/accounts";
import type { CategoryType } from "@/lib/categories";

export interface TransactionFilters {
  type?: CategoryType;
  categoryId?: number;
  from?: Date;
  to?: Date;
}

export async function listTransactions(userId: number, filters: TransactionFilters = {}) {
  return prisma.transaction.findMany({
    where: {
      userId,
      type: filters.type,
      categoryId: filters.categoryId,
      date: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
    },
    include: { category: true },
    orderBy: { date: "desc" },
  });
}

export async function deleteTransaction(userId: number, id: number) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new Error("تراکنش یافت نشد.");
  }
  return prisma.transaction.delete({ where: { id } });
}

export interface CreateTransactionInput {
  amount: number;
  type: CategoryType;
  categoryName: string;
  description?: string;
  rawInput: string;
  date: Date;
}

export class InvalidCategoryError extends Error {}

export async function createTransaction(userId: number, input: CreateTransactionInput) {
  const [account, category] = await Promise.all([
    getDefaultAccount(userId),
    prisma.category.findFirst({ where: { userId, name: input.categoryName, type: input.type } }),
  ]);

  if (!category) {
    throw new InvalidCategoryError("دسته‌بندی نامعتبر است.");
  }

  return prisma.transaction.create({
    data: {
      amount: input.amount,
      type: input.type,
      description: input.description,
      rawInput: input.rawInput,
      date: input.date,
      userId,
      accountId: account.id,
      categoryId: category.id,
    },
    include: { category: true },
  });
}
