import { toJalaali } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getTotalBalance } from "@/lib/data/accounts";

type PrismaClient = typeof prisma;

export interface CategoryTotal {
  name: string;
  total: number;
}

export interface MonthSummary {
  label: string;
  income: number;
  expense: number;
  // Expense-only, sorted descending by total.
  categories: CategoryTotal[];
  // Subset of `expense` where the transaction's category has
  // isEssential === false (see prisma/schema.prisma's Category.isEssential).
  discretionaryExpense: number;
}

export interface CategoryTrend {
  category: string;
  previousAmount: number;
  currentAmount: number;
  percentChange: number;
}

export interface MerchantSummary {
  description: string;
  count: number;
  total: number;
}

export interface RecentTransactionSummary {
  id: number;
  date: Date;
  category: string;
  amount: number;
  type: string;
  description: string | null;
}

// Phase 10 - overall (not per-category) month-over-month change, for
// income and expense separately. Omitted (undefined), not returned as a
// misleading +/-100%/Infinity, when there's no previous-month baseline to
// compare against - same "omit rather than mislead" rule computeCategoryTrends
// already follows for a category with no prior-month activity.
export interface OverallTrend {
  previousAmount: number;
  currentAmount: number;
  percentChange: number;
}

// Phase 10 - a single current-month transaction whose amount is a defined
// multiple (UNUSUAL_TRANSACTION_MULTIPLIER) of the average of that
// category's *other* transactions this month. Deterministic and
// zero-extra-query (computed from currentMonth's already-fetched
// transactions) - see computeUnusualTransactions's own doc comment for why
// the comparison window is deliberately just the current month.
export interface UnusualTransaction {
  id: number;
  date: Date;
  category: string;
  description: string | null;
  amount: number;
  // Average of the category's other transactions this month (the baseline
  // `amount` was compared against), rounded.
  categoryAverage: number;
  // amount / categoryAverage, rounded to one decimal.
  multiple: number;
}

// Phase 10 - a normalized description that showed up as an expense in at
// least RECURRING_EXPENSE_MIN_MONTHS of the last RECURRING_EXPENSE_LOOKBACK_MONTHS
// months (current month + the 2 before it). See computeRecurringExpenses's
// own doc comment for exactly why this definition (not "more than once in
// one month", which topMerchants already covers).
export interface RecurringExpense {
  description: string;
  // How many of monthsChecked this description actually appeared in.
  monthsPresent: number;
  // How many months were actually available to check - normally
  // RECURRING_EXPENSE_LOOKBACK_MONTHS, but can be fewer for a new user
  // without that much transaction history yet.
  monthsChecked: number;
  // Average amount across the months it appeared in (not across all
  // occurrences - a month with two purchases of the same thing still
  // counts as one "present" month, averaged at the month level).
  averageAmount: number;
}

