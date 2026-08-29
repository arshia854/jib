import { toGregorian } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { periodToGregorianRange, type ReportGranularity } from "./period-range";

export interface CategoryComparison {
  category: string;
  previousAmount: number;
  currentAmount: number;
  percentChange: number | null; // null when previousAmount is 0 and currentAmount is 0
  isIncrease: boolean;
}

export interface MonthlyComparisonResult {
  currentMonth: string;
  previousMonth: string;
  categories: CategoryComparison[];
  totalPrevious: number;
  totalCurrent: number;
  totalPercentChange: number | null;
}

const JALAALI_MONTH_FORMAT = /^(\d{4})-(\d{2})$/;

/**
 * Gregorian [start, end) bounds of a Jalaali month given as "YYYY-MM".
 *
 * Exported so lib/reports/period-range.ts can delegate its "month" branch
 * here instead of duplicating this logic — the only consumer outside this
 * file today is periodToGregorianRange().
 */
export function jalaaliMonthToGregorianRange(month: string): { start: Date; end: Date } {
  const match = JALAALI_MONTH_FORMAT.exec(month);
  if (!match) {
    throw new Error(`ماه نامعتبر است: "${month}". فرمت مورد انتظار "YYYY-MM" جلالی است.`);
  }

  const jy = Number(match[1]);
  const jm = Number(match[2]);
  if (jm < 1 || jm > 12) {
    throw new Error(`ماه نامعتبر است: "${month}". ماه باید بین ۰۱ تا ۱۲ باشد.`);
  }

  const startG = toGregorian(jy, jm, 1);
  const endG = jm === 12 ? toGregorian(jy + 1, 1, 1) : toGregorian(jy, jm + 1, 1);

  return {
    start: new Date(startG.gy, startG.gm - 1, startG.gd),
    end: new Date(endG.gy, endG.gm - 1, endG.gd),
  };
}

function computePercentChange(previousAmount: number, currentAmount: number): number | null {
  if (previousAmount === 0 && currentAmount === 0) return null;
  if (previousAmount === 0) return 100;
  if (currentAmount === 0) return -100;
  return Math.round(((currentAmount - previousAmount) / previousAmount) * 100);
}

/**
 * Expense totals per category over [start, end). Exported for reuse by
 * lib/reports/today-spending.ts.
 *
 * Excludes Category.isTransfer categories - a transfer between the user's
 * own accounts is not real spending, so it must not inflate these totals
 * (or, transitively, getComparison's totalCurrent/totalPrevious and
 * generateHighlights' savings/warning messages built on top of them).
 */
export async function sumExpensesByCategory(userId: number, start: Date, end: Date): Promise<Map<number, number>> {
  const groups = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { userId, type: "expense", date: { gte: start, lt: end }, category: { isTransfer: false } },
    _sum: { amount: true },
  });

  return new Map(groups.map((g) => [g.categoryId, g._sum.amount ?? 0]));
}

/**
 * Category-by-category spending comparison between two periods of the same
 * granularity (day/week/month/year — see lib/reports/period-range.ts for the
 * "YYYY-MM-DD" / "YYYY-Www" / "YYYY-MM" / "YYYY" key formats).
 *
 * The result's `currentMonth`/`previousMonth` fields keep their original
 * names for every granularity (not just "month") so the existing
 * MonthlyComparisonResult shape, and everything that already consumes it
 * (MonthlyComparisonReport, generateHighlights, getMonthlyComparison's own
 * test suite), needs no changes.
 */
export async function getComparison(
  userId: string,
  currentPeriod: string,
  previousPeriod: string,
  granularity: ReportGranularity
): Promise<MonthlyComparisonResult> {
  const userIdNum = Number(userId);
  const currentRange = periodToGregorianRange(currentPeriod, granularity);
  const previousRange = periodToGregorianRange(previousPeriod, granularity);

  const [currentByCategory, previousByCategory] = await Promise.all([
    sumExpensesByCategory(userIdNum, currentRange.start, currentRange.end),
    sumExpensesByCategory(userIdNum, previousRange.start, previousRange.end),
  ]);

  const categoryIds = new Set([...currentByCategory.keys(), ...previousByCategory.keys()]);

  const categoryRecords = categoryIds.size
    ? await prisma.category.findMany({
        where: { id: { in: [...categoryIds] } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(categoryRecords.map((c) => [c.id, c.name]));

  const categories: CategoryComparison[] = [];
  let totalPrevious = 0;
  let totalCurrent = 0;

  for (const categoryId of categoryIds) {
    const previousAmount = previousByCategory.get(categoryId) ?? 0;
    const currentAmount = currentByCategory.get(categoryId) ?? 0;
    totalPrevious += previousAmount;
    totalCurrent += currentAmount;

    if (previousAmount === 0 && currentAmount === 0) continue;

    categories.push({
      category: nameById.get(categoryId) ?? "نامشخص",
      previousAmount,
      currentAmount,
      percentChange: computePercentChange(previousAmount, currentAmount),
      isIncrease: currentAmount > previousAmount,
    });
  }

  categories.sort((a, b) => b.currentAmount - a.currentAmount);

  return {
    currentMonth: currentPeriod,
    previousMonth: previousPeriod,
    categories,
    totalPrevious,
    totalCurrent,
    totalPercentChange: computePercentChange(totalPrevious, totalCurrent),
  };
}

/** Thin "month" wrapper over getComparison() — kept so existing callers and tests need no changes. */
export async function getMonthlyComparison(
  userId: string,
  currentMonth: string,
  previousMonth: string
): Promise<MonthlyComparisonResult> {
  return getComparison(userId, currentMonth, previousMonth, "month");
}
