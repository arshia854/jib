import type { MonthlyComparisonResult, CategoryComparison } from "@/lib/reports/monthly-comparison";
import type { TrendPeriod, UnusualTransaction } from "@/lib/reports/trend-insights";
import { getPeriodSavingsRate } from "@/lib/reports/trend-insights";
import { periodToGregorianRange, type ReportGranularity } from "@/lib/reports/period-range";
import { formatToman, formatNumber } from "@/lib/format";

export type NarrativeStatus = "good" | "medium" | "bad" | "unknown";

export interface NarrativeInsight {
  message: string;
  category: string;
  amount: number;
  // Set only for the unusual-transaction-sourced insight (rule 3a below) - the absolute-increase
  // fallback (rule 3b) has no single "times average" figure to report.
  multiple?: number;
}

export interface NarrativeProjection {
  message: string;
  // Category name, or TOTAL_EXPENSE_LABEL when no single category applies (see resolveTarget).
  target: string;
  projectedTotal: number;
  // The prior-period baseline projectedTotal was compared against.
  baselineAmount: number;
  elapsedFraction: number;
}

export interface NarrativeSuggestion {
  message: string;
  target: string;
  cap: number;
}

export interface NarrativeOpportunity {
  message: string;
  amount: number;
}

export interface NarrativeReport {
  periodLabel: string;
  income: number;
  expense: number;
  status: NarrativeStatus;
  // From getPeriodSavingsRate - undefined exactly when there's no income this period (see
  // computeSavingsRate's own doc comment in lib/analytics/spending-summary.ts).
  savingsRate?: number;
  topCategory?: { name: string; amount: number };
  // comparison.totalPercentChange, passed through unchanged.
  overallTrendPercent: number | null;
  insight?: NarrativeInsight;
  projection?: NarrativeProjection;
  suggestion?: NarrativeSuggestion;
  opportunity?: NarrativeOpportunity;
}

export interface GenerateNarrativeReportParams {
  granularity: ReportGranularity;
  currentPeriod: string;
  comparison: MonthlyComparisonResult;
  // Must include an entry whose periodKey === currentPeriod (getPeriodTrend, given
  // periodsBack >= 0, always returns one) - that entry is this report's only source for
  // income (getComparison's own totals are expense-only).
  trend: TrendPeriod[];
  unusualTransactions: UnusualTransaction[];
  // Injectable for deterministic testing of the elapsed-fraction projection below; defaults to
  // the real current time.
  now?: Date;
}

/** "این هفته"/"این ماه"/"این سال" - labels the period itself, distinct from generateHighlights'
 * PERIOD_LABELS (app/app/reports/page.tsx), which phrase a *comparison* ("نسبت به ماه قبل").
 * Both conventions already exist independently in this codebase (e.g. chat-context.ts's "نرخ
 * پس‌انداز این ماه"), so this isn't a new pattern - just this module's own copy of the "این X"
 * half, kept local since page.tsx's PERIOD_LABELS constant is private to that file. */
const PERIOD_LABELS: Record<ReportGranularity, string> = {
  week: "این هفته",
  month: "این ماه",
  year: "این سال",
};

/** Mirrors page.tsx's own PERIOD_LABELS wording (also private to that file) for phrases that
 * need to reference the *previous* period generically, without importing across that boundary. */
const PREVIOUS_PERIOD_LABELS: Record<ReportGranularity, string> = {
  week: "هفته قبل",
  month: "ماه قبل",
  year: "سال قبل",
};

/** Label used for `insight`/`projection`/`suggestion`'s `target`/`category` field when the
 * projection/suggestion had to fall back to the period's total expense (rule 4/5) rather than a
 * single category - see resolveTarget. */
export const TOTAL_EXPENSE_LABEL = "کل هزینه‌ها";

/**
 * A projection off less than this fraction of the period elapsed is extrapolating from too
 * little data - e.g. at 2% elapsed, a single day's spending divided by 0.02 explodes to a wildly
 * unstable number that says more about that one day than about the period. 10% is a simple,
 * named floor (roughly half a day of a week, ~3 days of a month, ~5 weeks of a year) below which
 * the projection is omitted entirely rather than shown as a misleadingly precise-looking figure.
 */
export const MIN_ELAPSED_FRACTION_FOR_PROJECTION = 0.1;

/**
 * Reduction rate applied to current discretionary (isEssential: false) spending to produce the
 * "opportunity" figure - a reasoned-but-arbitrary default (no calibration data exists for this
 * app, same caveat spending-summary.ts documents for UNUSUAL_TRANSACTION_MULTIPLIER), named here
 * so "why 10, not some other number" has one place to update later.
 */
