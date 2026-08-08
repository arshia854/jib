import type { TodaySpendingResult } from "@/lib/reports/today-spending";
import { formatToman } from "@/lib/format";

interface TodaySpendingReportProps {
  spending: TodaySpendingResult;
}

// Same rotating accent palette as MonthlyComparisonReport (app/globals.css design tokens).
// There's no previous period to compare against here, so — unlike CategoryComparisonBar —
// this is a plain list of rows (a dot + name + amount), no bars or percent-change badges.
const CATEGORY_COLORS = ["var(--accent)", "var(--primary)", "var(--success)", "var(--warning)", "var(--muted)", "var(--primary-dark)"];

export function TodaySpendingReport({ spending }: TodaySpendingReportProps) {
  const { categories, total } = spending;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="space-y-3">
        {categories.map((category, index) => (
          <div key={category.category} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }}
              />
              <span className="truncate text-sm font-medium text-foreground">{category.category}</span>
            </div>
            <span className="shrink-0 text-sm tabular-fa text-muted">{formatToman(category.amount)}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm font-semibold text-foreground">جمع کل</span>
        <span className="text-sm font-bold tabular-fa text-foreground">{formatToman(total)}</span>
      </div>
    </div>
  );
}
