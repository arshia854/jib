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
import {
  periodToGregorianRange,
  getPreviousPeriod,
  type GregorianRange,
  type ReportGranularity,
} from "./period-range";

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
 * How many periods (current + N-1 prior) to bucket for the two lookback-
 * window analytics in lib/analytics/spending-summary.ts, per granularity -
 * computeRecurringExpenses ("present in >= 2 buckets") and
 * computeUnusualTransactions (a category's baseline average across all
 * buckets). Both of those thresholds (RECURRING_EXPENSE_MIN_MONTHS,
 * UNUSUAL_TRANSACTION_MIN_BASELINE_SAMPLES - both private to that file) are
 * already granularity-agnostic: neither cares what a "period" is, only how
 * many of them a description shows up in / how many transactions land in
 * the pool - so both are reused unchanged for every granularity here, and
 * both functions get the same buckets from getPeriodExpenseBuckets below.
 * The lookback COUNT is the one thing that does need per-granularity
 * judgement:
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

interface PeriodRange extends GregorianRange {
  periodKey: string;
}

/**
 * The `count` periods ending at `currentPeriod` with their own Gregorian
 * [start, end) bounds (most-recent-first, same order as
 * periodKeysMostRecentFirst), plus `span`: the single [start, end) range
 * covering all of them.
 *
 * `span` is what both fetches below query on, so each of them costs one
 * round trip instead of one per period - see bucketByPeriod for the JS-side
 * split that replaces the per-period WHERE clauses. Periods produced by
 * getPreviousPeriod are contiguous and strictly decreasing, so the span is
 * just the oldest period's start up to the newest period's end; no period
 * math is reimplemented here, only reused from period-range.ts.
 */
function periodRangesMostRecentFirst(
  currentPeriod: string,
  granularity: ReportGranularity,
  count: number
): { periods: PeriodRange[]; span: GregorianRange } {
  const periods = periodKeysMostRecentFirst(currentPeriod, granularity, count).map((periodKey) => ({
    periodKey,
    ...periodToGregorianRange(periodKey, granularity),
  }));

  return { periods, span: { start: periods[periods.length - 1].start, end: periods[0].end } };
}

/**
 * Splits rows fetched over a whole span (see periodRangesMostRecentFirst)
 * back into one array per period, in the same order as `periods`.
 *
 * Each row is placed by the same half-open [start, end) test the per-period
 * queries this replaces used as their WHERE clause, so a row dated exactly
 * on a boundary lands in the period that *starts* there, not the one that
 * ends there - identical bucketing, just done once in JS instead of once per
 * period in the database. A row matching no period is dropped rather than
 * forced into one; contiguous periods make that unreachable for rows inside
 * the span, but it keeps the rule explicit.
 */
function bucketByPeriod<T extends { date: Date }>(rows: T[], periods: GregorianRange[]): T[][] {
  const buckets: T[][] = periods.map(() => []);

  for (const row of rows) {
    const index = periods.findIndex((p) => row.date >= p.start && row.date < p.end);
    if (index !== -1) buckets[index].push(row);
  }

  return buckets;
}

/**
 * Net income/expense for `currentPeriod` and the `periodsBack` periods
 * before it (so periodsBack + 1 periods total), oldest first. Same
 * computational idea as lib/analytics/spending-summary.ts's
 * computeCashFlowTrend (net = income - expense per period), but driven by
 * period-range.ts's generic Jalaali period arithmetic instead of that
 * function's hardwired-to-months SpendingSummaryCache lookups, so it works
 * for week/month/year alike.
 *
 * One query for the whole window, summed per period in JS - not one
 * groupBy per period. A period-bucketed groupBy isn't expressible (the
 * database has no notion of a Jalaali period to group by, and `by: ["date"]`
 * would group per distinct timestamp, not per period), so this fetches the
 * window's rows and buckets them with the same period bounds the per-period
 * queries used. Motivation: @libsql/client doesn't give these round trips
 * real HTTP-level concurrency - the Promise.all this replaced queued them
 * rather than running them in parallel, so the cost was periodsBack + 1
 * serialized round trips for what is a single narrow scan.
 */