// Phase 10 - one month's net cash flow, as returned by computeCashFlowTrend
// below - oldest first.
export interface CashFlowMonth {
  monthKey: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

export interface SpendingSummary {
  totalBalance: number;
  currentMonth: MonthSummary;
  previousMonth: MonthSummary;
  // Percent change per category, only for categories present (with expense
  // activity) in both months - sorted by magnitude of change, descending.
  categoryTrends: CategoryTrend[];
  // Top 5 recurring merchants/descriptions this month, sorted by total desc.
  topMerchants: MerchantSummary[];
  // Current month's discretionary (isEssential === false) expense
  // categories, sorted descending by total, capped at
  // TOP_DISCRETIONARY_CATEGORIES_TAKE entries - same shape/sorting as
  // currentMonth.categories, just filtered to the discretionary subset.
  topDiscretionaryCategories: CategoryTotal[];
  // Last 10 transactions, minimal fields only.
  recentTransactions: RecentTransactionSummary[];
  // Phase 10 additions below - all additive, SpendingSummary's existing
  // consumers (lib/data/chat-context.ts) are unaffected by their presence.
  incomeChange?: OverallTrend;
  expenseChange?: OverallTrend;
  // (income - expense) / income for currentMonth, as a rounded percent
  // (e.g. 23 for 23%) - matching categoryTrends/OverallTrend's own
  // percentChange convention. Omitted when currentMonth.income is 0 (no
  // income this month - dividing by it would be Infinity/NaN, and "0%
  // savings rate" would misleadingly imply there was income to save from).
  savingsRate?: number;
  unusualTransactions: UnusualTransaction[];
  recurringExpenses: RecurringExpense[];
  // Net income/expense for each of the last CASH_FLOW_TREND_MONTHS months,
  // oldest first.
  cashFlowTrend: CashFlowMonth[];
}

const RECENT_TRANSACTIONS_TAKE = 10;
const TOP_MERCHANTS_TAKE = 5;
const TOP_DISCRETIONARY_CATEGORIES_TAKE = 5;

// A current-month transaction at least this many times its category's
// average (of that category's *other* transactions this month) is flagged
// as unusual. 3x is a common, easily-explainable rule-of-thumb multiple for
// this kind of outlier flagging (not derived from this app's own data - no
// calibration data exists, same caveat Phase 8's confidence model
// documents for its own thresholds) - kept as a named constant rather than
// inline so the "why 3, not some other number" question has one answer to
// update, not several scattered ones.
const UNUSUAL_TRANSACTION_MULTIPLIER = 3;

// "Recurring" = present in at least this many of the last
// RECURRING_EXPENSE_LOOKBACK_MONTHS months (current + the 2 before it).
// >=2 of 3 is stricter than topMerchants (which only needs >1 occurrence
// within a *single* month) and specifically targets things that repeat
// across separate billing cycles (subscriptions, rent, a recurring bill) -
// not just a merchant visited twice in one busy week, which topMerchants
// already surfaces on its own.
// Exported so lib/reports/trend-insights.ts's month-granularity recurring-
// expense lookback stays in lockstep with this one (both must mean the same
// "3 months" for computeRecurringExpenses' behavior to actually match
// between the chat assistant and the Reports page) rather than duplicating
// the literal 3 and risking the two silently drifting apart later.
// RECURRING_EXPENSE_MIN_MONTHS stays private - computeRecurringExpenses
// applies it internally regardless of what a "period" is (see its own doc
// comment), so no caller outside this file needs to read or override it.
export const RECURRING_EXPENSE_LOOKBACK_MONTHS = 3;
const RECURRING_EXPENSE_MIN_MONTHS = 2;

// Current month + 3 prior - long enough to show a real multi-month trend
// (not just current-vs-previous, which categoryTrends/OverallTrend already
// cover) without multiplying this function's DB round-trips further than
// justified, since getSpendingSummary runs on every chat message.
const CASH_FLOW_TREND_MONTHS = 4;

type MonthTransaction = {
  amount: number;
  type: string;
  description: string | null;
  category: { name: string; isEssential: boolean };
};

// The subset of a Transaction row computeUnusualTransactions needs -
// MonthTransaction above plus id/date, which summarizeMonth/topMerchants
// never needed but an unusual-transaction result must reference to be
// actionable (which transaction, and when).
type UnusualTransactionCandidate = MonthTransaction & { id: number; date: Date };

// The subset of a Transaction row computeRecurringExpenses/groupByDescription
// need - just enough to group and total by description.
type DescriptionTransaction = { description: string | null; amount: number };

function monthKeyFor(date: Date): string {
  const { jy, jm } = toJalaali(date);
  return `${jy}-${String(jm).padStart(2, "0")}`;
}

// Exported (Phase 1 Goals) so lib/goals/feasibility.ts's getActualMonthlyAverage
// can reuse the exact same isTransfer-exclusion + income/expense aggregation
// rules instead of duplicating them - visibility change only, behavior and
// every existing caller/export here are unchanged.
export function summarizeMonth(transactions: MonthTransaction[], label: string): MonthSummary {
  let income = 0;
  let expense = 0;
  let discretionaryExpense = 0;
  const categoryTotals = new Map<string, number>();

  for (const t of transactions) {
    if (t.type === "income") {
      income += t.amount;
    } else if (t.type === "expense") {
      expense += t.amount;
      categoryTotals.set(t.category.name, (categoryTotals.get(t.category.name) ?? 0) + t.amount);
      if (!t.category.isEssential) {
        discretionaryExpense += t.amount;
      }
    }
  }

  const categories = [...categoryTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  return { label, income, expense, categories, discretionaryExpense };
}

/** Percent change per category, only where the category has expense activity in both months - a new/dropped category has no meaningful "vs previous" figure, so it's omitted rather than shown as a misleading +/-100%/infinite delta. */
function computeCategoryTrends(current: MonthSummary, previous: MonthSummary): CategoryTrend[] {
  const previousByName = new Map(previous.categories.map((c) => [c.name, c.total]));
  const trends: CategoryTrend[] = [];

  for (const c of current.categories) {
    const previousAmount = previousByName.get(c.name);
    if (previousAmount === undefined) continue;
    const percentChange = Math.round(((c.total - previousAmount) / previousAmount) * 100);
    trends.push({ category: c.name, previousAmount, currentAmount: c.total, percentChange });
  }

  return trends.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
}

/**
 * Groups an already expense-only transaction list by normalized (trimmed,
 * case-insensitive) description - shared by computeTopMerchants (single
 * month) and computeRecurringExpenses (multiple months), so the grouping/
 * normalization rule lives in exactly one place.
 */
function groupByDescription(transactions: DescriptionTransaction[]): Map<string, MerchantSummary> {
  const groups = new Map<string, MerchantSummary>();

  for (const t of transactions) {
    const trimmed = t.description?.trim();
    if (!trimmed) continue;

    const key = trimmed.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.total += t.amount;
    } else {
      groups.set(key, { description: trimmed, count: 1, total: t.amount });
    }
  }

  return groups;
}

/** Top merchants/descriptions this month by total expense amount, grouped case-insensitively with surrounding whitespace trimmed. */
function computeTopMerchants(transactions: MonthTransaction[]): MerchantSummary[] {
  const expenseOnly = transactions.filter((t) => t.type === "expense");
  return [...groupByDescription(expenseOnly).values()].sort((a, b) => b.total - a.total).slice(0, TOP_MERCHANTS_TAKE);
}

/** Percent change vs. a previous-month baseline, omitted (not Infinity/NaN/misleading) when there's no baseline to compare against. */
export function computeOverallChange(currentAmount: number, previousAmount: number): OverallTrend | undefined {
  if (previousAmount === 0) return undefined;
  const percentChange = Math.round(((currentAmount - previousAmount) / previousAmount) * 100);
  return { previousAmount, currentAmount, percentChange };
}

/** (income - expense) / income as a rounded percent, omitted when there's no income to divide by. */
export function computeSavingsRate(income: number, expense: number): number | undefined {
  if (income <= 0) return undefined;
  return Math.round(((income - expense) / income) * 100);
}

/**
 * Flags a current-month expense transaction whose amount is at least
 * UNUSUAL_TRANSACTION_MULTIPLIER times the average of that *same category's
 * other* transactions this month. Deliberately scoped to the current month
 * only (not a longer historical average) - it's a zero-extra-query pure
 * function over data getSpendingSummary already fetches for currentMonth,
 * matching this phase's "pure function over already-fetched data"
 * constraint, at the acknowledged cost of only catching within-month
 * outliers, not "unusual vs. your normal months" (see the roadmap entry's
 * Remaining Risks for the tradeoff this makes explicit).
 *
 * A category needs at least one *other* transaction this month to compute
 * a baseline against - a category with only one transaction has nothing to
 * be "unusual" relative to yet, so it's skipped rather than compared
 * against itself.
 */
export function computeUnusualTransactions(transactions: UnusualTransactionCandidate[]): UnusualTransaction[] {
  const byCategory = new Map<string, UnusualTransactionCandidate[]>();
  for (const t of transactions) {
    if (t.type !== "expense") continue;
    const list = byCategory.get(t.category.name);
    if (list) list.push(t);
    else byCategory.set(t.category.name, [t]);
  }

  const results: UnusualTransaction[] = [];
  for (const [categoryName, categoryTransactions] of byCategory) {
    if (categoryTransactions.length < 2) continue;

    for (const t of categoryTransactions) {
      const others = categoryTransactions.filter((o) => o !== t);
      const othersAverage = others.reduce((sum, o) => sum + o.amount, 0) / others.length;
      if (othersAverage <= 0) continue;

      const multiple = t.amount / othersAverage;
      if (multiple >= UNUSUAL_TRANSACTION_MULTIPLIER) {
        results.push({
          id: t.id,
          date: t.date,
          category: categoryName,
          description: t.description,
          amount: t.amount,
          categoryAverage: Math.round(othersAverage),
          multiple: Math.round(multiple * 10) / 10,
        });
      }
    }
  }

  return results.sort((a, b) => b.multiple - a.multiple);
}

/**
 * "Recurring" = a normalized description present as an expense in at least
 * RECURRING_EXPENSE_MIN_MONTHS of `monthlyExpenseTransactions` (most
 * recent first: current month, then each prior month up to
 * RECURRING_EXPENSE_LOOKBACK_MONTHS). Stricter than topMerchants (which
 * only requires >1 occurrence within a single month) - this specifically
 * targets things that repeat across separate months (subscriptions, rent,
 * a recurring bill), not a merchant visited twice in one busy week.
 *
 * A user with less than RECURRING_EXPENSE_LOOKBACK_MONTHS of history simply
 * can't have anything present in >=2 months yet - monthsChecked on each
 * result reflects how many months were actually available, so a caller can
 * tell "no recurring expenses found" apart from "not enough history to
 * tell yet" if it ever needs to.
 */
export function computeRecurringExpenses(monthlyExpenseTransactions: DescriptionTransaction[][]): RecurringExpense[] {
  const perMonthGroups = monthlyExpenseTransactions.map(groupByDescription);
  const monthsChecked = monthlyExpenseTransactions.length;

  const allKeys = new Set<string>();
  for (const group of perMonthGroups) {
    for (const key of group.keys()) allKeys.add(key);
  }

  const results: RecurringExpense[] = [];
  for (const key of allKeys) {
    const presentIn = perMonthGroups.filter((g) => g.has(key));
    if (presentIn.length < RECURRING_EXPENSE_MIN_MONTHS) continue;

    const description = presentIn[0].get(key)!.description;
    const totalAcrossMonths = presentIn.reduce((sum, g) => sum + g.get(key)!.total, 0);
    results.push({
      description,
      monthsPresent: presentIn.length,
      monthsChecked,
      averageAmount: Math.round(totalAcrossMonths / presentIn.length),
    });
  }

  return results.sort((a, b) => b.monthsPresent - a.monthsPresent || b.averageAmount - a.averageAmount);
}

/** This month's discretionary (isEssential === false) expense categories, sorted descending by total and capped - the top-level SpendingSummary.topDiscretionaryCategories sibling of summarizeMonth's own (unfiltered) `categories` list. */
function computeTopDiscretionaryCategories(transactions: MonthTransaction[]): CategoryTotal[] {
  const categoryTotals = new Map<string, number>();

  for (const t of transactions) {
    if (t.type !== "expense" || t.category.isEssential) continue;
    categoryTotals.set(t.category.name, (categoryTotals.get(t.category.name) ?? 0) + t.amount);
  }

  return [...categoryTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_DISCRETIONARY_CATEGORIES_TAKE);
}

/**
 * Reads a cached previous-month summary, if one exists and parses cleanly.
 * A corrupt/unparseable payload is treated as a cache miss rather than an
 * error - the caller just recomputes it.
 *
 * discretionaryExpense was added to MonthSummary after this cache already
 * had rows in production, so an old cached payload parses fine but is
 * missing that field. Rather than patching it in with a `?? 0` (which would
 * require every future MonthSummary field addition to remember the same
 * patch, and silently mask any similar future omission), a payload missing
 * discretionaryExpense is treated as a cache miss - same fallback-to-
 * recompute path as a parse failure - so it's transparently recomputed and
 * re-cached in the new shape on next read. Simpler to reason about than
 * partial-object patching, at the one-time cost of a single extra
 * recompute per stale cached row.
 */
async function getCachedMonth(
  client: PrismaClient,
  userId: number,
  monthKey: string
): Promise<MonthSummary | null> {
  const cached = await client.spendingSummaryCache.findUnique({
    where: { userId_monthKey: { userId, monthKey } },
  });
  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached.payload) as Partial<MonthSummary>;
    if (typeof parsed.discretionaryExpense !== "number") return null;
    return parsed as MonthSummary;
  } catch {
    return null;
  }
}

