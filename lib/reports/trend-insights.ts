import { prisma } from "@/lib/prisma";
import { jalaaliMonthKeyToFullLabel, jalaaliWeekKeyToLabel, jalaaliYearKeyToLabel } from "@/lib/format";
import {
  computeRecurringExpenses,
  computeUnusualTransactions,
  computeSavingsRate,
  RECURRING_EXPENSE_LOOKBACK_MONTHS,
  type RecurringExpense,
  type UnusualTransaction,
} from "@/lib/analytics/spending-summary";
import { periodToGregorianRange, getPreviousPeriod, type ReportGranularity } from "./period-range";

export type { RecurringExpense, UnusualTransaction };

/** One period's net cash flow, as returned by getPeriodTrend below - oldest first. */
export interface TrendPeriod {
  periodKey: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

/** Human-readable Persian label for a period key, per granularity - see lib/format.ts for each helper's exact format. */
function periodKeyToLabel(periodKey: string, granularity: ReportGranularity): string {
  switch (granularity) {
    case "week":
      return jalaaliWeekKeyToLabel(periodKey);
    case "month":
      return jalaaliMonthKeyToFullLabel(periodKey);
    case "year":
      return jalaaliYearKeyToLabel(periodKey);
  }
}

/**
 * How many periods (current + N-1 prior) to bucket when checking for
 * recurring expenses, per granularity - passed to computeRecurringExpenses
 * (lib/analytics/spending-summary.ts), whose own "present in >= 2 buckets"
 * threshold (RECURRING_EXPENSE_MIN_MONTHS, private to that file) is already
 * granularity-agnostic - it doesn't care what a "period" is, only how many
 * of them a description shows up in - so it's reused unchanged for every
 * granularity here. The lookback COUNT is the one thing that does need
 * per-granularity judgement:
 *
 * - month: RECURRING_EXPENSE_LOOKBACK_MONTHS (3), unchanged - this must stay
 *   identical to lib/analytics/spending-summary.ts's own month behavior, so
 *   the chat assistant and the Reports page agree on what "recurring" means
 *   for the same granularity.
 * - week: also 3 - the same reasoning that justifies 3 months justifies 3
 *   weeks. A weekly-cadence recurring expense (a weekly commute-card top-up,
 *   a weekly allowance transfer) lands in most weeks it's active, so
 *   "present in >= 2 of the last 3 weeks" is just as meaningful a recurrence
 *   signal as "...3 months" is for a monthly-cadence expense.
 * - year: deliberately 2, not 3 - a 3-year lookback would require 3 full
 *   years of transaction history from every user before this could ever
 *   fire once, a much higher bar than week/month impose (and unrealistic
 *   for most of this app's users). "Present in both of the last 2 years" is
 *   still a real signal for a genuinely recurring annual expense (an
 *   insurance renewal, a yearly subscription paid once a year) at a
 *   reachable bar - a definition that needs 3 separate years of history
 *   just to switch on is too coarse to be useful in practice.
 */
const RECURRING_EXPENSE_LOOKBACK_PERIODS: Record<ReportGranularity, number> = {
  week: RECURRING_EXPENSE_LOOKBACK_MONTHS,
  month: RECURRING_EXPENSE_LOOKBACK_MONTHS,
  year: 2,
};

/** `periodKeys` starting at `currentPeriod`, walking backward via getPreviousPeriod - most-recent-first. */
function periodKeysMostRecentFirst(currentPeriod: string, granularity: ReportGranularity, count: number): string[] {
  const keys: string[] = [currentPeriod];
  for (let i = 1; i < count; i++) {
    keys.push(getPreviousPeriod(keys[keys.length - 1], granularity));
  }
  return keys;
}

/**
 * Net income/expense for `currentPeriod` and the `periodsBack` periods
 * before it (so periodsBack + 1 periods total), oldest first. Same
 * computational idea as lib/analytics/spending-summary.ts's
 * computeCashFlowTrend (net = income - expense per period), but driven by
 * period-range.ts's generic Jalaali period arithmetic instead of that
 * function's hardwired-to-months SpendingSummaryCache lookups, so it works
 * for week/month/year alike.
 */
export async function getPeriodTrend(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity,
  periodsBack: number
): Promise<TrendPeriod[]> {
  const userIdNum = Number(userId);
  const periodKeys = periodKeysMostRecentFirst(currentPeriod, granularity, periodsBack + 1);

  const periods = await Promise.all(
    periodKeys.map(async (periodKey): Promise<TrendPeriod> => {
      const { start, end } = periodToGregorianRange(periodKey, granularity);
      const groups = await prisma.transaction.groupBy({
        by: ["type"],
        // Same isTransfer exclusion as sumExpensesByCategory
        // (lib/reports/monthly-comparison.ts) - a transfer between the
        // user's own accounts is neither real income nor a real expense.
        where: { userId: userIdNum, date: { gte: start, lt: end }, category: { isTransfer: false } },
        _sum: { amount: true },
      });

      const income = groups.find((g) => g.type === "income")?._sum.amount ?? 0;
      const expense = groups.find((g) => g.type === "expense")?._sum.amount ?? 0;

      return { periodKey, label: periodKeyToLabel(periodKey, granularity), income, expense, net: income - expense };
    })
  );

  return periods.reverse();
}

/**
 * Descriptions recurring as an expense across multiple recent periods (see
 * RECURRING_EXPENSE_LOOKBACK_PERIODS above for how many, per granularity).
 * Buckets each period's expense transactions and delegates the actual
 * "recurring" determination to computeRecurringExpenses
 * (lib/analytics/spending-summary.ts) - despite that function's "monthly"
 * naming, it only needs correctly-bucketed period arrays, not literal
 * months (see its own doc comment).
 */
export async function getRecurringExpenses(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity
): Promise<RecurringExpense[]> {
  const userIdNum = Number(userId);
  const lookback = RECURRING_EXPENSE_LOOKBACK_PERIODS[granularity];
  // Most-recent-first, matching computeRecurringExpenses' own documented
  // input order.
  const periodKeys = periodKeysMostRecentFirst(currentPeriod, granularity, lookback);

  const buckets = await Promise.all(
    periodKeys.map((periodKey) => {
      const { start, end } = periodToGregorianRange(periodKey, granularity);
      return prisma.transaction.findMany({
        where: { userId: userIdNum, type: "expense", date: { gte: start, lt: end }, category: { isTransfer: false } },
        select: { description: true, amount: true },
      });
    })
  );

  return computeRecurringExpenses(buckets);
}

/**
 * Current-period expense transactions flagged as unusual (>= 3x their
 * category's other-transactions-this-period average) - a thin fetch wrapper
 * around computeUnusualTransactions (lib/analytics/spending-summary.ts),
 * which is already granularity-agnostic: it only needs "this period"'s
 * expense transactions, whatever period that is.
 */
export async function getUnusualTransactions(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity
): Promise<UnusualTransaction[]> {
  const userIdNum = Number(userId);
  const { start, end } = periodToGregorianRange(currentPeriod, granularity);

  const transactions = await prisma.transaction.findMany({
    where: { userId: userIdNum, type: "expense", date: { gte: start, lt: end }, category: { isTransfer: false } },
    select: {
      id: true,
      date: true,
      amount: true,
      type: true,
      description: true,
      category: { select: { name: true, isEssential: true } },
    },
  });

  return computeUnusualTransactions(transactions);
}

/**
 * (income - expense) / income for one period, as a rounded percent - thin
 * wrapper over computeSavingsRate (lib/analytics/spending-summary.ts) so
 * callers of this module don't need to import from two files for one
 * period's worth of data. Undefined when income is 0 - see
 * computeSavingsRate's own doc comment.
 */
export function getPeriodSavingsRate(income: number, expense: number): number | undefined {
  return computeSavingsRate(income, expense);
}
