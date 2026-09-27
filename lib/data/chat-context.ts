import "server-only";
import {
  getSpendingSummary,
  type CategoryTotal,
  type CategoryTrend,
  type MerchantSummary,
  type RecentTransactionSummary,
  type OverallTrend,
  type UnusualTransaction,
  type RecurringExpense,
} from "@/lib/analytics/spending-summary";
import { getUserFacts, formatFactsForPrompt } from "@/lib/facts/user-facts";
import { listAssetsWithValue, type AssetWithValue } from "@/lib/data/assets";
import { getAssetTypeLabel, getAssetTypeOption } from "@/lib/assets";
import { listGoalsWithFeasibility, type GoalWithFeasibility } from "@/lib/data/goals";
import { formatDecimal, formatJalaaliDate } from "@/lib/format";

const fa = (n: number) => Math.round(n).toLocaleString("fa-IR");

// Caps kept low on purpose - this text goes into the LLM prompt on every
// chat message, so it stays compact even for users with many
// categories/transactions. The full structured data (all categories, last
// 10 transactions) still exists on the object returned by
// getSpendingSummary(), for future tool-calling use.
const MAX_CATEGORY_LINES = 8;
const MAX_RECENT_LINES = 5;
// Phase 10 additions - same "keep it short, cap it" discipline as the two
// above. unusualTransactions/recurringExpenses are already naturally small
// in practice (a strict >=3x-average / >=2-of-3-months definition rarely
// produces many hits), but still explicitly capped rather than left
// unbounded, same reasoning as every other line-cap in this file.
const MAX_UNUSUAL_TRANSACTION_LINES = 3;
const MAX_RECURRING_EXPENSE_LINES = 5;
// Assets integration - same "keep it short, cap it" discipline as every
// other line-cap in this file. Most users hold only a handful of lots
// (gold/usd/bitcoin/custom), so this rarely actually truncates anything.
const MAX_ASSET_LINES = 8;
// Goals integration - same discipline. Only active goals are worth the
// assistant's attention turn-to-turn (see formatGoalLines below), and a
// user rarely tracks more than a handful of those at once.
const MAX_GOAL_LINES = 5;

// Same three-state vocabulary/labels as components/goals/goals-manager.tsx's
// FEASIBILITY_TONE - that map also carries badge/icon styling this
// plain-text prompt line has no use for, so it isn't imported directly
// (it's a client component anyway - see lib/goals/feasibility.ts's own
// "server-only" pragma for why a shared module isn't straightforward here).
const FEASIBILITY_STATUS_LABEL: Record<GoalWithFeasibility["feasibility"]["feasibilityStatus"], string> = {
  on_track: "در مسیر",
  needs_adjustment: "نیاز به تعدیل",
  unrealistic: "غیرواقعی",
};

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

// Phase 10 - a single "درآمد/هزینه: +N٪" line, or the omission note when
// there's no previous-month baseline (mirrors formatTrendLines' own
// "داده‌ای برای مقایسه نیست" wording for the per-category case).
function formatOverallChangeLine(label: string, trend: OverallTrend | undefined): string {
  if (!trend) return `- ${label}: داده‌ای برای مقایسه نیست`;
  const sign = trend.percentChange >= 0 ? "+" : "";
  return `- ${label}: ${sign}${fa(trend.percentChange)}٪`;
}

// categoryAverage is a multi-period average (the category's other
// transactions across the last RECURRING_EXPENSE_LOOKBACK_MONTHS months -
// see computeUnusualTransactions), so the line says "۳ ماه اخیر" rather
// than leaving the LLM to assume it's this month's own average and tell
// the user something false about where the number came from.
function formatUnusualTransactionLines(transactions: UnusualTransaction[]): string {
  if (transactions.length === 0) return "تراکنش غیرعادی‌ای شناسایی نشد";

  const top = transactions.slice(0, MAX_UNUSUAL_TRANSACTION_LINES);
  const lines = top.map(
    (t) =>
      `- ${t.category} | ${fa(t.amount)} تومان (${fa(t.multiple)} برابر میانگین این دسته در ۳ ماه اخیر: ${fa(t.categoryAverage)} تومان)`
  );

  const rest = transactions.length - top.length;
  if (rest > 0) lines.push(`و ${fa(rest)} مورد دیگر`);

  return lines.join("\n");
}