/**
 * Deletes the cached summary (if any) for the Jalali month `date` falls in.
 *
 * getCachedMonth/computeAndCacheMonth above are built on the
 * assumption that a closed month's data is immutable - true in the common
 * case, but the app does not actually forbid editing or deleting a
 * transaction dated in a past month (see lib/data/transactions.ts's
 * updateTransaction/deleteTransaction, which only ever scope by
 * `{ id, userId }`, never by date). Without this, such an edit would leave
 * that month's cached income/expense/category totals silently wrong for as
 * long as the cache row exists - which, since it's never expired, is
 * effectively forever. Must be called by every transaction mutation whose
 * date (old or new) could fall outside the current, never-cached month.
 *
 * Best-effort, same as the cache write in computeAndCacheMonth: a
 * failed invalidation must not fail the mutation that triggered it. Worst
 * case, one more stale cached read happens before the row naturally falls
 * out of use.
 */
export async function invalidateSpendingSummaryCache(
  userId: number,
  date: Date,
  client: PrismaClient = prisma
): Promise<void> {
  const monthKey = monthKeyFor(date);
  await client.spendingSummaryCache.deleteMany({ where: { userId, monthKey } }).catch(() => {});
}

// Originally computeAndCachePreviousMonth (previous month only) - Phase 10
// generalized it to any past month, since computeCashFlowTrend below needs
// the same cache-or-compute behavior for several months back, not just the
// one immediately prior. Behavior for the previous-month case (still
// getSpendingSummary's own primary use) is unchanged.
async function computeAndCacheMonth(
  client: PrismaClient,
  userId: number,
  monthKey: string,
  start: Date,
  end: Date,
  label: string
): Promise<MonthSummary> {
  const transactions = await client.transaction.findMany({
    // isTransfer categories are excluded here (not just filtered out later)
    // so every aggregate derived from this list - income/expense totals,
    // per-category totals, discretionaryExpense - is correct by
    // construction. See the identical filter + rationale on the
    // current-month query in getSpendingSummary below.
    where: { userId, date: { gte: start, lt: end }, category: { isTransfer: false } },
    include: { category: true },
  });
  const summary = summarizeMonth(transactions, label);

  // A closed past month's data is immutable in practice - users don't edit
  // month-old transactions often - so caching it here saves a full
  // aggregation query on nearly every chat message for active users. The
  // current, still-open month is never cached (see getSpendingSummary
  // below) since it changes with every new transaction. A cache-write
  // failure shouldn't break the summary itself, so it's best-effort.
  await client.spendingSummaryCache
    .upsert({
      where: { userId_monthKey: { userId, monthKey } },
      create: { userId, monthKey, payload: JSON.stringify(summary), computedAt: new Date() },
      update: { payload: JSON.stringify(summary), computedAt: new Date() },
    })
    .catch(() => {});

  return summary;
}

