import { prisma } from "@/lib/prisma";
import type { CategoryType } from "@/lib/categories";

export async function listCategories(type?: CategoryType) {
  return prisma.category.findMany({
    where: type ? { type } : undefined,
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

export async function listCategoriesWithUsage(type?: CategoryType) {
  const categories = await listCategories(type);
  const counts = await prisma.transaction.groupBy({
    by: ["categoryId"],
    _count: { categoryId: true },
  });
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count.categoryId]));
  return categories.map((category) => ({
    ...category,
    transactionCount: countMap.get(category.id) ?? 0,
  }));
}

export async function createCategory(data: { name: string; icon: string; color: string; type: CategoryType }) {
  return prisma.category.create({ data });
}

export async function updateCategory(id: number, data: { name?: string; icon?: string; color?: string }) {
  return prisma.category.update({ where: { id }, data });
}

export class CategoryInUseError extends Error {}
export class CategoryNotFoundError extends Error {}

export async function deleteCategory(id: number) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) {
    throw new CategoryNotFoundError("دسته‌بندی یافت نشد.");
  }

  const usageCount = await prisma.transaction.count({ where: { categoryId: id } });
  if (usageCount > 0) {
    throw new CategoryInUseError(`این دسته‌بندی در ${usageCount} تراکنش استفاده شده و قابل حذف نیست.`);
  }

  return prisma.category.delete({ where: { id } });
}
