import { prisma } from "@/lib/prisma";
import { requireAdminSession, type UserRole } from "@/lib/auth/session";

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
  await requireAdminSession();

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

  return {
    items: users.map((u) => ({ ...u, role: u.role as UserRole, transactionCount: countMap.get(u.id) ?? 0 })),
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

export async function getUserDetailForAdmin(targetUserId: number): Promise<AdminUserDetail> {
  await requireAdminSession();

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

  return {
    id: user.id,
    name: user.name,
    phoneNumber: user.phoneNumber,
    email: user.email,
    role: user.role as UserRole,
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

  // FinanceAccount/Category/Transaction/MerchantMapping/ChatMessage/Account
  // all cascade from User in prisma/schema.prisma - a single delete here is
  // enough.
  await prisma.user.delete({ where: { id: targetUserId } });
}
