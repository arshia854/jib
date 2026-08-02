import { toGregorian } from "jalaali-js";
import { prisma } from "@/lib/prisma";

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

/** Gregorian [start, end) bounds of a Jalaali month given as "YYYY-MM". */
function jalaaliMonthToGregorianRange(month: string): { start: Date; end: Date } {
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

async function sumExpensesByCategory(userId: number, start: Date, end: Date): Promise<Map<number, number>> {
  const groups = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { userId, type: "expense", date: { gte: start, lt: end } },
    _sum: { amount: true },
  });

  return new Map(groups.map((g) => [g.categoryId, g._sum.amount ?? 0]));
}

export async function getMonthlyComparison(
  userId: string,
  currentMonth: string,
  previousMonth: string
): Promise<MonthlyComparisonResult> {
  const userIdNum = Number(userId);
  const currentRange = jalaaliMonthToGregorianRange(currentMonth);
  const previousRange = jalaaliMonthToGregorianRange(previousMonth);

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
    currentMonth,
    previousMonth,
    categories,
    totalPrevious,
    totalCurrent,
    totalPercentChange: computePercentChange(totalPrevious, totalCurrent),
  };
}
