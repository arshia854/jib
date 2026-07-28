import { prisma } from "@/lib/prisma";
import { getDefaultAccount } from "@/lib/data/accounts";
import type { CategoryType } from "@/lib/categories";

export interface TransactionFilters {
  type?: CategoryType;
  categoryId?: number;
  from?: Date;
  to?: Date;
}

export async function listTransactions(filters: TransactionFilters = {}) {
  return prisma.transaction.findMany({
    where: {
      type: filters.type,
      categoryId: filters.categoryId,
      date: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
    },
    include: { category: true },
    orderBy: { date: "desc" },
  });
}

export async function deleteTransaction(id: number) {
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

export async function createTransaction(input: CreateTransactionInput) {
  const [account, category] = await Promise.all([
    getDefaultAccount(),
    prisma.category.findFirst({ where: { name: input.categoryName, type: input.type } }),
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
      accountId: account.id,
      categoryId: category.id,
    },
    include: { category: true },
  });
}
