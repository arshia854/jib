import type { CategoryComparison } from "@/lib/reports/monthly-comparison";
import { formatNumber, jalaaliMonthKeyToLabel } from "@/lib/format";
import { ShieldIcon, TagIcon } from "@/components/icons";

interface CategoryComparisonBarProps {
  data: CategoryComparison;
  color: string;
  previousMonth: string;
  currentMonth: string;
  // Shared across every bar in the list (see MonthlyComparisonReport) so bar widths are
  // comparable across categories, not just within one category's own previous/current pair.
  sharedMax: number;
}

export function CategoryComparisonBar({ data, color, previousMonth, currentMonth, sharedMax }: CategoryComparisonBarProps) {
  const { percentChange, previousAmount, currentAmount, isEssential } = data;
  const isDecrease = percentChange !== null && percentChange < 0;
  const isIncrease = percentChange !== null && percentChange > 0;
  const badgeTone = isDecrease ? "bg-success/10 text-success" : isIncrease ? "bg-warning/10 text-warning" : "bg-border/50 text-muted";
  const badgeSign = isIncrease ? "+" : isDecrease ? "−" : "";
  const maxAmount = Math.max(sharedMax, 1);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          {isEssential ? (
            <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="ضروری" />
          ) : (
            <TagIcon className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="غیرضروری" />
          )}
          <span className="truncate">{data.category}</span>
        </span>
        {percentChange !== null && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-fa ${badgeTone}`}>
            {badgeSign}
            {formatNumber(Math.abs(percentChange))}٪
          </span>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full bg-border"
              style={{ width: `${(previousAmount / maxAmount) * 100}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-[11px] text-muted">{jalaaliMonthKeyToLabel(previousMonth)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-border/60">
            <div
              className="h-full rounded-full"
              style={{ width: `${(currentAmount / maxAmount) * 100}%`, backgroundColor: color }}
            />
          </div>
          <span className="w-12 shrink-0 text-[11px] text-muted">{jalaaliMonthKeyToLabel(currentMonth)}</span>
        </div>
      </div>
    </div>
  );
}
