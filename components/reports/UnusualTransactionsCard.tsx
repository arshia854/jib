import type { UnusualTransaction } from "@/lib/reports/trend-insights";
import { formatToman, formatNumber } from "@/lib/format";
import { AlertIcon } from "@/components/icons";

interface UnusualTransactionsCardProps {
  transactions: UnusualTransaction[];
}

/**
 * Badge tone per entry. Discretionary keeps this card's existing warning badge - it's the
 * actionable group. Essential entries get the neutral "info" tone from HighlightCard's own TONE
 * map (same bg-border/40 text-muted badge pairing), for the same reason that file applies it to
 * essentialIncreaseCandidate: a necessary cost that spiked isn't something to act on, and
 * dressing it in warning colors reads as an accusation the data doesn't support.
 */
const BADGE_TONE = {
  discretionary: "bg-warning/10 text-warning",
  essential: "bg-border/40 text-muted",
} as const;

/**
 * Current-period expense transactions flagged as unusual (>= 3x the average of their category's
 * other transactions across the recent-periods lookback window - see
 * lib/reports/trend-insights.ts's getUnusualTransactions). Renders nothing when the list is
 * empty, same secondary-card convention as RecurringExpensesCard - no full-page EmptyState here.
 *
 * Discretionary (isEssential: false) entries are listed first, each group sorted by multiple
 * descending: the discretionary ones are the group a user can actually do something about, so
 * they get the top of the list regardless of whether an essential entry has a bigger multiple.
 */
export function UnusualTransactionsCard({ transactions }: UnusualTransactionsCardProps) {
  if (transactions.length === 0) return null;

  const sorted = [...transactions].sort(
    (a, b) => Number(a.isEssential) - Number(b.isEssential) || b.multiple - a.multiple
  );

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
          <AlertIcon className="h-4.5 w-4.5" />
        </div>
        <span className="text-sm font-semibold text-foreground">تراکنش‌های غیرعادی</span>
      </div>

      <ul className="divide-y divide-border border-t border-border">
        {sorted.map((txn) => (
          <li key={txn.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{txn.description ?? txn.category}</span>
              <span className="truncate text-[11px] text-muted">
                {txn.category} · {formatToman(txn.amount)}
              </span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-fa ${
                BADGE_TONE[txn.isEssential ? "essential" : "discretionary"]
              }`}
            >
              {formatNumber(txn.multiple)}× میانگین
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
