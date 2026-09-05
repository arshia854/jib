import type { CategoryComparison, MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";
import { formatToman } from "@/lib/format";

export type HighlightType = "positive" | "warning" | "info";

export interface Highlight {
  type: HighlightType;
  message: string; // Persian, RTL-ready
  category?: string;
  // Only set on the discretionary-total highlight (see discretionaryTotalCandidate) - the
  // raw figure behind `message`'s formatted toman string, for a caller that wants the number
  // itself rather than re-parsing it out of Persian text.
  amount?: number;
}

const WARNING_INCREASE_THRESHOLD = 50;
const SAVINGS_DECREASE_THRESHOLD = -50;
// A discretionary category's absolute increase (currentAmount - previousAmount) counts as a
// warning candidate on its own once it exceeds this share of the period's total spending -
// independent of WARNING_INCREASE_THRESHOLD, so a big-money category that grew "only" 20% but
// moved a large chunk of toman still surfaces (a category that grew 51% from 10,000 to 15,100
// toman would otherwise trigger the same warning as one that grew 51% from 5,000,000 to
// 7,550,000). Base is totalCurrent, falling back to totalPrevious if totalCurrent is 0.
const WARNING_ABSOLUTE_INCREASE_SHARE = 0.15;
const MAX_HIGHLIGHTS = 3;

/** Default periodLabel — matches the previous, hardcoded "ماه قبل" wording so callers that don't pass one see no change. */
const DEFAULT_PERIOD_LABEL = "نسبت به ماه قبل";

interface Candidate {
  highlight: Highlight;
  // Priority tier: lower sorts first when MAX_HIGHLIGHTS trims the list. 0 = the overall
  // savings headline. 1 = discretionary/actionable insights (the ones a user can act on). 2 =
  // essential-cost movement - informational, but shouldn't crowd out tier 1 in the ranking.
  priority: 0 | 1 | 2;
  magnitude: number; // used to rank within the same priority tier
}

function overallSavingsCandidate(result: MonthlyComparisonResult, periodLabel: string): Candidate | null {
  if (result.totalPercentChange === null || result.totalPercentChange >= 0) return null;

  const percent = Math.abs(result.totalPercentChange);
  return {
    priority: 0,
    magnitude: percent,
    highlight: {
      type: "positive",
      message: `عالی! هزینه‌های شما ${percent}٪ ${periodLabel} کاهش یافته است.`,
    },
  };
}

function largestBy(
  categories: CategoryComparison[],
  qualifies: (percentChange: number) => boolean,
  isBetter: (candidate: number, current: number) => boolean
): CategoryComparison | null {
  let best: CategoryComparison | null = null;
  for (const category of categories) {
    if (category.percentChange === null || !qualifies(category.percentChange)) continue;
    if (best === null || isBetter(category.percentChange, best.percentChange as number)) {
      best = category;
    }
  }
  return best;
}

/** (currentAmount - previousAmount) as a share of the period's total spending - see WARNING_ABSOLUTE_INCREASE_SHARE. */
function absoluteIncreaseShare(category: CategoryComparison, result: MonthlyComparisonResult): number {
  const base = result.totalCurrent > 0 ? result.totalCurrent : result.totalPrevious;
  if (base <= 0) return 0;
  return (category.currentAmount - category.previousAmount) / base;
}

/**
 * The single largest discretionary (isEssential: false) cost increase, qualifying either by
 * relative growth (percentChange >= WARNING_INCREASE_THRESHOLD) or by absolute weight
 * (absoluteIncreaseShare >= WARNING_ABSOLUTE_INCREASE_SHARE) - whichever signal is stronger for
 * a given category also decides its ranking magnitude against other candidates.
 *
 * Phrased as actionable: a discretionary cost is one the user can choose to cut.
 */
function discretionaryWarningCandidate(result: MonthlyComparisonResult, periodLabel: string): Candidate | null {
  let best: CategoryComparison | null = null;
  let bestMagnitude = -Infinity;

  for (const category of result.categories) {
    if (category.isEssential || category.percentChange === null) continue;

    const percent = category.percentChange;
    const share = absoluteIncreaseShare(category, result) * 100;
    const qualifies = percent >= WARNING_INCREASE_THRESHOLD || share >= WARNING_ABSOLUTE_INCREASE_SHARE * 100;
    if (!qualifies) continue;

    const magnitude = Math.max(percent, share);
    if (magnitude > bestMagnitude) {
      best = category;
      bestMagnitude = magnitude;
    }
  }

  if (!best) return null;

  const percent = best.percentChange as number;
  return {
    priority: 1,
    magnitude: bestMagnitude,
    highlight: {
      type: "warning",
      category: best.category,
      message: `هزینه «${best.category}» ${periodLabel} ${percent}٪ افزایش یافته — کمی مراقب باشید.`,
    },
  };
}

/**
 * The single largest essential (isEssential: true) cost increase. Unlike
 * discretionaryWarningCandidate, this only qualifies by relative growth (an essential cost isn't
 * something to reduce just because it moved a lot of toman) and is phrased neutrally - it's a
 * necessary cost that grew, not something "to be careful about" - and ranked in its own lower
 * priority tier so it doesn't drown out the actionable, discretionary-focused highlights above.
 */
function essentialIncreaseCandidate(categories: CategoryComparison[], periodLabel: string): Candidate | null {
  const worst = largestBy(
    categories.filter((category) => category.isEssential),
    (percentChange) => percentChange >= WARNING_INCREASE_THRESHOLD,
    (candidate, current) => candidate > current
  );
  if (!worst) return null;

  const percent = worst.percentChange as number;
  return {
    priority: 2,
    magnitude: percent,
    highlight: {
      type: "info",
      category: worst.category,
      message: `هزینه ضروری «${worst.category}» ${periodLabel} ${percent}٪ افزایش یافته است.`,
    },
  };
}

function categorySavingsCandidate(categories: CategoryComparison[], periodLabel: string): Candidate | null {
  const best = largestBy(
    categories,
    (percentChange) => percentChange <= SAVINGS_DECREASE_THRESHOLD,
    (candidate, current) => candidate < current
  );
  if (!best) return null;

  const percent = Math.abs(best.percentChange as number);
  return {
    priority: 1,
    magnitude: percent,
    highlight: {
      type: "positive",
      category: best.category,
      message: `صرفه‌جویی خوب در «${best.category}»؛ ${periodLabel} ${percent}٪ کمتر خرج کرده‌اید.`,
    },
  };
}

/**
 * The current period's total discretionary (isEssential: false) spending, as a concrete,
 * reducible toman figure - independent of whether any single category increased. Ranked by its
 * share of totalCurrent, so a period dominated by discretionary spending outranks one where it's
 * a small slice.
 */
function discretionaryTotalCandidate(result: MonthlyComparisonResult): Candidate | null {
  if (result.totalCurrent <= 0) return null;

  const discretionaryTotal = result.categories
    .filter((category) => !category.isEssential)
    .reduce((sum, category) => sum + category.currentAmount, 0);
  if (discretionaryTotal <= 0) return null;

  const share = (discretionaryTotal / result.totalCurrent) * 100;
  return {
    priority: 1,
    magnitude: share,
    highlight: {
      type: "warning",
      amount: discretionaryTotal,
      message: `${formatToman(discretionaryTotal)} از هزینه‌های این دوره غیرضروری بوده و قابل کاهش است.`,
    },
  };
}

export function generateHighlights(result: MonthlyComparisonResult, periodLabel: string = DEFAULT_PERIOD_LABEL): Highlight[] {
  const candidates = [
    overallSavingsCandidate(result, periodLabel),
    discretionaryWarningCandidate(result, periodLabel),
    discretionaryTotalCandidate(result),
    categorySavingsCandidate(result.categories, periodLabel),
    essentialIncreaseCandidate(result.categories, periodLabel),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  if (candidates.length <= MAX_HIGHLIGHTS) {
    return candidates.map((candidate) => candidate.highlight);
  }

  return [...candidates]
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.magnitude - a.magnitude;
    })
    .slice(0, MAX_HIGHLIGHTS)
    .map((candidate) => candidate.highlight);
}
