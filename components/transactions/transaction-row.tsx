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
  // The AI's brand-new-category proposal left standing on this transaction
  // by background enrichment (schema.prisma's own comment on
  // Transaction.suggestedCategoryName) - undefined/null for every other
  // transaction, same as enrichmentStatus above. All four are always set
  // together on a real row (see that column's own comment), so the banner
  // below gates on suggestedCategoryName alone.
  suggestedCategoryName?: string | null;
  suggestedCategoryIcon?: string | null;
  // Purely presentational, same as the rest of this component - the actual
  // fetch/loading/error state lives in transaction-list-item.tsx, which
  // owns handleDelete's equivalent state for the same reason.
  onAcceptSuggestedCategory?: () => void;
  onDismissSuggestedCategory?: () => void;
  isResolvingSuggestedCategory?: boolean;
  suggestedCategoryError?: string | null;
}

export function TransactionRow({
  description,
  rawInput,
  date,
  amount,
  type,
  category,
  enrichmentStatus,
  suggestedCategoryName,
  suggestedCategoryIcon,
  onAcceptSuggestedCategory,
  onDismissSuggestedCategory,
  isResolvingSuggestedCategory,
  suggestedCategoryError,
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
            نوع (درآمد/هزینه) و دسته‌بندی را بررسی کن
          </p>
        )}
        {/* Same visual pattern as add-transaction-form.tsx's own
            suggestedCategory/liveSuggestedCategory banners - "بسازمش؟" text,
            bg-accent/10 pill, primary "بساز" button - plus a dismiss (✕)
            action that flow has no equivalent for (there, just not clicking
            "بساز" is enough; here the row would otherwise show this banner
            forever). */}
        {suggestedCategoryName && (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-xl bg-accent/10 px-3 py-2">
            <p className="text-xs text-accent">
              دسته‌بندی «{suggestedCategoryIcon} {suggestedCategoryName}» براش پیدا نشد — می‌خوای بسازمش؟
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={onAcceptSuggestedCategory}
                disabled={isResolvingSuggestedCategory}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-50"
              >
                {isResolvingSuggestedCategory && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
                بساز
              </button>
              <button
                type="button"
                onClick={onDismissSuggestedCategory}
                disabled={isResolvingSuggestedCategory}
                aria-label="نادیده گرفتن پیشنهاد دسته‌بندی"
                className="rounded-lg border border-border px-2 py-1.5 text-xs text-muted disabled:opacity-50"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {suggestedCategoryError && <p className="mt-1 text-[11px] text-warning">{suggestedCategoryError}</p>}
      </div>
      <p className={`shrink-0 text-sm font-semibold tabular-fa ${isIncome ? "text-success" : "text-warning"}`}>
        {isIncome ? "+" : "−"} {formatToman(amount)}
      </p>
    </div>
  );
}
