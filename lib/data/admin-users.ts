import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdminSession, isValidRole, type UserRole } from "@/lib/auth/session";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

const DEFAULT_PAGE_SIZE = 20;

export interface AdminUserListItem {
  id: number;
  name: string | null;
  phoneNumber: string | null;
  email: string | null;
  role: UserRole;
  blockedAt: Date | null;
  createdAt: Date;
  transactionCount: number;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function listUsersForAdmin(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<PaginatedResult<AdminUserListItem>> {
  const session = await requireAdminSession();

  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * pageSize;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        blockedAt: true,
        createdAt: true,
      },
    }),
    prisma.user.count(),
  ]);

  const counts = await prisma.transaction.groupBy({
    by: ["userId"],
    where: { userId: { in: users.map((u) => u.id) } },
    _count: { userId: true },
  });
  const countMap = new Map(counts.map((c) => [c.userId, c._count.userId]));

  // Validated per-row instead of `u.role as UserRole` (Phase 15) - a row
  // that fails isValidRole() is a data-integrity issue (see
  // lib/auth/session.ts's isValidRole doc comment), logged here and left
  // out of `items` rather than displayed via a guessed "user"/"admin"
  // value. `total`/`totalPages` above are still the raw DB count, so this
  // can make `items.length` come up short of `pageSize` on the one page
  // (if any) containing a row like this - accepted, since this path is
  // defense-in-depth for data that should never exist post-migration (see
  // the CHECK constraint added alongside this change), not a normal case
  // worth building pagination-adjustment logic for.
  const items: AdminUserListItem[] = [];
  for (const u of users) {
    if (!isValidRole(u.role)) {
      reportError({
        errorType: ERROR_TYPES.AUTH_ERROR,
        route: "data/admin-users",
        userId: session.userId,
        message: `User.role held an invalid value: ${JSON.stringify(u.role)}`,
        error: new Error("Invalid User.role value read from database"),
        context: { operation: "listUsersForAdmin", model: "User", targetUserId: u.id },
      });
      continue;
    }
    items.push({ ...u, role: u.role, transactionCount: countMap.get(u.id) ?? 0 });
  }

  return {
    items,
    page: safePage,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface AdminUserDetail {
  id: number;
  name: string | null;
  phoneNumber: string | null;
  email: string | null;
  role: UserRole;
  blockedAt: Date | null;
  createdAt: Date;
  transactionCount: number;
  accountCount: number;
  categoryCount: number;
}

export class AdminUserNotFoundError extends Error {}

// Distinct from AdminUserNotFoundError on purpose: the row *was* found,
// it's just not safely renderable (see isValidRole's doc comment in
// lib/auth/session.ts) - conflating the two would tell the admin a real
// row doesn't exist, which is its own kind of misleading. Left uncaught by
// app/app/admin/users/[id]/page.tsx's existing catch block (it only
// special-cases AdminUserNotFoundError, and already re-throws anything
// else), so this surfaces as a real error rather than a silent 404.
export class InvalidUserRoleError extends Error {}

export async function getUserDetailForAdmin(targetUserId: number): Promise<AdminUserDetail> {
  const session = await requireAdminSession();

  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
      role: true,
      blockedAt: true,
      createdAt: true,
      _count: { select: { transactions: true, financeAccounts: true, categories: true } },
    },
  });
  if (!user) {
    throw new AdminUserNotFoundError("کاربر یافت نشد.");
  }

  if (!isValidRole(user.role)) {
    reportError({
      errorType: ERROR_TYPES.AUTH_ERROR,
      route: "data/admin-users",
      userId: session.userId,
      message: `User.role held an invalid value: ${JSON.stringify(user.role)}`,
      error: new Error("Invalid User.role value read from database"),
      context: { operation: "getUserDetailForAdmin", model: "User", targetUserId: user.id },
    });
    throw new InvalidUserRoleError("اطلاعات نقش این کاربر نامعتبر است.");
  }

  return {
    id: user.id,
    name: user.name,
    phoneNumber: user.phoneNumber,
    email: user.email,
    role: user.role,
    blockedAt: user.blockedAt,
    createdAt: user.createdAt,
    transactionCount: user._count.transactions,
    accountCount: user._count.financeAccounts,
    categoryCount: user._count.categories,
  };
}

// Thrown when an admin targets their own account with block/delete - there's
// no self-serve way to become admin again (see README.md), so this guards
// against an admin accidentally locking themselves out.
export class CannotModifySelfError extends Error {}

export async function setUserBlocked(targetUserId: number, blocked: boolean) {
  const session = await requireAdminSession();
  if (targetUserId === session.userId) {
    throw new CannotModifySelfError("شما نمی‌توانید حساب خودتان را مسدود کنید.");
  }

  const existing = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!existing) {
    throw new AdminUserNotFoundError("کاربر یافت نشد.");
  }

  return prisma.user.update({
    where: { id: targetUserId },
    data: { blockedAt: blocked ? new Date() : null },
  });
}

export async function deleteUserAsAdmin(targetUserId: number): Promise<void> {
  const session = await requireAdminSession();
  if (targetUserId === session.userId) {
    throw new CannotModifySelfError("شما نمی‌توانید حساب خودتان را حذف کنید.");
  }

  const existing = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!existing) {
    throw new AdminUserNotFoundError("کاربر یافت نشد.");
  }

  // FinanceAccount/Category/Transaction/MerchantMapping/ChatMessage/Account/
  // SpendingSummaryCache/UserFact all cascade from User in
  // prisma/schema.prisma - but a single prisma.user.delete() is NOT enough:
  // SQLite's own cascade processing does not guarantee an order that
  // satisfies every onDelete: Restrict constraint elsewhere in the same
  // cascade tree before those rows' parents are themselves cascade-deleted
  // via User. Confirmed with a real failing test first (see
  // admin-users.test.ts's "cascade delete" block) - even a plain onboarded
  // user (nothing but their two seeded parent+child categories, no
  // transactions at all) fails a bare prisma.user.delete() with a genuine
  // SQLite FOREIGN KEY constraint error, and the same failure reproduces
  // via a raw `DELETE FROM "User"` too, so this isn't a Prisma-specific
  // quirk. Three relations can trip a Restrict mid-cascade here:
  // Transaction -> FinanceAccount/Category, MerchantMapping -> Category,
  // and Category's own self-referential parent - all deleted explicitly
  // first, in dependency order, so nothing is left for the User cascade to
  // Restrict against. One transaction, so this is still all-or-nothing.
  await prisma.$transaction([
    prisma.transaction.deleteMany({ where: { userId: targetUserId } }),
    prisma.merchantMapping.deleteMany({ where: { userId: targetUserId } }),
    // Children before parents - the same order this codebase's own test
    // cleanup code already uses for Category.parent's identical Restrict
    // constraint (see lib/data/categories.test.ts's cleanupUser).
    prisma.category.deleteMany({ where: { userId: targetUserId, parentId: { not: null } } }),
    prisma.category.deleteMany({ where: { userId: targetUserId } }),
    prisma.user.delete({ where: { id: targetUserId } }),
  ]);
}
