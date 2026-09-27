import "server-only";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { getBalances, listAccounts } from "@/lib/data/accounts";
import { listSavingsStrategies } from "@/lib/data/savings-strategies";
import { pickDefaultTransferAccounts } from "@/lib/accounts";
import { getCachedUser } from "@/lib/auth/session";
import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";
import { logger } from "@/lib/observability/logger"; // TEMP-LATENCY
import { getRequestId } from "@/lib/observability/request-context"; // TEMP-LATENCY

// Long enough to cover the redirect after a normal add-transaction save,
// short enough that the income-reaction banner never resurfaces as
// stale/confusing on an unrelated later visit.
export const INCOME_REACTION_WINDOW_MS = 15 * 60 * 1000;

export interface IncomeReaction {
  // The income Transaction's own id - the stable per-event key the client
  // keys its persisted dismissal on (components/dashboard/income-reaction-banner.tsx).
  incomeTransactionId: number;
  incomeAmount: number;
  items: {
    strategyId: number;
    label: string;
    percent: number;
    suggestedAmount: number;
    transferHref: string | null;
  }[];
}

// Same strings as components/savings/savings-manager.tsx's FORMULA_LABEL -
// duplicated rather than imported, since that's a client component and this
// file is server-only (same call as FEASIBILITY_STATUS_LABEL in
// lib/data/chat-context.ts).
const FORMULA_LABEL: Record<string, string> = {
  fifty_thirty_twenty: "۵۰/۳۰/۲۰",
  pay_yourself_first: "اول به خودت پرداخت کن",
  leftover: "ته‌مانده‌ی ماه",
  roundup: "گرد کردن تراکنش‌ها",
  custom: "دلخواه",
};

// What the user's active percent-based strategies say to set aside from the
// income they just logged - null when there's nothing to show. Amount-based
// strategies are deliberately excluded: they aren't tied to a specific income
// event. Returns before the two extra queries below (most-recent income,
// accounts) unless the user actually has such a strategy, so a user who's
// never touched savings strategies doesn't pay for them on every dashboard
// load.
async function buildIncomeReaction(
  userId: number,
  strategies: Awaited<ReturnType<typeof listSavingsStrategies>>
): Promise<IncomeReaction | null> {
  const buildIncomeReactionStartedAt = Date.now(); // TEMP-LATENCY
  const logBuildIncomeReactionTiming = (earlyReturn: boolean) => // TEMP-LATENCY
    logger.info( // TEMP-LATENCY
      { // TEMP-LATENCY
        requestId: getRequestId(), // TEMP-LATENCY
        route: "data/dashboard", // TEMP-LATENCY
        userId, // TEMP-LATENCY
        step: "buildIncomeReaction", // TEMP-LATENCY
        duration: Date.now() - buildIncomeReactionStartedAt, // TEMP-LATENCY
        earlyReturn, // TEMP-LATENCY
      }, // TEMP-LATENCY
      "getDashboardData step timing" // TEMP-LATENCY
    ); // TEMP-LATENCY

  const percentStrategies = strategies.filter((s) => s.status === "active" && s.targetPercent !== null);
  if (percentStrategies.length === 0) {
    logBuildIncomeReactionTiming(true); // TEMP-LATENCY
    return null;
  }

  // isTransfer excluded: a transfer's destination leg is itself an "income"
  // Transaction row (see schema.prisma's Transaction.transferGroupId) and
  // must never be mistaken for income the user actually earned.
  const latestIncome = await prisma.transaction.findFirst({
    where: { userId, type: "income", category: { isTransfer: false } },
    orderBy: { createdAt: "desc" },
    select: { id: true, amount: true, createdAt: true },
  });
  if (!latestIncome || Date.now() - latestIncome.createdAt.getTime() > INCOME_REACTION_WINDOW_MS) {
    logBuildIncomeReactionTiming(false); // TEMP-LATENCY
    return null;
  }

  const { from, to } = pickDefaultTransferAccounts(await listAccounts(userId));

  logBuildIncomeReactionTiming(false); // TEMP-LATENCY

  return {
    incomeTransactionId: latestIncome.id,
    incomeAmount: latestIncome.amount,
    items: percentStrategies.map((strategy) => {
      const percent = strategy.targetPercent as number;
      const suggestedAmount = Math.round((percent / 100) * latestIncome.amount);
      const label = FORMULA_LABEL[strategy.formulaType] ?? strategy.formulaType;
      // Same /app/transfer prefill shape as the savings page's own
      // shortcut (components/savings/savings-manager.tsx) - omitted when
      // there's no from/to pair or nothing to pre-fill.
      const transferHref =
        from && to && suggestedAmount > 0
          ? `/app/transfer?from=${from.id}&to=${to.id}&amount=${suggestedAmount}&note=${encodeURIComponent(
              "پیاده‌سازی استراتژی " + label
            )}`
          : null;
      return { strategyId: strategy.id, label, percent, suggestedAmount, transferHref };
    }),
  };
}

