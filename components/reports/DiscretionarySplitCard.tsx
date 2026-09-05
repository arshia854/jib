import type { CategoryComparison } from "@/lib/reports/monthly-comparison";
import { formatToman, formatNumber } from "@/lib/format";
import { ShieldIcon, TagIcon } from "@/components/icons";

interface DiscretionarySplitCardProps {
  categories: CategoryComparison[];
}

// Same rotating-accent-adjacent tokens as MonthlyComparisonReport's CATEGORY_COLORS - muted
// for "necessary, no real choice here" vs. the brand accent for "this is the reducible slice".
const ESSENTIAL_COLOR = "var(--muted)";
const DISCRETIONARY_COLOR = "var(--primary)";

/** Compact split of the current period's spending into essential vs. discretionary (isEssential), so a user can tell "needed" apart from "reducible" at a glance. */
export function DiscretionarySplitCard({ categories }: DiscretionarySplitCardProps) {
  const essentialTotal = categories.filter((c) => c.isEssential).reduce((sum, c) => sum + c.currentAmount, 0);
  const discretionaryTotal = categories.filter((c) => !c.isEssential).reduce((sum, c) => sum + c.currentAmount, 0);
  const total = essentialTotal + discretionaryTotal;
  const discretionaryShare = total > 0 ? Math.round((discretionaryTotal / total) * 100) : 0;
  const essentialWidth = total > 0 ? (essentialTotal / total) * 100 : 0;
  const discretionaryWidth = total > 0 ? (discretionaryTotal / total) * 100 : 0;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">ضروری در مقابل غیرضروری</span>
        <span className="shrink-0 rounded-full bg-border/50 px-2 py-0.5 text-xs font-semibold tabular-fa text-muted">
          {formatNumber(discretionaryShare)}٪ غیرضروری
        </span>
      </div>

      {/* 2px surface-color gap between the two segments (only when both are non-zero) so they
          read as distinct without drawing a border around either. */}
      <div className="mt-3 flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-border/60">
        {essentialWidth > 0 && (
          <div className="h-full rounded-full" style={{ width: `${essentialWidth}%`, backgroundColor: ESSENTIAL_COLOR }} />
        )}
        {discretionaryWidth > 0 && (
          <div className="h-full rounded-full" style={{ width: `${discretionaryWidth}%`, backgroundColor: DISCRETIONARY_COLOR }} />
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-muted">
          <ShieldIcon className="h-3.5 w-3.5 shrink-0" style={{ color: ESSENTIAL_COLOR }} />
          <span className="truncate">ضروری: {formatToman(essentialTotal)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted">
          <TagIcon className="h-3.5 w-3.5 shrink-0" style={{ color: DISCRETIONARY_COLOR }} />
          <span className="truncate">غیرضروری: {formatToman(discretionaryTotal)}</span>
        </span>
      </div>
    </div>
  );
}
