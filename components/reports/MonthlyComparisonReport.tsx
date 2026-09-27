import type { MonthlyComparisonResult } from "@/lib/reports/monthly-comparison";
import type { Highlight } from "@/lib/reports/generate-highlights";
import type { TrendPeriod, RecurringExpense, UnusualTransaction } from "@/lib/reports/trend-insights";
import type { ReportGranularity } from "@/lib/reports/period-range";
import type { NarrativeReport } from "@/lib/reports/narrative-report";
import type { LivePrices } from "@/lib/prices/get-live-prices";
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
  // Fetched alongside the above by app/app/reports/page.tsx; undefined when
  // getLivePrices() threw LivePriceUnavailableError. Passed straight through to
  // DiscretionarySplitCard for its gold-equivalent detail view - no other card here uses it.
  livePrices?: LivePrices;
}

// Caption under the category-list heading. Kept local (rather than imported from
// app/app/reports/page.tsx) so this component doesn't depend on its page.
const COMPARISON_CAPTION: Record<ReportGranularity, string> = {
  week: "نسبت به هفته قبل",
  month: "نسبت به ماه قبل",
  year: "نسبت به سال قبل",
};

export function MonthlyComparisonReport({
  comparison,
  highlights,
  trend,
  granularity,
  recurringExpenses,
  unusualTransactions,
  narrative,
  livePrices,
}: MonthlyComparisonReportProps) {
  const { categories, previousMonth, currentMonth } = comparison;
  // Shared across every bar so widths are comparable across categories, not just within one
  // category's own previous/current pair (see CategoryComparisonBar).
  const sharedMax = Math.max(...categories.flatMap((c) => [c.previousAmount, c.currentAmount]), 1);

  return (
    <div className="space-y-3">
      <NarrativeReportCard report={narrative} />

      <PeriodTrendChart periods={trend} granularity={granularity} />

      <DiscretionarySplitCard categories={categories} livePrices={livePrices} />

      <section className="space-y-3 pt-3">
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">مقایسه دسته‌ها</h2>
          <p className="text-xs text-muted">{COMPARISON_CAPTION[granularity]}</p>
        </div>

        {/* All categories in one card, divided rows - one scannable list on one shared scale,
            instead of a separate card per category. Essential/discretionary is labelled on each
            row by CategoryComparisonBar's own tag, so the key here only explains the two bars. */}
        <div className="rounded-2xl border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[11px] text-muted">
            <span aria-hidden="true" className="flex w-4 shrink-0 flex-col gap-0.5">
              <span className="h-1 w-3 rounded-full bg-muted/45" />
              <span className="h-1.5 w-4 rounded-full bg-primary" />
            </span>
            <span>نوار پررنگ = این دوره · نوار کم‌رنگ = دوره قبل</span>
          </div>
          <div className="divide-y divide-border">
            {categories.map((category) => (
              <CategoryComparisonBar
                key={category.category}
                data={category}
                granularity={granularity}
                previousMonth={previousMonth}
                currentMonth={currentMonth}
                sharedMax={sharedMax}
              />
            ))}
          </div>
        </div>
      </section>

      <RecurringExpensesCard expenses={recurringExpenses} />
      <UnusualTransactionsCard transactions={unusualTransactions} />

      {highlights.length > 0 && (
        <section className="space-y-3 pt-3">
          <h2 className="text-sm font-semibold text-foreground">نکات برجسته</h2>
          {highlights.map((highlight, index) => (
            <HighlightCard key={index} highlight={highlight} />
          ))}
        </section>
      )}
    </div>
  );
}