async function getOrComputeMonth(
  client: PrismaClient,
  userId: number,
  monthKey: string,
  start: Date,
  end: Date,
  label: string
): Promise<MonthSummary> {
  const cached = await getCachedMonth(client, userId, monthKey);
  return cached ?? computeAndCacheMonth(client, userId, monthKey, start, end, label);
}

function toCashFlowMonth(monthKey: string, summary: MonthSummary): CashFlowMonth {
  return { monthKey, label: summary.label, income: summary.income, expense: summary.expense, net: summary.income - summary.expense };
}

/**
 * Net income/expense for each of the last CASH_FLOW_TREND_MONTHS months
 * (current + the ones before it), oldest first. Takes the already-resolved
 * current/previous MonthSummary (getSpendingSummary computes both anyway)
 * rather than re-deriving them, and only fetches the *older-than-previous*
 * months itself - via getOrComputeMonth's cache-or-compute path, not a
 * parallel uncached query - so a second/third call for the same user in
 * the same month only pays for the current month's own aggregation, not the
 * whole trend every time.
 */
async function computeCashFlowTrend(
  client: PrismaClient,
  userId: number,
  currentMonthKey: string,
  currentMonth: MonthSummary,
  previousMonthKey: string,
  previousMonth: MonthSummary,
  previousRangeStart: Date
): Promise<CashFlowMonth[]> {
  const olderRanges: { monthKey: string; start: Date; end: Date; label: string }[] = [];
  let cursor = previousRangeStart;
  // Starts at 2: index 0 (current) and index 1 (previous) are already
  // resolved by the caller - this only needs to reach further back.
  for (let i = 2; i < CASH_FLOW_TREND_MONTHS; i++) {
    const range = getJalaaliMonthRange(new Date(cursor.getTime() - 1));
    olderRanges.push({ monthKey: monthKeyFor(range.start), ...range });
    cursor = range.start;
  }

  const olderMonths = await Promise.all(
    olderRanges.map((r) => getOrComputeMonth(client, userId, r.monthKey, r.start, r.end, r.label))
  );

  const newestFirst: CashFlowMonth[] = [
    toCashFlowMonth(currentMonthKey, currentMonth),
    toCashFlowMonth(previousMonthKey, previousMonth),
    ...olderRanges.map((r, i) => toCashFlowMonth(r.monthKey, olderMonths[i])),
  ];

  return newestFirst.reverse();
}

