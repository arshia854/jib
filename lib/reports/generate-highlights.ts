import type { CategoryComparison, MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";

export type HighlightType = "positive" | "warning";

export interface Highlight {
  type: HighlightType;
  message: string; // Persian, RTL-ready
  category?: string;
}

const WARNING_INCREASE_THRESHOLD = 50;
const SAVINGS_DECREASE_THRESHOLD = -50;
const MAX_HIGHLIGHTS = 3;

/** Default periodLabel — matches the previous, hardcoded "ماه قبل" wording so callers that don't pass one see no change. */
const DEFAULT_PERIOD_LABEL = "نسبت به ماه قبل";

interface Candidate {
  highlight: Highlight;
  isOverall: boolean;
  magnitude: number;
}

function overallSavingsCandidate(result: MonthlyComparisonResult, periodLabel: string): Candidate | null {
  if (result.totalPercentChange === null || result.totalPercentChange >= 0) return null;

  const percent = Math.abs(result.totalPercentChange);
  return {
    isOverall: true,
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

function categoryWarningCandidate(categories: CategoryComparison[], periodLabel: string): Candidate | null {
  const worst = largestBy(
    categories,
    (percentChange) => percentChange >= WARNING_INCREASE_THRESHOLD,
    (candidate, current) => candidate > current
  );
  if (!worst) return null;

  const percent = worst.percentChange as number;
  return {
    isOverall: false,
    magnitude: percent,
    highlight: {
      type: "warning",
      category: worst.category,
      message: `هزینه «${worst.category}» ${periodLabel} ${percent}٪ افزایش یافته — کمی مراقب باشید.`,
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
    isOverall: false,
    magnitude: percent,
    highlight: {
      type: "positive",
      category: best.category,
      message: `صرفه‌جویی خوب در «${best.category}»؛ ${periodLabel} ${percent}٪ کمتر خرج کرده‌اید.`,
    },
  };
}

export function generateHighlights(result: MonthlyComparisonResult, periodLabel: string = DEFAULT_PERIOD_LABEL): Highlight[] {
  const candidates = [
    overallSavingsCandidate(result, periodLabel),
    categoryWarningCandidate(result.categories, periodLabel),
    categorySavingsCandidate(result.categories, periodLabel),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  if (candidates.length <= MAX_HIGHLIGHTS) {
    return candidates.map((candidate) => candidate.highlight);
  }

  return [...candidates]
    .sort((a, b) => {
      if (a.isOverall !== b.isOverall) return a.isOverall ? -1 : 1;
      return b.magnitude - a.magnitude;
    })
    .slice(0, MAX_HIGHLIGHTS)
    .map((candidate) => candidate.highlight);
}