export const OPPORTUNITY_REDUCTION_PERCENT = 10;

function statusFromSavingsRate(savingsRate: number | undefined): NarrativeStatus {
  if (savingsRate === undefined) return "unknown";
  if (savingsRate >= 20) return "good";
  if (savingsRate >= 0) return "medium";
  return "bad";
}

/**
 * Rule 3 (insight priority):
 *   a. the single highest-`multiple` unusual transaction, if any exist (computeUnusualTransactions
 *      already returns them sorted descending by multiple - see spending-summary.ts).
 *   b. otherwise, the comparison category with the largest *absolute* toman increase
 *      (currentAmount - previousAmount), matching generate-highlights.ts's own "amount over
 *      percent" principle for its discretionary-warning candidate. That file's own qualifying
 *      threshold (WARNING_ABSOLUTE_INCREASE_SHARE) is private and this phase's scope forbids
 *      modifying generate-highlights.ts to export it - and it wouldn't quite fit here anyway,
 *      since it exists to decide whether an increase is *warning-worthy*, not to pick this
 *      module's single "most important" observation. The bar used here is simpler and needs no
 *      imported constant: an increase must be > 0 (something genuinely went up) to be
 *      "meaningful" at all.
 *   c. otherwise omitted - not fabricated.
 */
function resolveInsight(
  comparison: MonthlyComparisonResult,
  unusualTransactions: UnusualTransaction[]
): NarrativeInsight | undefined {
  if (unusualTransactions.length > 0) {
    // computeUnusualTransactions (lib/analytics/spending-summary.ts) already returns these sorted
    // descending by multiple, so [0] would normally be enough - reduce() here is a defensive,
    // near-zero-cost explicit max rather than leaning on a sort order this function doesn't own.
    const top = unusualTransactions.reduce((best, t) => (t.multiple > best.multiple ? t : best));
    return {
      category: top.category,
      amount: top.amount,
      multiple: top.multiple,
      message: `«${top.category}»: یه تراکنش ${formatToman(top.amount)} ثبت شده، ${formatNumber(top.multiple)} برابر میانگین همیشگیت توی این دسته.`,
    };
  }

  let best: CategoryComparison | null = null;
  let bestDelta = 0;
  for (const category of comparison.categories) {
    const delta = category.currentAmount - category.previousAmount;
    if (delta > bestDelta) {
      best = category;
      bestDelta = delta;
    }
  }
  if (!best) return undefined;

  return {
    category: best.category,
    amount: bestDelta,
    message: `بیشترین افزایش خرجت مربوط به «${best.category}» بوده، ${formatToman(bestDelta)} بیشتر از دوره قبل.`,
  };
}

interface ProjectionTarget {
  label: string;
  isTotal: boolean;
  currentAmount: number;
  previousAmount: number;
}

/**
 * Rule 4/5's shared target: the category `insight` points at, else `topCategory`, else the
 * period's total expense - applied consistently to both the projection and the suggested cap so
 * the two always talk about the same thing.
 */
function resolveTarget(
  comparison: MonthlyComparisonResult,
  insight: NarrativeInsight | undefined,
  topCategory: { name: string; amount: number } | undefined
): ProjectionTarget {
  if (insight) {
    const match = comparison.categories.find((c) => c.category === insight.category);
    if (match) {
      return { label: match.category, isTotal: false, currentAmount: match.currentAmount, previousAmount: match.previousAmount };
    }
    // Defensive only - an insight's category always comes from this same period's expense
    // transactions/categories, so it should always be found. Falls through to topCategory rather
    // than silently mis-projecting against a target that doesn't match the insight.
  }

  if (topCategory) {
    const match = comparison.categories.find((c) => c.category === topCategory.name);
    if (match) {
      return { label: match.category, isTotal: false, currentAmount: match.currentAmount, previousAmount: match.previousAmount };
    }
  }

  return { label: TOTAL_EXPENSE_LABEL, isTotal: true, currentAmount: comparison.totalCurrent, previousAmount: comparison.totalPrevious };
}

function targetPhrase(target: ProjectionTarget): string {
  return target.isTotal ? target.label : `«${target.label}»`;
}

/**
 * Rule 4: linear, elapsed-time-based extrapolation of `target`'s current-period spend so far.
 * Omitted when:
 *  - the period has barely started (see MIN_ELAPSED_FRACTION_FOR_PROJECTION) - too little data
 *    to extrapolate from without exploding to a meaningless number, or
 *  - there's no previous-period baseline to call the projection "higher than usual" against
 *    (previousAmount <= 0 - a brand-new category/user has no "usual" to compare to), or
 *  - the projection doesn't actually exceed that baseline - "on track to spend less" isn't a
 *    warning worth surfacing here, so it's simply omitted rather than reframed as good news
 *    (kept simple/consistent, documented per the task's own "your call" allowance).
 */
