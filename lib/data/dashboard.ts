import "server-only";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getTotalBalance } from "@/lib/data/accounts";
import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";

export async function getDashboardData(userId: number) {
  const { start, end, label } = getJalaaliMonthRange();

  // totalBalance (Phase 17, docs/roadmap-status.md): used to load every
  // transaction row ever created for the user's accounts just to sum them
  // in JS - unbounded work that grew forever with usage. Now a bounded
  // aggregate via getTotalBalance() (lib/data/accounts.ts), shared with
  // lib/analytics/spending-summary.ts's identical previous bug. Still
  // intentionally keeps transfer transactions (unlike monthTransactions
  // below) - a transfer still moves real money between real account
  // balances.
  const [user, totalBalance, monthTransactions, recentTransactions] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { showBalanceInAssets: true } }),
    getTotalBalance(userId),
    prisma.transaction.findMany({
      // A transfer between the user's own accounts (Category.isTransfer) is
      // not real income or a real expense - excluded here so it can't
      // inflate monthIncome/monthExpense/categoryBreakdown below. totalBalance
      // is computed separately from each account's own full transaction
      // history (not this list) and intentionally keeps transfers, since
      // they still move real money between real account balances.
      where: { userId, date: { gte: start, lt: end }, category: { isTransfer: false } },
      include: { category: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: 5,
      include: { category: true },
    }),
  ]);

  const monthIncome = monthTransactions
    .filter((t) => t.type === "income")
    .reduce((sum, t) => sum + t.amount, 0);
  const monthExpense = monthTransactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);

  const categoryTotals = new Map<number, { name: string; icon: string; color: string; total: number }>();
  for (const t of monthTransactions) {
    if (t.type !== "expense") continue;
    const existing = categoryTotals.get(t.categoryId);
    if (existing) {
      existing.total += t.amount;
    } else {
      categoryTotals.set(t.categoryId, {
        name: t.category.name,
        icon: t.category.icon,
        color: t.category.color,
        total: t.amount,
      });
    }
  }

  const categoryBreakdown = [...categoryTotals.values()].sort((a, b) => b.total - a.total);

  // Opt-in only (see the Assets-feature toggle in app/app/settings/page.tsx)
  // - getLivePrices() is only ever called for a user who turned this on, so
  // a user who doesn't care about it costs nothing against brsapi.ir's
  // daily free-tier quota. Falls back to null (not thrown) on
  // LivePriceUnavailableError so a temporary price-feed outage never breaks
  // the whole dashboard - app/app/page.tsx just omits the line.
  let balanceInGoldGrams: number | null = null;
  let balanceInUsd: number | null = null;
  if (user?.showBalanceInAssets) {
    try {
      const prices = await getLivePrices();
      balanceInGoldGrams = totalBalance / prices.goldGramPricePerUnit;
      balanceInUsd = totalBalance / prices.usdPricePerUnit;
    } catch (error) {
      if (!(error instanceof LivePriceUnavailableError)) throw error;
    }
  }

  return {
    totalBalance,
    monthLabel: label,
    monthIncome,
    monthExpense,
    categoryBreakdown,
    recentTransactions,
    balanceInGoldGrams,
    balanceInUsd,
  };
}
