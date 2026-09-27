import "server-only";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { summarizeMonth } from "@/lib/analytics/spending-summary";
import { GOAL_LOOKBACK_MONTHS } from "@/lib/goals/feasibility";

type PrismaClient = typeof prisma;

/**
 * Trailing-average per-month income/expense breakdown, feeding
 * lib/savings/formulas.ts's suggestSavingsAmount. Every field is `null`
 * under the exact same condition getActualMonthlyAverage
 * (lib/goals/feasibility.ts) returns null for - zero months in the lookback
 * window have any logged transaction at all - not a confirmed zero. See
 * that function's own doc comment for why "no history yet" and "a real
 * average of 0" must never be conflated.
 */
export interface MonthlyFinancialProfile {
  avgIncome: number | null;
  avgEssentialExpense: number | null;
  avgDiscretionaryExpense: number | null;
  avgNetCashFlow: number | null;
}

/**
 * Same trailing-window shape as getActualMonthlyAverage
 * (lib/goals/feasibility.ts) - walks `lookbackMonths` complete, closed
 * Jalali months backward from the current (excluded, still-open) month, one
 * query per month, via summarizeMonth for the exact same isTransfer-
 * exclusion and income/expense/discretionary rules that function and
 * lib/analytics/spending-summary.ts's own getSpendingSummary already use.
 * Deliberately does NOT import from lib/goals/feasibility.ts's own
 * functions (only its GOAL_LOOKBACK_MONTHS constant) - this feature stays
 * decoupled from Goal, mirroring that file's lookback-loop pattern instead
 * of depending on it.
 *
 * A month with zero logged transactions is excluded from every average
 * entirely (same rule as getActualMonthlyAverage), not counted as a real
 * zero - so a brand-new user (or one with a quiet lookback window) gets
 * `null` averages rather than an artificially deflated one. Averages are
 * computed independently per field, but since exclusion is decided at the
 * whole-month level (a month either has transactions or it doesn't), every
 * field ends up averaged over the exact same set of months.
 */
export async function getMonthlyFinancialProfile(
  userId: number,
  lookbackMonths: number = GOAL_LOOKBACK_MONTHS,
  client: PrismaClient = prisma
): Promise<MonthlyFinancialProfile> {
  const ranges: { start: Date; end: Date; label: string }[] = [];
  let cursor = getJalaaliMonthRange().start;
  for (let i = 0; i < lookbackMonths; i++) {
    const range = getJalaaliMonthRange(new Date(cursor.getTime() - 1));
    ranges.push(range);
    cursor = range.start;
  }

  const monthly = await Promise.all(
    ranges.map(async (range) => {
      const transactions = await client.transaction.findMany({
        where: { userId, date: { gte: range.start, lt: range.end }, category: { isTransfer: false } },
        include: { category: true },
      });
      // No logged activity at all this month - exclude it rather than
      // counting it as a real net/income/expense of 0 (see this function's
      // own doc comment above).
      if (transactions.length === 0) return null;

      const summary = summarizeMonth(transactions, range.label);
      const essentialExpense = summary.expense - summary.discretionaryExpense;
      return {
        income: summary.income,
        essentialExpense,
        discretionaryExpense: summary.discretionaryExpense,
        netCashFlow: summary.income - summary.expense,
      };
    })
  );

  const monthsWithData = monthly.filter((m): m is NonNullable<typeof m> => m !== null);
  if (monthsWithData.length === 0) {
    return { avgIncome: null, avgEssentialExpense: null, avgDiscretionaryExpense: null, avgNetCashFlow: null };
  }

  const average = (select: (m: (typeof monthsWithData)[number]) => number) =>
    monthsWithData.reduce((sum, m) => sum + select(m), 0) / monthsWithData.length;

  return {
    avgIncome: average((m) => m.income),
    avgEssentialExpense: average((m) => m.essentialExpense),
    avgDiscretionaryExpense: average((m) => m.discretionaryExpense),
    avgNetCashFlow: average((m) => m.netCashFlow),
  };
}
