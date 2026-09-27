import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/auth/session";
import type { CategoryType } from "@/lib/categories";

export interface DefaultCategoryWithChildren {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
  isTransfer: boolean;
  isEssential: boolean;
  parentId: number | null;
  children: {
    id: number;
    name: string;
    icon: string;
    color: string;
    type: string;
    isTransfer: boolean;
    isEssential: boolean;
    parentId: number | null;
  }[];
}

export async function listDefaultCategories(): Promise<DefaultCategoryWithChildren[]> {
  await requireAdminSession();
  return prisma.defaultCategory.findMany({
    where: { parentId: null },
    include: { children: { orderBy: { name: "asc" } } },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

export class DefaultCategoryNotFoundError extends Error {}
export class DefaultCategoryInUseError extends Error {}

export interface CreateDefaultCategoryInput {
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
  isTransfer?: boolean;
  parentId?: number | null;
  // Essential vs discretionary classification (see
  // lib/analytics/spending-summary.ts). Defaults to true, same safe default
  // as the schema's own DefaultCategory.isEssential column. Settable via
  // this data-layer function, but not yet exposed as a toggle in the admin
  // categories UI (app/app/admin/categories) - noted here so it isn't
  // silently forgotten.
  isEssential?: boolean;
}

// Errors here (P2002 unique-constraint on name+type) are left to bubble up
// and are mapped to a friendly message in the route handler, same as
// lib/data/categories.ts's createCategory/updateCategory.
export async function createDefaultCategory(data: CreateDefaultCategoryInput) {
  await requireAdminSession();
  return prisma.defaultCategory.create({
    data: {
      name: data.name,
      icon: data.icon,
      color: data.color,
      type: data.type,
      isTransfer: data.isTransfer ?? false,
      parentId: data.parentId ?? null,
      isEssential: data.isEssential ?? true,
    },
  });
}

export interface UpdateDefaultCategoryInput {
  name?: string;
  icon?: string;
  color?: string;
  // See CreateDefaultCategoryInput.isEssential - same "data-layer only, no
  // admin UI toggle yet" caveat applies here.
  isEssential?: boolean;
}

export async function updateDefaultCategory(id: number, data: UpdateDefaultCategoryInput) {
  await requireAdminSession();

  const existing = await prisma.defaultCategory.findUnique({ where: { id } });
  if (!existing) {
    throw new DefaultCategoryNotFoundError("دسته‌بندی پیش‌فرض یافت نشد.");
  }

  return prisma.defaultCategory.update({ where: { id }, data });
}

export async function deleteDefaultCategory(id: number): Promise<void> {
  await requireAdminSession();

  const existing = await prisma.defaultCategory.findUnique({ where: { id } });
  if (!existing) {
    throw new DefaultCategoryNotFoundError("دسته‌بندی پیش‌فرض یافت نشد.");
  }

  const childCount = await prisma.defaultCategory.count({ where: { parentId: id } });
  if (childCount > 0) {
    throw new DefaultCategoryInUseError(`این دسته‌بندی ${childCount} زیردسته دارد و ابتدا باید آن‌ها حذف شوند.`);
  }

  await prisma.defaultCategory.delete({ where: { id } });
}
