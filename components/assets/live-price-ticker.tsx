import { formatToman } from "@/lib/format";

export interface TickerEntry {
  type: string;
  label: string;
  icon: string;
  unitLabel: string;
  pricePerUnit: number;
}

// Horizontally-scrolling row of "current price per unit" tiles for whichever
// live-priced asset types (طلا/دلار/بیت‌کوین) the user actually holds -
// see assets-manager.tsx's deriveTickerEntries for how pricePerUnit is
// read back out of listAssetsWithValue's already-computed currentValue
// (no separate fetch). Intentionally scoped to the user's own holdings, not
// a general market ticker - this is the دارایی‌های من page, not a market
// data page. Deliberately has no chart/trend line: a reference gold app's
// price section paired this with a live line chart, but LivePriceCache
// (prisma/schema.prisma) only ever holds today's single overwritten price,
// so there's no real history here to plot - showing one would mean making
// up data.
export function LivePriceTicker({ entries }: { entries: TickerEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-xs text-muted">قیمت لحظه‌ای دارایی‌های شما</p>
      <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => (
          <div
            key={entry.type}
            className="min-w-[9.5rem] shrink-0 rounded-2xl border border-border bg-surface p-3.5"
          >
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span className="text-sm">{entry.icon}</span>
              {entry.label}
            </div>
            <p className="mt-2 text-sm font-bold tabular-fa text-foreground">{formatToman(entry.pricePerUnit)}</p>
            <div className="mt-1.5 flex items-center gap-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              <span className="text-[10px] text-muted">لحظه‌ای · هر {entry.unitLabel}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