export async function getPeriodTrend(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity,
  periodsBack: number
): Promise<TrendPeriod[]> {
  const userIdNum = Number(userId);
  const { periods, span } = periodRangesMostRecentFirst(currentPeriod, granularity, periodsBack + 1);

  const transactions = await prisma.transaction.findMany({
    // Same isTransfer exclusion as sumExpensesByCategory
    // (lib/reports/monthly-comparison.ts) - a transfer between the
    // user's own accounts is neither real income nor a real expense.
    where: { userId: userIdNum, date: { gte: span.start, lt: span.end }, category: { isTransfer: false } },
    select: { date: true, type: true, amount: true },
  });

  const buckets = bucketByPeriod(transactions, periods);

  return periods
    .map(({ periodKey }, i): TrendPeriod => {
      // Only income/expense contribute, exactly as the two-row groupBy this
      // replaces did - any other `type` value is ignored rather than summed.
      let income = 0;
      let expense = 0;
      for (const t of buckets[i]) {
        if (t.type === "income") income += t.amount;
        else if (t.type === "expense") expense += t.amount;
      }

      return { periodKey, label: periodKeyToLabel(periodKey, granularity), income, expense, net: income - expense };
    })
    .reverse();
}

/**
 * One array of expense transactions per period in the lookback window (see
 * RECURRING_EXPENSE_LOOKBACK_PERIODS above for how many, per granularity),
 * most-recent-first - the input order both computeRecurringExpenses and
 * computeUnusualTransactions document for their multi-bucket parameter.
 * Shared by the two functions below so they can't drift onto different
 * windows, and so the selected fields (the union of what both need: the
 * description/amount recurring-expense grouping runs on, plus the
 * id/date/type/category an unusual-transaction result must carry) are
 * described in one place. isTransfer categories are excluded here, same as
 * every other aggregate in this module.
 *
 * One query for the whole lookback window, bucketed per period in JS - not
 * one findMany per period (see getPeriodTrend above for why serialized
 * round trips are what this module optimizes against). A caller that wants
 * both results should go through getExpensePatterns below so the window is
 * fetched once rather than once per consumer.
 */
async function getPeriodExpenseBuckets(userIdNum: number, currentPeriod: string, granularity: ReportGranularity) {
  const { periods, span } = periodRangesMostRecentFirst(
    currentPeriod,
    granularity,
    RECURRING_EXPENSE_LOOKBACK_PERIODS[granularity]
  );

  const transactions = await prisma.transaction.findMany({
    where: {
      userId: userIdNum,
      type: "expense",
      date: { gte: span.start, lt: span.end },
      category: { isTransfer: false },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      type: true,
      description: true,
      category: { select: { name: true, isEssential: true } },
    },
  });

  return bucketByPeriod(transactions, periods);
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
  const buckets = await getPeriodExpenseBuckets(Number(userId), currentPeriod, granularity);

  return computeRecurringExpenses(buckets);
}

/**
 * Current-period expense transactions flagged as unusual (>= 3x the
 * average of their category's other transactions across the same
 * multi-period lookback window recurring expenses use) - a thin fetch
 * wrapper around computeUnusualTransactions
 * (lib/analytics/spending-summary.ts), which is already
 * granularity-agnostic: it only needs correctly-bucketed period arrays,
 * most-recent-first, whatever a period is here.
 */
export async function getUnusualTransactions(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity
): Promise<UnusualTransaction[]> {
  const buckets = await getPeriodExpenseBuckets(Number(userId), currentPeriod, granularity);

  return computeUnusualTransactions(buckets);
}

/**
 * Both of the above from a single fetch of the lookback window - what a
 * caller that wants both (app/app/reports/page.tsx does) should use.
 *
 * getRecurringExpenses and getUnusualTransactions are each independent
 * fetch wrappers, so calling both meant fetching the exact same window
 * twice; since @libsql/client doesn't run this project's queries
 * concurrently, that duplicate was a whole extra serialized round trip for
 * rows already in hand. Both are kept as-is for callers that genuinely want
 * only one of the two - the buckets they pass on are the same ones this
 * returns results from, so the two paths can't disagree.
 */
export async function getExpensePatterns(
  userId: string,
  currentPeriod: string,
  granularity: ReportGranularity
): Promise<{ recurringExpenses: RecurringExpense[]; unusualTransactions: UnusualTransaction[] }> {
  const buckets = await getPeriodExpenseBuckets(Number(userId), currentPeriod, granularity);

  return {
    recurringExpenses: computeRecurringExpenses(buckets),
    unusualTransactions: computeUnusualTransactions(buckets),
  };
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