function formatRecurringExpenseLines(expenses: RecurringExpense[]): string {
  if (expenses.length === 0) return "هزینه تکرارشونده‌ای شناسایی نشد";

  const top = expenses.slice(0, MAX_RECURRING_EXPENSE_LINES);
  const lines = top.map(
    (e) => `- ${e.description} (${fa(e.monthsPresent)} از ${fa(e.monthsChecked)} ماه اخیر): ~${fa(e.averageAmount)} تومان`
  );

  const rest = expenses.length - top.length;
  if (rest > 0) lines.push(`و ${fa(rest)} مورد دیگر`);

  return lines.join("\n");
}

// Assets (طلا/دلار/بیت‌کوین/دستی - lib/data/assets.ts) were previously
// completely invisible to the chat assistant: this file built the whole
// "اطلاعات مالی فعلی کاربر" prompt block from getSpendingSummary/
// getUserFacts alone, so a question like «دارایی من چقدره؟» had nothing to
// answer from except cash-flow data. This mirrors formatCategoryLines'
// own cap-and-"N more" shape below.
function formatAssetLines(assets: AssetWithValue[]): string {
  if (assets.length === 0) return "دارایی ثبت‌شده‌ای وجود ندارد";

  const top = assets.slice(0, MAX_ASSET_LINES);
  const lines = top.map((a) => {
    const label = a.type === "custom" ? (a.name ?? "دارایی دستی") : getAssetTypeLabel(a.type);
    const unit = getAssetTypeOption(a.type)?.unitLabel;
    const quantity = `${formatDecimal(a.quantity, 4)}${unit ? ` ${unit}` : ""}`;
    const value = a.currentValue !== null ? `${fa(a.currentValue)} تومان` : "قیمت لحظه‌ای در دسترس نیست";
    return `- ${label}: ${quantity} — ارزش فعلی: ${value}`;
  });

  const rest = assets.length - top.length;
  if (rest > 0) lines.push(`و ${fa(rest)} مورد دیگر`);

  return lines.join("\n");
}

