import { prisma } from "@/lib/prisma";
import { sumExpensesByCategory } from "./monthly-comparison";

export interface TodayCategorySpending {
  category: string;
  amount: number;
}

export interface TodaySpendingResult {
  date: Date;
  categories: TodayCategorySpending[];
  total: number;
}

/** Local midnight for `date` (defaults to now) — a Jalaali day and a Gregorian calendar day share the same boundary, so no jalaali-js conversion is needed here. */
function startOfDay(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Today's spending broken down by category — a plain summary, not a comparison.
 * Unlike getComparison() (week/month/year), there is no previous-period counterpart
 * for a single day, so this intentionally returns a distinct, simpler shape: no
 * percentChange/isIncrease/previous-period fields.
 */
export async function getTodaySpending(userId: string): Promise<TodaySpendingResult> {
  const start = startOfDay();
  const end = addDays(start, 1);

  const byCategory = await sumExpensesByCategory(Number(userId), start, end);
  const categoryIds = [...byCategory.keys()];

  const categoryRecords = categoryIds.length
    ? await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(categoryRecords.map((c) => [c.id, c.name]));

  const categories: TodayCategorySpending[] = categoryIds
    .map((categoryId) => ({
      category: nameById.get(categoryId) ?? "نامشخص",
      amount: byCategory.get(categoryId) ?? 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const total = categories.reduce((sum, c) => sum + c.amount, 0);

  return { date: start, categories, total };
}