export async function getDashboardData(userId: number) {
  const totalStartedAt = Date.now(); // TEMP-LATENCY
  const { start, end, label } = getJalaaliMonthRange();

  const promiseAllStartedAt = Date.now(); // TEMP-LATENCY
  const logStep = <T,>(step: string, promise: Promise<T>): Promise<T> => // TEMP-LATENCY
    promise.then((v) => { // TEMP-LATENCY
      logger.info( // TEMP-LATENCY
        { // TEMP-LATENCY
          requestId: getRequestId(), // TEMP-LATENCY
          route: "data/dashboard", // TEMP-LATENCY
          userId, // TEMP-LATENCY
          step, // TEMP-LATENCY
          finishedAtMs: Date.now() - promiseAllStartedAt, // TEMP-LATENCY
        }, // TEMP-LATENCY
        "getDashboardData step timing" // TEMP-LATENCY
      ); // TEMP-LATENCY
      return v; // TEMP-LATENCY
    }); // TEMP-LATENCY

  // totalBalance (Phase 17, docs/roadmap-status.md): used to load every
  // transaction row ever created for the user's accounts just to sum them
  // in JS - unbounded work that grew forever with usage. Now a bounded
  // aggregate via getBalances() (lib/data/accounts.ts) - Turso latency fix,
  // docs/roadmap-status.md: getTotalBalance() and getSavingsBalance() used
  // to be called separately here (4 queries total), each independently
  // re-running the same underlying account/balanceGroup lookup; getBalances()
  // runs it once and derives both figures in JS. Still intentionally keeps
  // transfer transactions (unlike monthTransactions below) - a transfer
  // still moves real money between real account balances.
  //
  // `user` (Turso latency fix): the same request-scoped getCachedUser()
  // (lib/auth/session.ts) that getCurrentUser()/getActiveUser() already use
  // for this userId elsewhere in the same /app render - within that one
  // render pass this is a cache hit, not a fourth independent
  // `prisma.user.findUnique`. See getCachedUser's own comment for exactly
  // how (and how far) that memoization extends.
  const [user, balances, savingsAccountCount, monthTransactions, recentTransactions, strategies] =
    await Promise.all([
      logStep("user", getCachedUser(userId)), // TEMP-LATENCY
      logStep("balances", getBalances(userId)), // TEMP-LATENCY
      // Gates whether the savings card renders at all (see app/app/page.tsx) -
      // same "opt-in, don't show a feature the user has never touched"
      // reasoning as balanceInGoldGrams/balanceInUsd below, just gated on
      // "has a savings account" instead of a settings toggle. A cheap count,
      // not a second findMany - nothing here needs the accounts' own rows,
      // only whether at least one exists.
      logStep("savingsAccountCount", prisma.financeAccount.count({ where: { userId, type: "savings" } })), // TEMP-LATENCY
      logStep( // TEMP-LATENCY
        "monthTransactions", // TEMP-LATENCY
        prisma.transaction.findMany({
          // A transfer between the user's own accounts (Category.isTransfer) is
          // not real income or a real expense - excluded here so it can't
          // inflate monthIncome/monthExpense/categoryBreakdown below. totalBalance
          // is computed separately from each account's own full transaction
          // history (not this list) and intentionally keeps transfers, since
          // they still move real money between real account balances.
          where: { userId, date: { gte: start, lt: end }, category: { isTransfer: false } },
          include: { category: true },
        })
      ), // TEMP-LATENCY
      logStep( // TEMP-LATENCY
        "recentTransactions", // TEMP-LATENCY
        prisma.transaction.findMany({
          where: { userId },
          orderBy: { date: "desc" },
          take: 5,
          // account added for the same reason as lib/data/transactions.ts's
          // listTransactions() - Phase A3's transfer-pair merge (see
          // lib/transactions/group-transfer-pairs.ts) needs each leg's
          // account name.
          include: { category: true, account: { select: { id: true, name: true } } },
        })
      ), // TEMP-LATENCY
      logStep("strategies", listSavingsStrategies(userId)), // TEMP-LATENCY
    ]);
  const { totalBalance, savingsBalance } = balances;

  const incomeReaction = await buildIncomeReaction(userId, strategies);

  // NOTE: the `totalBalance` returned below means "spendable balance, savings
  // excluded" (getTotalBalance() - getSavingsBalance()), NOT the grand total
  // that getTotalBalance() itself returns. Savings is earmarked money, so
  // counting it inside the headline "موجودی کل" figure overstates what's
  // actually available to spend - it's shown separately as `savingsBalance`
  // instead. The field name is kept because its only consumer
  // (app/app/page.tsx -> BalanceCard's `balance` prop) already renders
  // savingsBalance on its own line. Deliberately different from
  // lib/analytics/spending-summary.ts's `totalBalance`, which stays the true
  // grand total (with availableBalance/savingsBalance alongside it).
  const availableBalance = totalBalance - savingsBalance;

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
  const getLivePricesStartedAt = Date.now(); // TEMP-LATENCY
  if (user?.showBalanceInAssets) {
    try {
      const prices = await getLivePrices();
      // The gold/USD equivalent of what could be spent (availableBalance),
      // not of spendable plus set-aside savings - same reasoning as above.
      balanceInGoldGrams = availableBalance / prices.goldGramPricePerUnit;
      balanceInUsd = availableBalance / prices.usdPricePerUnit;
    } catch (error) {
      if (!(error instanceof LivePriceUnavailableError)) throw error;
    }
  }
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "data/dashboard", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "getLivePrices", // TEMP-LATENCY
      duration: Date.now() - getLivePricesStartedAt, // TEMP-LATENCY
      showBalanceInAssets: Boolean(user?.showBalanceInAssets), // TEMP-LATENCY
    }, // TEMP-LATENCY
    "getDashboardData step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY

  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "data/dashboard", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "total", // TEMP-LATENCY
      duration: Date.now() - totalStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "getDashboardData step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY

  return {
    totalBalance: availableBalance,
    savingsBalance,
    hasSavingsAccount: savingsAccountCount > 0,
    monthLabel: label,
    monthIncome,
    monthExpense,
    categoryBreakdown,
    recentTransactions,
    balanceInGoldGrams,
    balanceInUsd,
    incomeReaction,
  };
}