/**
 * Structured, pre-computed financial summary for a user - no LLM calls, no
 * fetch, just Prisma reads (plus a cache write for the previous month). See
 * lib/data/chat-context.ts for the Persian text formatting built on top of
 * this for the chat prompt.
 */
export async function getSpendingSummary(userId: number, client: PrismaClient = prisma): Promise<SpendingSummary> {
  const currentRange = getJalaaliMonthRange();
  // A date guaranteed to fall inside the previous Jalali month.
  const previousRange = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));
  const previousMonthKey = monthKeyFor(previousRange.start);
  const currentMonthKey = monthKeyFor(currentRange.start);
  // A date guaranteed to fall inside the Jalali month before that -
  // RECURRING_EXPENSE_LOOKBACK_MONTHS (3) = current + previous + this one.
  const monthTwoBackRange = getJalaaliMonthRange(new Date(previousRange.start.getTime() - 1));

  const [currentTransactions, cachedPreviousMonth, totalBalance, recentTransactions, lookbackExpenseTransactions] =
    await Promise.all([
      client.transaction.findMany({
        // A transfer between the user's own accounts (Category.isTransfer)
        // moves money internally - it is not real income or a real expense,
        // so it must never inflate currentMonth.income/expense,
        // categories/discretionaryExpense (summarizeMonth), or
        // topMerchants/topDiscretionaryCategories/unusualTransactions
        // below, all of which are derived from this same list. Excluded at
        // the query level (not by filtering in each of those functions
        // separately) so this stays correct even if a new consumer of
        // `currentTransactions` is added later. totalBalance below
        // intentionally does NOT apply this filter - a transfer still
        // moves real money between real account balances, so it must
        // still count there.
        where: { userId, date: { gte: currentRange.start, lt: currentRange.end }, category: { isTransfer: false } },
        include: { category: true },
      }),
      getCachedMonth(client, userId, previousMonthKey),
      // Phase 17 (docs/roadmap-status.md): used to be
      // client.financeAccount.findMany({ include: { transactions: {...} } })
      // here - loading every transaction row ever created for the user's
      // accounts, just to sum them in JS, on every chat message (this
      // function's only caller today, lib/data/chat-context.ts, runs on
      // every chat turn). Shared with lib/data/dashboard.ts's identical
      // previous bug - see getTotalBalance's own doc comment
      // (lib/data/accounts.ts) for the bounded-aggregate replacement and
      // the measured before/after.
      getTotalBalance(userId, client),
      client.transaction.findMany({
        where: { userId },
        orderBy: { date: "desc" },
        take: RECENT_TRANSACTIONS_TAKE,
        include: { category: true },
      }),
      // Phase 10 (recurringExpenses) - the SpendingSummaryCache payload only
      // stores pre-aggregated category totals, not per-transaction
      // descriptions, so a normalized-description-level view of the prior
      // 2 months needs its own raw fetch; spans both months in one query
      // (split by date below) rather than two separate round-trips.
      client.transaction.findMany({
        where: {
          userId,
          type: "expense",
          date: { gte: monthTwoBackRange.start, lt: previousRange.end },
          category: { isTransfer: false },
        },
        select: { date: true, amount: true, description: true },
      }),
    ]);

  const currentMonth = summarizeMonth(currentTransactions, currentRange.label);
  const previousMonth =
    cachedPreviousMonth ??
    (await computeAndCacheMonth(
      client,
      userId,
      previousMonthKey,
      previousRange.start,
      previousRange.end,
      previousRange.label
    ));

  // lookbackExpenseTransactions spans [monthTwoBackRange.start,
  // previousRange.end) as one combined query (see above) - split back into
  // its two constituent months here, since Jalali months are contiguous
  // (monthTwoBackRange.end === previousRange.start), so a single boundary
  // check on previousRange.start is enough to split them correctly.
  const previousMonthExpenses = lookbackExpenseTransactions.filter((t) => t.date >= previousRange.start);
  const monthTwoBackExpenses = lookbackExpenseTransactions.filter((t) => t.date < previousRange.start);

  const cashFlowTrend = await computeCashFlowTrend(
    client,
    userId,
    currentMonthKey,
    currentMonth,
    previousMonthKey,
    previousMonth,
    previousRange.start
  );
  const monthlyExpenseGroups = [
    currentTransactions.filter((t) => t.type === "expense"),
    previousMonthExpenses,
    monthTwoBackExpenses,
  ];
  // The three-way fetch/split above (current, previous, monthTwoBack) is
  // this function's own hand-written realization of "the last
  // RECURRING_EXPENSE_LOOKBACK_MONTHS months" - this keeps them in sync
  // (computeRecurringExpenses' monthsChecked is only meaningful if the
  // array it receives actually matches the constant) rather than letting
  // the two silently drift if one is ever changed without the other.
  if (monthlyExpenseGroups.length !== RECURRING_EXPENSE_LOOKBACK_MONTHS) {
    throw new Error("recurring-expense lookback window mismatch - update the fetch above to match");
  }
  const recurringExpenses = computeRecurringExpenses(monthlyExpenseGroups);

  return {
    totalBalance,
    currentMonth,
    previousMonth,
    categoryTrends: computeCategoryTrends(currentMonth, previousMonth),
    topMerchants: computeTopMerchants(currentTransactions),
    topDiscretionaryCategories: computeTopDiscretionaryCategories(currentTransactions),
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      date: t.date,
      category: t.category.name,
      amount: t.amount,
      type: t.type,
      description: t.description,
    })),
    incomeChange: computeOverallChange(currentMonth.income, previousMonth.income),
    expenseChange: computeOverallChange(currentMonth.expense, previousMonth.expense),
    savingsRate: computeSavingsRate(currentMonth.income, currentMonth.expense),
    unusualTransactions: computeUnusualTransactions(currentTransactions),
    recurringExpenses,
    cashFlowTrend,
  };
}
