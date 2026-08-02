import type { MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";
import type { Highlight } from "@/lib/reports/generate-highlights";
import { CategoryComparisonBar } from "./CategoryComparisonBar";
import { HighlightCard } from "./HighlightCard";

interface MonthlyComparisonReportProps {
  comparison: MonthlyComparisonResult;
  highlights: Highlight[];
}

// Rotating accent palette drawn from the app's existing design tokens (app/globals.css).
// CategoryComparison has no per-category color of its own, so bars cycle through these.
const CATEGORY_COLORS = ["var(--accent)", "var(--primary)", "var(--success)", "var(--warning)", "var(--muted)", "var(--primary-dark)"];

export function MonthlyComparisonReport({ comparison, highlights }: MonthlyComparisonReportProps) {
  const { categories, previousMonth, currentMonth } = comparison;

  return (
    <div className="space-y-3">
      {categories.map((category, index) => (
        <CategoryComparisonBar
          key={category.category}
          data={category}
          color={CATEGORY_COLORS[index % CATEGORY_COLORS.length]}
          previousMonth={previousMonth}
          currentMonth={currentMonth}
        />
      ))}

      {highlights.length > 0 && (
        <div className="space-y-3 pt-2">
          <h2 className="text-sm font-semibold text-foreground">نکات برجسته</h2>
          {highlights.map((highlight, index) => (
            <HighlightCard key={index} highlight={highlight} />
          ))}
        </div>
      )}
    </div>
  );
}

/*
Usage example (wiring left for a later task):

import { MonthlyComparisonReport } from "@/components/reports/MonthlyComparisonReport";

const comparison: MonthlyComparisonResult = {
  currentMonth: "1404-05",
  previousMonth: "1404-04",
  totalPrevious: 4500000,
  totalCurrent: 3800000,
  totalPercentChange: -16,
  categories: [
    {
      category: "خوراک",
      previousAmount: 2000000,
      currentAmount: 1400000,
      percentChange: -30,
      isIncrease: false,
    },
    {
      category: "حمل و نقل",
      previousAmount: 500000,
      currentAmount: 900000,
      percentChange: 80,
      isIncrease: true,
    },
  ],
};

const highlights: Highlight[] = [
  { type: "positive", message: "عالی! هزینه‌های شما ۱۶٪ نسبت به ماه قبل کاهش یافته است." },
  { type: "warning", category: "حمل و نقل", message: "هزینه «حمل و نقل» نسبت به ماه قبل ۸۰٪ افزایش یافته — کمی مراقب باشید." },
];

<MonthlyComparisonReport comparison={comparison} highlights={highlights} />
*/
