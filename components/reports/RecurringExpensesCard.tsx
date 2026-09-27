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
    <div className="rounded-2xl border border-border bg-surface">
      <div className="flex items-start gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-bg text-primary-soft">
          <RefreshIcon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <span className="text-sm font-semibold text-foreground">هزینه‌های تکرارشونده</span>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">این‌ها را مرور کنید — شاید اشتراک یا قبضی باشد که یادتان رفته.</p>
        </div>
      </div>

      <ul className="divide-y divide-border border-t border-border">
        {expenses.map((expense) => (
          <li key={expense.description} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{expense.description}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <PresenceMeter present={expense.monthsPresent} checked={expense.monthsChecked} />
                <span className="text-[11px] tabular-fa text-muted">
                  {formatNumber(expense.monthsPresent)} از {formatNumber(expense.monthsChecked)} دوره
                </span>
              </div>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-fa text-foreground">{formatToman(expense.averageAmount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// "N of M periods" as M short segments with the first N filled - a count, read like a battery
// level, alongside (never instead of) the same figure in text right next to it.
function PresenceMeter({ present, checked }: { present: number; checked: number }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 gap-0.5">
      {Array.from({ length: checked }, (_, i) => (
        <span key={i} className={`h-1.5 w-2.5 rounded-full ${i < present ? "bg-primary-soft" : "bg-border"}`} />
      ))}
    </span>
  );
}
