import type { RecurringExpense } from "@/lib/reports/trend-insights";
import { formatToman, formatNumber } from "@/lib/format";
import { RefreshIcon } from "@/components/icons";

interface RecurringExpensesCardProps {
  expenses: RecurringExpense[];
}

/**
 * Descriptions that recurred as an expense across recent periods (see
 * lib/reports/trend-insights.ts's getRecurringExpenses) - framed as "review these" (a
 * subscription or bill worth double-checking), not as a warning, since recurring isn't
 * inherently bad. Renders nothing when the list is empty, matching how ActivityHeatmap/
 * TodaySpendingReport's own callers (app/app/reports/page.tsx) skip a section instead of
 * showing an empty card - this is a secondary card, not the primary report content, so a
 * full-page empty state (EmptyState) would be wrong here.
 */
export function RecurringExpensesCard({ expenses }: RecurringExpensesCardProps) {
  if (expenses.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5">
        <RefreshIcon className="h-4 w-4 shrink-0 text-muted" />
        <span className="text-sm font-semibold text-foreground">هزینه‌های تکرارشونده</span>
      </div>
      <p className="mt-1 text-xs text-muted">این‌ها را مرور کنید — شاید اشتراک یا قبضی باشد که یادتان رفته.</p>

      <ul className="mt-3 space-y-2.5">
        {expenses.map((expense) => (
          <li key={expense.description} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate text-foreground">{expense.description}</span>
            <span className="shrink-0 text-xs tabular-fa text-muted">
              {formatNumber(expense.monthsPresent)} از {formatNumber(expense.monthsChecked)} دوره ·{" "}
              {formatToman(expense.averageAmount)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
