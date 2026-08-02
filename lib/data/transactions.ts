import { prisma } from "@/lib/prisma";
import type { CategoryType } from "@/lib/categories";
import { normalizeText } from "@/lib/normalize";

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

export async function getTransaction(userId: number, id: number) {
  return prisma.transaction.findFirst({ where: { id, userId }, include: { category: true } });
}

export class TransactionNotFoundError extends Error {}

export async function deleteTransaction(userId: number, id: number) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  return prisma.transaction.delete({ where: { id } });
}

export interface CreateTransactionInput {
  amount: number;
  type: CategoryType;
  categoryName: string;
  accountId: number;
  description?: string;
  rawInput: string;
  date: Date;
}

export interface UpdateTransactionInput {
  amount: number;
  type: CategoryType;
  categoryName: string;
  accountId: number;
  description?: string;
  date: Date;
}

export class InvalidCategoryError extends Error {}
export class InvalidAccountError extends Error {}

export async function updateTransaction(userId: number, id: number, input: UpdateTransactionInput) {
  const [existing, category, account] = await Promise.all([
    prisma.transaction.findFirst({ where: { id, userId } }),
    prisma.category.findFirst({ where: { userId, name: input.categoryName, type: input.type } }),
    prisma.account.findFirst({ where: { id: input.accountId, userId } }),
  ]);

  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  if (!category) {
    throw new InvalidCategoryError("دسته‌بندی نامعتبر است.");
  }
  if (!account) {
    throw new InvalidAccountError("حساب نامعتبر است.");
  }

  const categoryChanged = existing.categoryId !== category.id;

  const [updated] = await prisma.$transaction([
    prisma.transaction.update({
      where: { id },
      data: {
        amount: input.amount,
        type: input.type,
        description: input.description,
        date: input.date,
        categoryId: category.id,
        accountId: account.id,
      },
      include: { category: true },
    }),
    ...(categoryChanged && existing.rawInput
      ? [
          prisma.merchantMapping.upsert({
            where: {
              userId_merchantKey: { userId, merchantKey: normalizeText(existing.rawInput) },
            },
            update: { categoryId: category.id },
            create: { userId, merchantKey: normalizeText(existing.rawInput), categoryId: category.id },
          }),
        ]
      : []),
  ]);

  return updated;
}

export async function createTransaction(userId: number, input: CreateTransactionInput) {
  const [account, category] = await Promise.all([
    prisma.account.findFirst({ where: { id: input.accountId, userId } }),
    prisma.category.findFirst({ where: { userId, name: input.categoryName, type: input.type } }),
  ]);

  if (!account) {
    throw new InvalidAccountError("حساب نامعتبر است.");
  }
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
