import { formatToman, formatJalaaliDateShort } from "@/lib/format";
import { SpinnerIcon, AlertIcon } from "@/components/icons";

interface TransactionRowProps {
  description: string | null;
  rawInput: string;
  date: Date;
  amount: number;
  type: string;
  category: { name: string; icon: string; color: string };
  // Background AI-enrichment state for a "ثبت سریع" (quick submit)
  // transaction - see schema.prisma's own comment on
  // Transaction.enrichmentStatus. Undefined/null for every other
  // transaction, which renders exactly as before this prop existed.
  enrichmentStatus?: string | null;
}

export function TransactionRow({
  description,
  rawInput,
  date,
  amount,
  type,
  category,
  enrichmentStatus,
}: TransactionRowProps) {
  const isIncome = type === "income";
  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg"
        style={{ backgroundColor: `${category.color}1f` }}
      >
        {category.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{description || rawInput}</p>
        <p className="text-xs text-muted">
          {category.name} · {formatJalaaliDateShort(date)}
        </p>
        {enrichmentStatus === "pending" && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-accent">
            <SpinnerIcon className="h-3 w-3 animate-spin" />
            در حال تحلیل هوش مصنوعی...
          </p>
        )}
        {enrichmentStatus === "failed" && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-warning">
            <AlertIcon className="h-3 w-3" />
            دسته‌بندی را بررسی کن
          </p>
        )}
      </div>
      <p className={`shrink-0 text-sm font-semibold tabular-fa ${isIncome ? "text-success" : "text-warning"}`}>
        {isIncome ? "+" : "−"} {formatToman(amount)}
      </p>
    </div>
  );
}
