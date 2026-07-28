import { prisma } from "@/lib/prisma";
import type { CategoryType } from "@/lib/categories";

export async function listCategories(userId: number, type?: CategoryType) {
  return prisma.category.findMany({
    where: { userId, type },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

export async function listCategoriesWithUsage(userId: number, type?: CategoryType) {
  const categories = await listCategories(userId, type);
  const counts = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { userId },
    _count: { categoryId: true },
  });
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count.categoryId]));
  return categories.map((category) => ({
    ...category,
    transactionCount: countMap.get(category.id) ?? 0,
  }));
}

export async function createCategory(
  userId: number,
  data: { name: string; icon: string; color: string; type: CategoryType }
) {
  return prisma.category.create({ data: { ...data, userId } });
}

export class CategoryInUseError extends Error {}
export class CategoryNotFoundError extends Error {}

export async function updateCategory(
  userId: number,
  id: number,
  data: { name?: string; icon?: string; color?: string }
) {
  const existing = await prisma.category.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new CategoryNotFoundError("دسته‌بندی یافت نشد.");
  }
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(userId: number, id: number) {
  const existing = await prisma.category.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new CategoryNotFoundError("دسته‌بندی یافت نشد.");
  }

  const usageCount = await prisma.transaction.count({ where: { categoryId: id, userId } });
  if (usageCount > 0) {
    throw new CategoryInUseError(`این دسته‌بندی در ${usageCount} تراکنش استفاده شده و قابل حذف نیست.`);
  }

  return prisma.category.delete({ where: { id } });
}
