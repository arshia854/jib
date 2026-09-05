import type { MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";
import type { Highlight } from "@/lib/reports/generate-highlights";
import type { TrendPeriod, RecurringExpense, UnusualTransaction } from "@/lib/reports/trend-insights";
import type { ReportGranularity } from "@/lib/reports/period-range";
import type { NarrativeReport } from "@/lib/reports/narrative-report";
import { CategoryComparisonBar } from "./CategoryComparisonBar";
import { DiscretionarySplitCard } from "./DiscretionarySplitCard";
import { PeriodTrendChart } from "./PeriodTrendChart";
import { RecurringExpensesCard } from "./RecurringExpensesCard";
import { UnusualTransactionsCard } from "./UnusualTransactionsCard";
import { HighlightCard } from "./HighlightCard";
import { NarrativeReportCard } from "./NarrativeReportCard";

interface MonthlyComparisonReportProps {
  comparison: MonthlyComparisonResult;
  highlights: Highlight[];
  // Phase 2 (docs/roadmap-status.md) - lib/reports/trend-insights.ts's data, fetched alongside
  // `comparison` by app/app/reports/page.tsx for the same currentPeriod/granularity.
  trend: TrendPeriod[];
  granularity: ReportGranularity;
  recurringExpenses: RecurringExpense[];
  unusualTransactions: UnusualTransaction[];
  // Phase 3 (docs/roadmap-status.md) - lib/reports/narrative-report.ts's deterministic summary,
  // built on top of the same comparison/trend/unusualTransactions already fetched above.
  narrative: NarrativeReport;
}

// Rotating accent palette drawn from the app's existing design tokens (app/globals.css).
// CategoryComparison has no per-category color of its own, so bars cycle through these.
const CATEGORY_COLORS = ["var(--accent)", "var(--primary)", "var(--success)", "var(--warning)", "var(--muted)", "var(--primary-dark)"];

export function MonthlyComparisonReport({
  comparison,
  highlights,
  trend,
  granularity,
  recurringExpenses,
  unusualTransactions,
  narrative,
}: MonthlyComparisonReportProps) {
  const { categories, previousMonth, currentMonth } = comparison;
  // Shared across every bar so widths are comparable across categories, not just within one
  // category's own previous/current pair (see CategoryComparisonBar).
  const sharedMax = Math.max(...categories.flatMap((c) => [c.previousAmount, c.currentAmount]), 1);

  return (
    <div className="space-y-3">
      <NarrativeReportCard report={narrative} />

      <PeriodTrendChart periods={trend} granularity={granularity} />

      <DiscretionarySplitCard categories={categories} />

      {categories.map((category, index) => (
        <CategoryComparisonBar
          key={category.category}
          data={category}
          color={CATEGORY_COLORS[index % CATEGORY_COLORS.length]}
          previousMonth={previousMonth}
          currentMonth={currentMonth}
          sharedMax={sharedMax}
        />
      ))}

      <RecurringExpensesCard expenses={recurringExpenses} />
      <UnusualTransactionsCard transactions={unusualTransactions} />

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