function resolveProjection(target: ProjectionTarget, elapsedFraction: number, periodLabel: string): NarrativeProjection | undefined {
  if (elapsedFraction < MIN_ELAPSED_FRACTION_FOR_PROJECTION) return undefined;
  if (target.previousAmount <= 0) return undefined;

  const projectedTotal = target.currentAmount / elapsedFraction;
  if (projectedTotal <= target.previousAmount) return undefined;

  const over = projectedTotal - target.previousAmount;
  return {
    target: target.label,
    projectedTotal,
    baselineAmount: target.previousAmount,
    elapsedFraction,
    message: `با این روند، ${targetPhrase(target)} تا آخر ${periodLabel} حدود ${formatToman(projectedTotal)} می‌شه - ${formatToman(over)} بیشتر از حد معمولت.`,
  };
}

/** Rule 5: cap = target's previous-period baseline - "cap it at what you spent last period", no invented percentage. Omitted when there's no baseline to anchor to. */
function resolveSuggestion(target: ProjectionTarget, previousPeriodLabel: string): NarrativeSuggestion | undefined {
  if (target.previousAmount <= 0) return undefined;

  return {
    target: target.label,
    cap: target.previousAmount,
    message: `برای ${targetPhrase(target)} این دوره می‌تونی سقف ${formatToman(target.previousAmount)} بذاری - همون چیزی که ${previousPeriodLabel} خرج کردی.`,
  };
}

/** Rule 6: OPPORTUNITY_REDUCTION_PERCENT of current-period discretionary spend. Omitted when there's none. */
function resolveOpportunity(comparison: MonthlyComparisonResult): NarrativeOpportunity | undefined {
  const discretionaryTotal = comparison.categories
    .filter((c) => !c.isEssential)
    .reduce((sum, c) => sum + c.currentAmount, 0);
  if (discretionaryTotal <= 0) return undefined;

  const amount = Math.round((discretionaryTotal * OPPORTUNITY_REDUCTION_PERCENT) / 100);
  return {
    amount,
    message: `اگه ${formatNumber(OPPORTUNITY_REDUCTION_PERCENT)}٪ از هزینه‌های غیرضروریت رو کم کنی، می‌تونی این دوره حدود ${formatToman(amount)} پس‌انداز کنی.`,
  };
}

/**
 * Deterministic (no LLM), pure narrative summary of one week/month/year report period - a single
 * cohesive read on top of the already-computed comparison/trend/unusual-transaction data (see
 * lib/reports/monthly-comparison.ts, lib/reports/trend-insights.ts). Every field is either
 * genuinely computed from that data or omitted - never a placeholder.
 */
export function generateNarrativeReport(params: GenerateNarrativeReportParams): NarrativeReport {
  const { granularity, currentPeriod, comparison, trend, unusualTransactions } = params;
  const now = params.now ?? new Date();

  const currentTrendPeriod = trend.find((p) => p.periodKey === currentPeriod);
  if (!currentTrendPeriod) {
    throw new Error(
      `generateNarrativeReport: trend has no entry for currentPeriod "${currentPeriod}" - callers must fetch it via getPeriodTrend, which always includes the current period.`
    );
  }
  const { income, expense } = currentTrendPeriod;

  const savingsRate = getPeriodSavingsRate(income, expense);
  const status = statusFromSavingsRate(savingsRate);

  const topCategoryComparison = comparison.categories[0];
  const topCategory = topCategoryComparison ? { name: topCategoryComparison.category, amount: topCategoryComparison.currentAmount } : undefined;

  const insight = resolveInsight(comparison, unusualTransactions);
  const target = resolveTarget(comparison, insight, topCategory);

  const { start, end } = periodToGregorianRange(currentPeriod, granularity);
  const totalMs = end.getTime() - start.getTime();
  const elapsedFraction = totalMs > 0 ? Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / totalMs)) : 1;

  const periodLabel = PERIOD_LABELS[granularity];
  const previousPeriodLabel = PREVIOUS_PERIOD_LABELS[granularity];

  return {
    periodLabel,
    income,
    expense,
    status,
    savingsRate,
    topCategory,
    overallTrendPercent: comparison.totalPercentChange,
    insight,
    projection: resolveProjection(target, elapsedFraction, periodLabel),
    suggestion: resolveSuggestion(target, previousPeriodLabel),
    opportunity: resolveOpportunity(comparison),
  };
}
