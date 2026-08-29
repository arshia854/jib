import "server-only";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/auth/session";
import type { PaginatedResult } from "@/lib/data/admin-users";

const DEFAULT_PAGE_SIZE = 20;

export interface AdminErrorLogItem {
  id: number;
  timestamp: Date;
  route: string;
  message: string;
  stack: string | null;
  user: { id: number; name: string | null; phoneNumber: string | null } | null;
}

export async function listErrorLogsForAdmin(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<PaginatedResult<AdminErrorLogItem>> {
  await requireAdminSession();

  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * pageSize;

  const [logs, total] = await Promise.all([
    prisma.errorLog.findMany({
      orderBy: { timestamp: "desc" },
      skip,
      take: pageSize,
      include: { user: { select: { id: true, name: true, phoneNumber: true } } },
    }),
    prisma.errorLog.count(),
  ]);

  return {
    items: logs,
    page: safePage,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
