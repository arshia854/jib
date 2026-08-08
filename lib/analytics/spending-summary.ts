import { toJalaali } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";

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
}

const RECENT_TRANSACTIONS_TAKE = 10;
const TOP_MERCHANTS_TAKE = 5;
const TOP_DISCRETIONARY_CATEGORIES_TAKE = 5;

type MonthTransaction = {
  amount: number;
  type: string;
  description: string | null;
  category: { name: string; isEssential: boolean };
};

function monthKeyFor(date: Date): string {
  const { jy, jm } = toJalaali(date);
  return `${jy}-${String(jm).padStart(2, "0")}`;
}

function summarizeMonth(transactions: MonthTransaction[], label: string): MonthSummary {
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

/** Top merchants/descriptions this month by total expense amount, grouped case-insensitively with surrounding whitespace trimmed. */
function computeTopMerchants(transactions: MonthTransaction[]): MerchantSummary[] {
  const groups = new Map<string, MerchantSummary>();

  for (const t of transactions) {
    if (t.type !== "expense") continue;
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

  return [...groups.values()].sort((a, b) => b.total - a.total).slice(0, TOP_MERCHANTS_TAKE);
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
async function getCachedPreviousMonth(
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

async function computeAndCachePreviousMonth(
  client: PrismaClient,
  userId: number,
  monthKey: string,
  start: Date,
  end: Date,
  label: string
): Promise<MonthSummary> {
  const transactions = await client.transaction.findMany({
    where: { userId, date: { gte: start, lt: end } },
    include: { category: true },
  });
  const summary = summarizeMonth(transactions, label);

  // Previous-month data is immutable in practice - users don't edit month-old
  // transactions often - so caching it here saves a full aggregation query on
  // nearly every chat message for active users. The current, still-open
  // month is never cached (see getSpendingSummary below) since it changes
  // with every new transaction. A cache-write failure shouldn't break the
  // summary itself, so it's best-effort.
  await client.spendingSummaryCache
    .upsert({
      where: { userId_monthKey: { userId, monthKey } },
      create: { userId, monthKey, payload: JSON.stringify(summary), computedAt: new Date() },
      update: { payload: JSON.stringify(summary), computedAt: new Date() },
    })
    .catch(() => {});

  return summary;
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

  const [currentTransactions, cachedPreviousMonth, accounts, recentTransactions] = await Promise.all([
    client.transaction.findMany({
      where: { userId, date: { gte: currentRange.start, lt: currentRange.end } },
      include: { category: true },
    }),
    getCachedPreviousMonth(client, userId, previousMonthKey),
    client.financeAccount.findMany({
      where: { userId },
      include: { transactions: { select: { amount: true, type: true } } },
    }),
    client.transaction.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: RECENT_TRANSACTIONS_TAKE,
      include: { category: true },
    }),
  ]);

  const currentMonth = summarizeMonth(currentTransactions, currentRange.label);
  const previousMonth =
    cachedPreviousMonth ??
    (await computeAndCachePreviousMonth(
      client,
      userId,
      previousMonthKey,
      previousRange.start,
      previousRange.end,
      previousRange.label
    ));

  const totalBalance = accounts.reduce((sum, a) => {
    const net = a.transactions.reduce((s, t) => s + (t.type === "income" ? t.amount : -t.amount), 0);
    return sum + a.initialBalance + net;
  }, 0);

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
  };
}
