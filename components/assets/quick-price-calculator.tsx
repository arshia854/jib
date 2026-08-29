"use client";

import { useState } from "react";
import { CalculatorIcon } from "@/components/icons";
import { formatNumber, formatDecimal } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";
import type { TickerEntry } from "./live-price-ticker";

// "محاسبه‌گر سریع" - the honest, data-only version of a reference gold
// app's quick-purchase calculator: تومان in, quantity out, using today's
// live price per unit for whichever asset type is selected. Scoped to the
// same entries LivePriceTicker shows (types the user already holds with a
// known current price) rather than fetching a second, wider price source -
// see assets-manager.tsx's deriveTickerEntries. Purely a read-only "what
// would this amount be worth" preview; it doesn't create or prefill an
// asset (that flow already exists via the "افزودن دارایی" form's own live
// price prefill).
export function QuickPriceCalculator({ entries }: { entries: TickerEntry[] }) {
  const [selectedType, setSelectedType] = useState(entries[0]?.type);
  const [amountDigits, setAmountDigits] = useState("");

  if (entries.length === 0) return null;

  const selected = entries.find((e) => e.type === selectedType) ?? entries[0];
  const amount = Number(amountDigits);
  const hasAmount = amountDigits !== "" && Number.isFinite(amount) && amount > 0;
  const resultQuantity = hasAmount ? amount / selected.pricePerUnit : null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-bg text-primary-darker">
          <CalculatorIcon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-bold text-foreground">محاسبه‌گر سریع</p>
          <p className="text-xs text-muted">ببینید هر مبلغ به قیمت لحظه‌ای چقدر می‌شود</p>
        </div>
      </div>

      {entries.length > 1 && (
        <div className="mt-3 flex gap-2">
          {entries.map((entry) => (
            <button
              key={entry.type}
              type="button"
              onClick={() => setSelectedType(entry.type)}
              className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium ${
                selected.type === entry.type ? "bg-primary text-on-primary" : "bg-background text-muted"
              }`}
            >
              <span>{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>
      )}

      <label className="mt-4 block text-xs text-muted">مبلغ (تومان)</label>
      <input
        type="text"
        inputMode="numeric"
        value={amountDigits ? formatNumber(Number(amountDigits)) : ""}
        onChange={(e) => setAmountDigits(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
        placeholder="مثلاً ۵۰۰,۰۰۰"
        className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent"
      />

      <div className="mt-3 rounded-xl bg-primary-bg p-3 text-center">
        {resultQuantity !== null ? (
          <p className="text-lg font-bold tabular-fa text-primary-darker">
            {formatDecimal(resultQuantity, 6)} {selected.unitLabel}
          </p>
        ) : (
          <p className="text-xs text-muted">مبلغ را وارد کنید</p>
        )}
      </div>
    </div>
  );
}
