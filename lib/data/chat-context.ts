import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";

const fa = (n: number) => Math.round(n).toLocaleString("fa-IR");

export async function getFinancialContextSummary(userId: number): Promise<string> {
  const { start, end, label } = getJalaaliMonthRange();

  const [monthTransactions, recentTransactions, accounts] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, date: { gte: start, lt: end } },
      include: { category: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: 15,
      include: { category: true },
    }),
    prisma.financeAccount.findMany({
      where: { userId },
      include: { transactions: { select: { amount: true, type: true } } },
    }),
  ]);

  const totalBalance = accounts.reduce((sum, a) => {
    const net = a.transactions.reduce((s, t) => s + (t.type === "income" ? t.amount : -t.amount), 0);
    return sum + a.initialBalance + net;
  }, 0);

  const monthIncome = monthTransactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const monthExpense = monthTransactions.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  const categoryTotals = new Map<string, number>();
  for (const t of monthTransactions) {
    if (t.type !== "expense") continue;
    categoryTotals.set(t.category.name, (categoryTotals.get(t.category.name) ?? 0) + t.amount);
  }
  const categoryLines =
    [...categoryTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => `- ${name}: ${fa(total)} تومان`)
      .join("\n") || "بدون هزینه ثبت‌شده";

  const recentLines =
    recentTransactions
      .map((t) => {
        const sign = t.type === "income" ? "+" : "-";
        return `- ${t.date.toISOString().slice(0, 10)} | ${t.category.name} | ${sign}${fa(t.amount)} تومان | ${
          t.description ?? t.rawInput
        }`;
      })
      .join("\n") || "بدون تراکنش";

  return `موجودی کل: ${fa(totalBalance)} تومان
خلاصه ${label}: درآمد ${fa(monthIncome)} تومان، هزینه ${fa(monthExpense)} تومان

هزینه‌ها به تفکیک دسته (این ماه):
${categoryLines}

تراکنش‌های اخیر:
${recentLines}`;
}
