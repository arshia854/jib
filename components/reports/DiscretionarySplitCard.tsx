"use client";

import { useState } from "react";
import type { CategoryComparison } from "@/lib/reports/monthly-comparison";
import type { LivePrices } from "@/lib/prices/get-live-prices";
import { formatToman, formatNumber, formatDecimal } from "@/lib/format";
import { ShieldIcon, TagIcon, ArrowDownIcon } from "@/components/icons";

interface DiscretionarySplitCardProps {
  categories: CategoryComparison[];
  // Server-fetched (app/app/reports/page.tsx) - undefined when getLivePrices() threw
  // LivePriceUnavailableError, in which case the gold-equivalent figures below are simply
  // omitted rather than blocking the toman breakdown. See its own `stale` field for the
  // "prices might be a bit old" case, which does NOT omit anything - see rowToLivePrices'
  // own comment.
  livePrices?: LivePrices;
}

// Same rotating-accent-adjacent tokens as MonthlyComparisonReport's CATEGORY_COLORS - muted
// for "necessary, no real choice here" vs. the brand accent for "this is the reducible slice".
const ESSENTIAL_COLOR = "var(--muted)";
const DISCRETIONARY_COLOR = "var(--primary)";

/** Compact split of the current period's spending into essential vs. discretionary (isEssential), so a user can tell "needed" apart from "reducible" at a glance. */
export function DiscretionarySplitCard({ categories, livePrices }: DiscretionarySplitCardProps) {
  const [expanded, setExpanded] = useState(false);

  const essentialTotal = categories.filter((c) => c.isEssential).reduce((sum, c) => sum + c.currentAmount, 0);
  const discretionaryTotal = categories.filter((c) => !c.isEssential).reduce((sum, c) => sum + c.currentAmount, 0);
  const total = essentialTotal + discretionaryTotal;
  const discretionaryShare = total > 0 ? Math.round((discretionaryTotal / total) * 100) : 0;
  const essentialWidth = total > 0 ? (essentialTotal / total) * 100 : 0;
  const discretionaryWidth = total > 0 ? (discretionaryTotal / total) * 100 : 0;

  // Sorted descending by currentAmount, dropping the ones that contributed nothing this
  // period - a category with currentAmount <= 0 (nothing spent, or the rare negative/refund
  // case) has nothing meaningful to show in a "where did this money go" breakdown.
  const discretionaryCategories = categories
    .filter((c) => !c.isEssential && c.currentAmount > 0)
    .sort((a, b) => b.currentAmount - a.currentAmount);

  // Only meaningful when there's an actual discretionary total to convert and a live price
  // to convert it with - `stale` prices still get used here (same "best number we have, with
  // a note" convention as lib/data/assets.ts), only a full LivePriceUnavailableError omits it.
  const goldGrams =
    livePrices && discretionaryTotal > 0 ? discretionaryTotal / livePrices.goldGramPricePerUnit : null;

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

      {discretionaryCategories.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between gap-2 text-xs font-medium text-muted"
            aria-expanded={expanded}
          >
            <span>جزئیات</span>
            <ArrowDownIcon className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>

          {expanded && (
            <div className="mt-2 space-y-1.5">
              {discretionaryCategories.map((category) => (
                <div key={category.category} className="flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate">{category.category}</span>
                  <span className="shrink-0 tabular-fa">{formatToman(category.currentAmount)}</span>
                </div>
              ))}

              {goldGrams !== null && (
                <p className="pt-1 text-[11px] tabular-fa text-muted">
                  کل غیرضروری ≈ {formatDecimal(goldGrams)} گرم طلا
                </p>
              )}
              {livePrices?.stale && (
                <p className="text-[11px] text-muted">قیمت‌ها ممکن است کاملاً به‌روز نباشند.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
