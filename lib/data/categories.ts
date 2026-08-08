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
  data: {
    name: string;
    icon: string;
    color: string;
    type: CategoryType;
    parentId?: number | null;
    // Essential vs discretionary classification (see
    // lib/analytics/spending-summary.ts). Defaults to true, same safe
    // default as the schema's own Category.isEssential column.
    isEssential?: boolean;
  }
) {
  return prisma.category.create({ data: { ...data, isEssential: data.isEssential ?? true, userId } });
}

// Ordered oldest-first so callers computing a rolling-window retry time
// (see MAX_CATEGORIES_PER_24H in app/api/categories/route.ts) can read the
// window's expiry straight off the first element.
export async function listCategoriesCreatedSince(userId: number, since: Date) {
  return prisma.category.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
}

export async function findCategoryByNameAndType(userId: number, name: string, type: CategoryType) {
  return prisma.category.findFirst({ where: { userId, name, type } });
}

export class CategoryInUseError extends Error {}
export class CategoryNotFoundError extends Error {}

export async function updateCategory(
  userId: number,
  id: number,
  data: { name?: string; icon?: string; color?: string; isEssential?: boolean }
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
