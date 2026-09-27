import type { CategoryComparison } from "@/lib/reports/monthly-comparison";
import { formatNumber, formatCompactToman, periodKeyToShortLabel } from "@/lib/format";
import type { ReportGranularity } from "@/lib/reports/period-range";
import { ShieldIcon, TagIcon } from "@/components/icons";

interface CategoryComparisonBarProps {
  data: CategoryComparison;
  granularity: ReportGranularity;
  previousMonth: string;
  currentMonth: string;
  // Shared across every bar in the list (see MonthlyComparisonReport) so bar widths are
  // comparable across categories, not just within one category's own previous/current pair.
  sharedMax: number;
}

// Text-labelled chip rather than a bare icon, so essential vs. discretionary reads without a
// legend. Same muted-vs-accent mapping as DiscretionarySplitCard (rendered just above this list):
// muted for "necessary", the brand accent for "the reducible slice".
function EssentialTag({ isEssential }: { isEssential: boolean }) {
  const Icon = isEssential ? ShieldIcon : TagIcon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        isEssential ? "bg-border/50 text-muted" : "bg-primary-bg text-primary-soft"
      }`}
    >
      <Icon className="h-3 w-3" />
      {isEssential ? "ضروری" : "غیرضروری"}
    </span>
  );
}

// One period's row: label, bar on the shared scale, value. The previous period is the thinner,
// fainter bar and the current period the thicker bg-primary one - the "نوار پررنگ / نوار کم‌رنگ"
// key in MonthlyComparisonReport's header describes exactly this pairing.
function PeriodRow({ label, amount, maxAmount, current }: { label: string; amount: number; maxAmount: number; current: boolean }) {
  return (
    <div className="grid grid-cols-[3.25rem_1fr_4.5rem] items-center gap-2.5">
      <span className={`truncate text-[11px] ${current ? "font-medium text-foreground" : "text-muted"}`}>{label}</span>
      <div className={`min-w-0 overflow-hidden rounded-full bg-border/40 ${current ? "h-2.5" : "h-1.5"}`}>
        <div
          className={`h-full rounded-full ${current ? "bg-primary" : "bg-muted/45"}`}
          style={{ width: `${(amount / maxAmount) * 100}%` }}
        />
      </div>
      <span className={`text-end text-xs tabular-fa ${current ? "font-semibold text-foreground" : "text-muted"}`}>
        {formatCompactToman(amount)}
      </span>
    </div>
  );
}

/**
 * One category's row inside MonthlyComparisonReport's grouped comparison card (the card chrome and
 * the dividers between rows live there) - name + essential tag + % change on top, then previous
 * and current period bars on one scale shared across every row.
 */
export function CategoryComparisonBar({ data, granularity, previousMonth, currentMonth, sharedMax }: CategoryComparisonBarProps) {
  const { percentChange, previousAmount, currentAmount, isEssential } = data;
  const isDecrease = percentChange !== null && percentChange < 0;
  const isIncrease = percentChange !== null && percentChange > 0;
  const badgeTone = isDecrease ? "bg-success/10 text-success" : isIncrease ? "bg-warning/10 text-warning" : "bg-border/50 text-muted";
  const badgeSign = isIncrease ? "+" : isDecrease ? "−" : "";
  const maxAmount = Math.max(sharedMax, 1);

  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{data.category}</span>
          <EssentialTag isEssential={isEssential} />
        </span>
        {percentChange !== null && (
          // dir="ltr": keeps the sign attached to the digits ("+۱۷۱٪") instead of the RTL bidi
          // algorithm splitting them apart around the percent sign - same fix as
          // PeriodTrendChart's ValueLabel.
          <span dir="ltr" className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-fa ${badgeTone}`}>
            {badgeSign}
            {formatNumber(Math.abs(percentChange))}٪
          </span>
        )}
      </div>

      <div className="mt-3 space-y-2">
        <PeriodRow
          label={periodKeyToShortLabel(previousMonth, granularity)}
          amount={previousAmount}
          maxAmount={maxAmount}
          current={false}
        />
        <PeriodRow
          label={periodKeyToShortLabel(currentMonth, granularity)}
          amount={currentAmount}
          maxAmount={maxAmount}
          current
        />
      </div>
    </div>
  );
}
