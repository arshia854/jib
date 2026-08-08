import {
  getSpendingSummary,
  type CategoryTotal,
  type CategoryTrend,
  type MerchantSummary,
  type RecentTransactionSummary,
} from "@/lib/analytics/spending-summary";
import { getUserFacts, formatFactsForPrompt } from "@/lib/facts/user-facts";

const fa = (n: number) => Math.round(n).toLocaleString("fa-IR");

// Caps kept low on purpose - this text goes into the LLM prompt on every
// chat message, so it stays compact even for users with many
// categories/transactions. The full structured data (all categories, last
// 10 transactions) still exists on the object returned by
// getSpendingSummary(), for future tool-calling use.
const MAX_CATEGORY_LINES = 8;
const MAX_RECENT_LINES = 5;

function formatCategoryLines(categories: CategoryTotal[]): string {
  if (categories.length === 0) return "بدون هزینه ثبت‌شده";

  const top = categories.slice(0, MAX_CATEGORY_LINES);
  const lines = top.map((c) => `- ${c.name}: ${fa(c.total)} تومان`);

  const rest = categories.length - top.length;
  if (rest > 0) lines.push(`و ${fa(rest)} دسته دیگر`);

  return lines.join("\n");
}

function formatTrendLines(trends: CategoryTrend[]): string {
  if (trends.length === 0) return "داده‌ای برای مقایسه نیست";

  return trends
    .map((t) => {
      const sign = t.percentChange >= 0 ? "+" : "";
      return `- ${t.category}: ${sign}${fa(t.percentChange)}٪`;
    })
    .join("\n");
}

function formatMerchantLines(merchants: MerchantSummary[]): string {
  if (merchants.length === 0) return "بدون فروشنده تکراری";

  return merchants.map((m) => `- ${m.description} (${fa(m.count)} بار): ${fa(m.total)} تومان`).join("\n");
}

// getSpendingSummary already caps this list at TOP_DISCRETIONARY_CATEGORIES_TAKE
// (5) entries, so unlike formatCategoryLines there's no separate "N more"
// line to add here - it's always the full (short) list.
function formatDiscretionaryCategoryLines(categories: CategoryTotal[]): string {
  if (categories.length === 0) return "بدون هزینه غیرضروری ثبت‌شده";

  return categories.map((c) => `- ${c.name}: ${fa(c.total)} تومان`).join("\n");
}

function formatRecentLines(recent: RecentTransactionSummary[]): string {
  if (recent.length === 0) return "بدون تراکنش";

  return recent
    .slice(0, MAX_RECENT_LINES)
    .map((t) => {
      const sign = t.type === "income" ? "+" : "-";
      return `- ${t.date.toISOString().slice(0, 10)} | ${t.category} | ${sign}${fa(t.amount)} تومان | ${
        t.description ?? "بدون توضیح"
      }`;
    })
    .join("\n");
}

export async function getFinancialContextSummary(userId: number): Promise<string> {
  // Facts are only ever read here - never inferred synchronously (see
  // lib/facts/infer-facts.ts's inferFactsForUser doc comment) so this stays
  // a plain, predictable-latency Prisma read like the summary above.
  const [summary, facts] = await Promise.all([getSpendingSummary(userId), getUserFacts(userId)]);

  return `موجودی کل: ${fa(summary.totalBalance)} تومان
خلاصه ${summary.currentMonth.label}: درآمد ${fa(summary.currentMonth.income)} تومان، هزینه ${fa(
    summary.currentMonth.expense
  )} تومان
هزینه غیرضروری این ماه: ${fa(summary.currentMonth.discretionaryExpense)} تومان

هزینه‌ها به تفکیک دسته (این ماه):
${formatCategoryLines(summary.currentMonth.categories)}

دسته‌های هزینه غیرضروری (این ماه):
${formatDiscretionaryCategoryLines(summary.topDiscretionaryCategories)}

تغییرات نسبت به ${summary.previousMonth.label}:
${formatTrendLines(summary.categoryTrends)}

فروشنده‌های پرتکرار این ماه:
${formatMerchantLines(summary.topMerchants)}

تراکنش‌های اخیر:
${formatRecentLines(summary.recentTransactions)}

واقعیت‌های شناخته‌شده درباره کاربر:
${formatFactsForPrompt(facts)}`;
}
