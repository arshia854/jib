import { formatToman, formatJalaaliDateShort } from "@/lib/format";
import { TransferIcon } from "@/components/icons";

// Phase A3 (docs/roadmap-status.md savings roadmap): the single-line
// rendering for a merged internal-transfer pair (see
// lib/transactions/group-transfer-pairs.ts) - same layout/spacing as
// transaction-row.tsx (icon circle, two-line text block, amount on the
// trailing edge) so a transfer sits visually consistent inside the same
// list, but with none of that component's category/enrichment/suggested-
// category machinery, none of which applies to a transfer. The amount is
// deliberately neutral (text-foreground, no +/- sign) rather than
// success/warning-colored like a real income/expense row - a transfer
// isn't real income or a real expense, so coloring it either way would
// misrepresent it the same way counting it in monthIncome/monthExpense
// would (see lib/data/dashboard.ts's own comment on excluding transfers).
interface TransferRowProps {
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  date: Date;
}

export function TransferRow({ fromAccountName, toAccountName, amount, date }: TransferRowProps) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
        <TransferIcon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          از {fromAccountName} به {toAccountName}
        </p>
        <p className="text-xs text-muted">
          انتقال · {formatJalaaliDateShort(date)}
        </p>
      </div>
      <p className="shrink-0 text-sm font-semibold tabular-fa text-foreground">{formatToman(amount)}</p>
    </div>
  );
}
