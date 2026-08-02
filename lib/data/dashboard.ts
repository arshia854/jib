import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";

export async function getDashboardData(userId: number) {
  const { start, end, label } = getJalaaliMonthRange();

  const [accounts, monthTransactions, recentTransactions] = await Promise.all([
    prisma.financeAccount.findMany({
      where: { userId },
      include: { transactions: { select: { amount: true, type: true } } },
    }),
    prisma.transaction.findMany({
      where: { userId, date: { gte: start, lt: end } },
      include: { category: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: 5,
      include: { category: true },
    }),
  ]);

  const totalBalance = accounts.reduce((sum, account) => {
    const net = account.transactions.reduce(
      (acc, t) => acc + (t.type === "income" ? t.amount : -t.amount),
      0
    );
    return sum + account.initialBalance + net;
  }, 0);

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

  return {
    totalBalance,
    monthLabel: label,
    monthIncome,
    monthExpense,
    categoryBreakdown,
    recentTransactions,
  };
}
