import { getAssetTypeIcon, getAssetTypeLabel } from "@/lib/assets";
import { ProfitLossBadge } from "./profit-loss-badge";

interface Asset {
  id: number;
  type: string;
  name: string | null;
  profitLossPercent: number | null;
  profitLossToman: number | null;
}

// Per-asset horizontal bar chart of profit/loss percent (not a time series -
// the DB only ever holds the *current* live price, see
// lib/prices/get-live-prices.ts's own comment on LivePriceCache, so there's
// no history to plot a trend line from). Bars share one zero-anchored scale
// sized to the largest mover, colored by sign, ranked biggest-gain-first.
// Assets with no known current price (priceUnavailable) are omitted, same as
// the summary card above. Icon chips restyled to match the redesigned
// holdings list's `h-9 w-9 rounded-full bg-background` treatment instead of
// a bare emoji, for visual consistency across the page.
export function AssetsProfitLossChart({ assets }: { assets: Asset[] }) {
  const priced = assets.filter(
    (a): a is Asset & { profitLossPercent: number; profitLossToman: number } =>
      a.profitLossPercent !== null && a.profitLossToman !== null
  );
  if (priced.length === 0) return null;

  const sorted = [...priced].sort((a, b) => b.profitLossPercent - a.profitLossPercent);
  const maxAbsPercent = Math.max(...sorted.map((a) => Math.abs(a.profitLossPercent)), 1);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-sm font-bold text-foreground">سود و زیان دارایی‌ها</p>
      <p className="mt-0.5 text-xs text-muted">درصد تغییر نسبت به قیمت خرید هر دارایی</p>
      <div className="mt-4 space-y-4">
        {sorted.map((asset) => {
          const isProfit = asset.profitLossPercent >= 0;
          const barWidth =
            asset.profitLossPercent === 0 ? 0 : Math.max((Math.abs(asset.profitLossPercent) / maxAbsPercent) * 100, 4);
          return (
            <div key={asset.id} className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background text-sm">
                {getAssetTypeIcon(asset.type)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted">
                    {asset.type === "custom" ? asset.name : getAssetTypeLabel(asset.type)}
                  </span>
                  <ProfitLossBadge toman={asset.profitLossToman} percent={asset.profitLossPercent} />
                </div>
                <div className="mt-1.5 h-2 min-w-0 overflow-hidden rounded-full bg-border/60">
                  <div
                    className={`h-full rounded-full ${isProfit ? "bg-success" : "bg-warning"}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
