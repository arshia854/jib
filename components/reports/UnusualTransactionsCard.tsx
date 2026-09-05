import type { UnusualTransaction } from "@/lib/reports/trend-insights";
import { formatToman, formatNumber } from "@/lib/format";
import { AlertIcon } from "@/components/icons";

interface UnusualTransactionsCardProps {
  transactions: UnusualTransaction[];
}

/**
 * Current-period expense transactions flagged as unusual (>= 3x their category's other
 * transactions this period - see lib/reports/trend-insights.ts's getUnusualTransactions).
 * Renders nothing when the list is empty, same secondary-card convention as
 * RecurringExpensesCard - no full-page EmptyState here.
 */
export function UnusualTransactionsCard({ transactions }: UnusualTransactionsCardProps) {
  if (transactions.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5">
        <AlertIcon className="h-4 w-4 shrink-0 text-warning" />
        <span className="text-sm font-semibold text-foreground">تراکنش‌های غیرعادی</span>
      </div>

      <ul className="mt-3 space-y-2.5">
        {transactions.map((txn) => (
          <li key={txn.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{txn.description ?? txn.category}</span>
              <span className="truncate text-[11px] text-muted">
                {txn.category} · {formatToman(txn.amount)}
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold tabular-fa text-warning">
              {formatNumber(txn.multiple)}× میانگین
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
