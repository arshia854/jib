"use client";

import { useState } from "react";
import { CalculatorIcon } from "@/components/icons";
import { formatNumber, formatDecimal } from "@/lib/format";
import { AmountInput } from "@/components/ui/amount-input";

export interface TickerEntry {
  type: string;
  label: string;
  icon: string;
  unitLabel: string;
  pricePerUnit: number;
}

// Today's price per unit for whichever live-priced types (طلا/دلار/بیت‌کوین)
// the user actually holds, plus a "what does this amount buy" calculator -
// one card instead of the old separate LivePriceTicker + QuickPriceCalculator,
// which showed the same entries twice (once as tiles, once as selector
// chips). The price tiles *are* the calculator's selector now.
//
// Entries come from assets-manager.tsx's deriveTickerEntries (read back out
// of listAssetsWithValue's already-computed currentValue, no second fetch),
// so this stays scoped to the user's own holdings rather than being a
// general market ticker. Deliberately no trend line: LivePriceCache
// (prisma/schema.prisma) only holds today's single overwritten price, so
// there's no real history to plot. `stale` swaps the pulsing "به‌روز" dot
// for an amber notice - a pulsing live indicator next to a price the server
// already flagged as possibly outdated would be a contradiction.
export function LivePricesCard({ entries, stale }: { entries: TickerEntry[]; stale: boolean }) {
  const [selectedType, setSelectedType] = useState(entries[0]?.type);
  const [amountDigits, setAmountDigits] = useState("");

  if (entries.length === 0) return null;

  const selected = entries.find((e) => e.type === selectedType) ?? entries[0];
  const amount = Number(amountDigits);
  const hasAmount = amountDigits !== "" && Number.isFinite(amount) && amount > 0;
  const resultQuantity = hasAmount ? amount / selected.pricePerUnit : null;

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-foreground">قیمت لحظه‌ای</h3>
        {stale ? (
          <span className="flex items-center gap-1.5 text-[11px] text-primary-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-primary-soft" />
            ممکن است به‌روز نباشد
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            به‌روز
          </span>
        )}
      </div>

      <div className="mt-3 grid auto-cols-[minmax(9.5rem,1fr)] grid-flow-col gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => {
          const active = entry.type === selected.type;
          return (
            <button
              key={entry.type}
              type="button"
              aria-pressed={active}
              onClick={() => setSelectedType(entry.type)}
              className={`rounded-xl border p-3 text-start transition-colors ${
                active ? "border-primary/60 bg-primary-bg" : "border-border bg-background"
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <span className="text-sm">{entry.icon}</span>
                {entry.label}
              </span>
              <span className="mt-1.5 block text-base font-bold tabular-fa text-foreground">
                {formatNumber(entry.pricePerUnit)}
              </span>
              <span className="block text-[11px] text-muted">تومان · هر {entry.unitLabel}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <label htmlFor="live-prices-calculator" className="flex items-center gap-1.5 text-xs text-muted">
          <CalculatorIcon className="h-3.5 w-3.5" />
          با این مبلغ چقدر {selected.label} می‌شود؟
        </label>
        <AmountInput
          id="live-prices-calculator"
          value={Number(amountDigits) || 0}
          onChange={(next) => setAmountDigits(next ? String(next) : "")}
          placeholder="مبلغ به تومان"
        />
        {resultQuantity !== null && (
          <p className="mt-2 text-sm text-muted">
            ≈{" "}
            <span className="font-bold tabular-fa text-foreground">{formatDecimal(resultQuantity, 6)}</span>{" "}
            {selected.unitLabel}
          </p>
        )}
      </div>
    </section>
  );
}
