import "server-only";
import { prisma } from "@/lib/prisma";
import { findSimilarCategory, resolveNewCategoryIcon, excludeArchived, type CategoryType } from "@/lib/categories";
import type { CategoryOption } from "@/lib/ai/parse-transaction";
import { isUniqueConstraintError } from "@/lib/observability/classify-error";

export async function listCategories(userId: number, type?: CategoryType) {
  return prisma.category.findMany({
    where: { userId, type },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

// Category rows -> the CategoryOption shape parseTransactionWithAI and
// findSimilarCategory take (parent resolved by name, isArchived carried
// through for excludeArchived). Shared by every caller that builds one -
// previously a hand-copied map in each of them, and a copy that forgot
// isArchived would silently let archived categories back into the AI
// prompt.
export function toCategoryOptions(
  categories: Array<{ id: number; name: string; type: string; parentId: number | null; isArchived: boolean }>
): CategoryOption[] {
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return categories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
    isArchived: c.isArchived,
  }));
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

// The ai-suggestion path (both POST /api/categories with source:
// "ai-suggestion" and POST /api/transactions/[id]/suggested-category's
// "accept" action) never receives a color from the client - all newly
// created categories here get this same slate-gray, the same generic/
// miscellaneous tone already used for the seeded "سایر" bucket and utility
// subcategories (prisma/seed.ts).
const AI_SUGGESTION_DEFAULT_COLOR = "#64748B";

// Rolling-24h cap on categories created via this path - bounds category
// sprawl from repeated acceptances. Does not apply to source: "manual"
// (the Settings > Categories screen, components/categories/categories-manager.tsx),
// which keeps its pre-existing, unrestricted contract.
const MAX_CATEGORIES_PER_24H = 10;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class InvalidParentCategoryError extends Error {}

export class CategoryCreationRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("در ۲۴ ساعت گذشته دسته‌بندی زیادی ساخته‌اید؛ لطفاً از دسته‌های موجود استفاده کنید.");
  }
}

export class DuplicateCategoryError extends Error {}

export interface ResolveOrCreateCategoryInput {
  name: string;
  parentName: string | null;
  type: CategoryType;
}

export interface ResolveOrCreateCategoryResult {
  category: Awaited<ReturnType<typeof createCategory>>;
  resolvedExisting: boolean;
}

// Shared resolution logic for turning an AI newCategorySuggestion
// (lib/ai/parse-transaction.ts's SuggestedCategoryWithIcon) into a real
// category: parentName resolution, mandatory dedup via findSimilarCategory,
// a forced server-side icon (never the AI's own, which doesn't even carry
// one - see SuggestedCategory's own comment), and the rolling 24h rate
// limit. Originally lived inline in POST /api/categories's source:
// "ai-suggestion" branch; pulled out here so POST
// /api/transactions/[id]/suggested-category's "accept" action can reuse
// the exact same resolution instead of a copy-pasted duplicate. Expected/
// domain outcomes are thrown as the typed errors above rather than
// returned as a response shape, so each caller maps them to its own HTTP
// status/body independently (the two routes don't share a response
// contract) - an unexpected error is left to propagate uncaught, same as
// every other function in this file, so each caller's own reportError call
// gets its own route-specific context.
export async function resolveOrCreateCategoryFromSuggestion(
  userId: number,
  input: ResolveOrCreateCategoryInput
): Promise<ResolveOrCreateCategoryResult> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const recentCategories = await listCategoriesCreatedSince(userId, since);
  if (recentCategories.length >= MAX_CATEGORIES_PER_24H) {
    const oldest = recentCategories[0].createdAt;
    const retryAfterSeconds = Math.max(
      Math.ceil((oldest.getTime() + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000),
      0
    );
    throw new CategoryCreationRateLimitedError(retryAfterSeconds);
  }

  let parentId: number | null = null;
  if (input.parentName !== null) {
    const parent = await findCategoryByNameAndType(userId, input.parentName, input.type);
    if (!parent) {
      throw new InvalidParentCategoryError("دسته‌بندی والد یافت نشد یا با نوع این دسته‌بندی مطابقت ندارد.");
    }
    parentId = parent.id;
  }

  const existingCategories = await listCategories(userId);
  // Archived categories are never a dedup target - resolving an accepted
  // suggestion onto one would land a new transaction on a retired category.
  // This path previously had no deprecated-name filter at all (only
  // parseTransactionWithAI did): e.g. an accepted "پس‌انداز" suggestion
  // token-overlaps "واریز به حساب پس‌انداز" at ratio 1.0.
  const categoryOptions = excludeArchived(toCategoryOptions(existingCategories));

  const similar = findSimilarCategory({ name: input.name, parentName: input.parentName }, categoryOptions, input.type);
  if (similar) {
    const matchedCategory = existingCategories.find((c) => c.name === similar.name && c.type === similar.type)!;
    return { category: matchedCategory, resolvedExisting: true };
  }

  const icon = resolveNewCategoryIcon(input.name);
  try {
    const category = await createCategory(userId, {
      name: input.name,
      icon,
      color: AI_SUGGESTION_DEFAULT_COLOR,
      type: input.type,
      parentId,
    });
    return { category, resolvedExisting: false };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new DuplicateCategoryError("دسته‌بندی با این نام و نوع قبلاً وجود دارد.");
    }
    throw error;
  }
}