// Goals were previously invisible to the chat assistant, same gap assets
// had before formatAssetLines above closed it: a question like «برای سفرم
// چقدر کم دارم؟» or advice like «باید کجا کمتر خرج کنم تا به هدفم برسم؟»
// had nothing to draw on except general cash-flow data, even though
// lib/goals/feasibility.ts already computes exactly this per goal. Only
// "active" goals are surfaced - an achieved/abandoned goal has no ongoing
// feasibility to report on and would just be noise in every future turn.
function formatGoalLines(goals: GoalWithFeasibility[]): string {
  const active = goals.filter((g) => g.status === "active");
  if (active.length === 0) return "هدف مالی فعالی تعریف نشده";

  const top = active.slice(0, MAX_GOAL_LINES);
  const lines = top.map((g) => {
    const saved = g.initialAmount;
    const remaining = Math.max(0, g.targetAmount - saved);
    const completion =
      g.feasibility.projectedCompletionMonths !== null
        ? `تخمین رسیدن با روند فعلی: ${fa(g.feasibility.projectedCompletionMonths)} ماه`
        : "با روند فعلی قابل دستیابی نیست";
    return `- ${g.name}: هدف ${fa(g.targetAmount)} تومان، ${fa(saved)} تومان جمع‌شده (${fa(
      remaining
    )} تومان باقی‌مانده)، مهلت ${formatJalaaliDate(g.deadline)}، وضعیت: ${
      FEASIBILITY_STATUS_LABEL[g.feasibility.feasibilityStatus]
    } (${completion})`;
  });

  const rest = active.length - top.length;
  if (rest > 0) lines.push(`و ${fa(rest)} هدف دیگر`);

  return lines.join("\n");
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

// Phase 10 - summary.cashFlowTrend (multi-month net income/expense) is
// deliberately NOT rendered into the prompt text below, unlike the other
// Phase 10 additions. It's a table-shaped fact (several months x 3 numbers
// each) that's a poor fit for compact conversational prose, and its
// marginal value for a typical single chat turn is low relative to what's
// already surfaced (incomeChange/expenseChange already answer "how does
// this month compare", categoryTrends already answers "what changed") -
// the same "full structured data still exists on the object, for future
// tool-calling use" precedent this file's own top-of-file comment already
// establishes for categories/recentTransactions.
export async function getFinancialContextSummary(userId: number): Promise<string> {
  // Facts are only ever read here - never inferred synchronously (see
  // lib/facts/infer-facts.ts's inferFactsForUser doc comment) so this stays
  // a plain, predictable-latency Prisma read like the summary above.
  const [summary, facts, assets, goals] = await Promise.all([
    getSpendingSummary(userId),
    getUserFacts(userId),
    listAssetsWithValue(userId),
    listGoalsWithFeasibility(userId),
  ]);

  // Phase 10 - savingsRate omission (no income this month) gets its own
  // short note rather than a silently-missing line, same "say so, don't
  // guess" spirit as the system prompt's own instruction.
  const savingsRateLine =
    summary.savingsRate === undefined ? "نرخ پس‌انداز: داده‌ای برای محاسبه نیست" : `نرخ پس‌انداز این ماه: ${fa(summary.savingsRate)}٪`;

  return `موجودی قابل‌استفاده (بدون احتساب پس‌انداز): ${fa(summary.availableBalance)} تومان
پس‌انداز: ${fa(summary.savingsBalance)} تومان
مجموع کل دارایی نقدی: ${fa(summary.totalBalance)} تومان
خلاصه ${summary.currentMonth.label}: درآمد ${fa(summary.currentMonth.income)} تومان، هزینه ${fa(
    summary.currentMonth.expense
  )} تومان
هزینه غیرضروری این ماه: ${fa(summary.currentMonth.discretionaryExpense)} تومان
${savingsRateLine}

دارایی‌های ثبت‌شده (طلا/دلار/بیت‌کوین/دستی - جدا از موجودی حساب‌های بالا):
${formatAssetLines(assets.assets)}
ارزش کل دارایی‌ها: ${fa(assets.totalValue)} تومان${assets.priceUnavailable ? " (قیمت لحظه‌ای برخی دارایی‌ها الان در دسترس نیست، این عدد ممکن است دقیق نباشد)" : ""}${assets.priceStale ? " (قیمت‌های استفاده‌شده ممکن است کمی قدیمی باشند)" : ""}

اهداف مالی کاربر:
${formatGoalLines(goals)}

هزینه‌ها به تفکیک دسته (این ماه):
${formatCategoryLines(summary.currentMonth.categories)}

دسته‌های هزینه غیرضروری (این ماه):
${formatDiscretionaryCategoryLines(summary.topDiscretionaryCategories)}

تغییرات نسبت به ${summary.previousMonth.label}:
${formatTrendLines(summary.categoryTrends)}
${formatOverallChangeLine("درآمد کل", summary.incomeChange)}
${formatOverallChangeLine("هزینه کل", summary.expenseChange)}

فروشنده‌های پرتکرار این ماه:
${formatMerchantLines(summary.topMerchants)}

هزینه‌های تکرارشونده (چند ماه اخیر):
${formatRecurringExpenseLines(summary.recurringExpenses)}

تراکنش‌های غیرعادی این ماه (به‌طور محسوسی بیشتر از میانگین همان دسته):
${formatUnusualTransactionLines(summary.unusualTransactions)}

تراکنش‌های اخیر:
${formatRecentLines(summary.recentTransactions)}

واقعیت‌های شناخته‌شده درباره کاربر:
${formatFactsForPrompt(facts)}`;
}
