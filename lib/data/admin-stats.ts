import { toJalaali, toGregorian } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/auth/session";
import { jalaaliMonthKeyToLabel } from "@/lib/format";

const TREND_MONTHS = 6;

export interface MonthlyVolumePoint {
  monthKey: string; // "YYYY-MM" (Jalaali)
  label: string;
  transactionCount: number;
  totalAmount: number;
}

/** Gregorian [start, end) bounds of the Jalaali month `monthsAgo` months before `date`. */
function jalaaliMonthRangeAgo(monthsAgo: number, date: Date): { start: Date; end: Date; monthKey: string } {
  const { jy, jm } = toJalaali(date);
  const totalMonths = jy * 12 + (jm - 1) - monthsAgo;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;

  const startG = toGregorian(y, m, 1);
  const endG = m === 12 ? toGregorian(y + 1, 1, 1) : toGregorian(y, m + 1, 1);

  return {
    start: new Date(startG.gy, startG.gm - 1, startG.gd),
    end: new Date(endG.gy, endG.gm - 1, endG.gd),
    monthKey: `${y}-${String(m).padStart(2, "0")}`,
  };
}

async function getTransactionVolumeTrend(): Promise<MonthlyVolumePoint[]> {
  const now = new Date();
  const ranges = Array.from({ length: TREND_MONTHS }, (_, i) => jalaaliMonthRangeAgo(TREND_MONTHS - 1 - i, now));

  const points = await Promise.all(
    ranges.map(async ({ start, end, monthKey }) => {
      const result = await prisma.transaction.aggregate({
        where: { date: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { amount: true },
      });
      return {
        monthKey,
        label: jalaaliMonthKeyToLabel(monthKey),
        transactionCount: result._count._all,
        totalAmount: result._sum.amount ?? 0,
      };
    })
  );

  return points;
}

export interface AdminOverviewStats {
  totalUsers: number;
  totalTransactions: number;
  newUsers7d: number;
  newUsers30d: number;
  monthlyTrend: MonthlyVolumePoint[];
}

export async function getAdminOverviewStats(): Promise<AdminOverviewStats> {
  await requireAdminSession();

  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [totalUsers, totalTransactions, newUsers7d, newUsers30d, monthlyTrend] = await Promise.all([
    prisma.user.count(),
    prisma.transaction.count(),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    getTransactionVolumeTrend(),
  ]);

  return { totalUsers, totalTransactions, newUsers7d, newUsers30d, monthlyTrend };
}
