import { WalletIcon, ArrowUpIcon, ArrowDownIcon } from "@/components/icons";
import { formatToman, formatNumber, formatDecimal } from "@/lib/format";

export interface AllocationSlice {
  type: string;
  label: string;
  value: number;
}

// One fixed color per asset *type* (never per rank), so a type keeps its
// color no matter which other types the user holds or how they're ordered.
// This card is always dark (see below), so only dark-surface steps are
// needed. Gold/usd/bitcoin were checked as a set with the dataviz skill's
// palette validator (all-pairs, since which types sit next to each other
// depends on what the user holds): colorblind-safe and within the lightness
// band against the card's near-black surface. "custom" is the neutral gray
// that an "other" bucket conventionally gets, not a fourth hue - no fourth
// hue cleared those all-pairs checks.
const ALLOCATION_COLOR: Record<string, string> = {
  gold: "#c98500",
  usd: "#3987e5",
  bitcoin: "#d55181",
  custom: "#8a8a85",
};

interface AssetsHeroCardProps {
  totalValue: number;
  totalCostBasis: number;
  totalProfitLossToman: number;
  totalProfitLossPercent: number | null;
  // Per-type share of totalValue, largest first. Same `currentValue ??
  // costBasis` fallback as listAssetsWithValue's own totalValue, so slices
  // always add up to the headline number.
  allocation: AllocationSlice[];
  priceStale: boolean;
  // AssetsSummary.priceUnavailable: live-priced lots are counted at cost
  // basis in totalValue, so the P/L figures would read as a confident "۰٪"
  // when the truth is "unknown" - shown as نامشخص instead.
  priceUnavailable: boolean;
}

// Whole-percent legend labels that always add up to exactly 100 (largest
// remainder method) - plain per-slice rounding can show e.g. ۴۹+۲۵+۲۰+۷ =
// ۱۰۱٪. Returns null for a slice that's non-zero but rounds to 0, which the
// legend shows as "<۱٪" instead of a misleading "۰٪".
function wholePercentShares(values: number[], total: number): (number | null)[] {
  const exact = values.map((v) => (v / total) * 100);
  const floored = exact.map(Math.floor);
  let remaining = 100 - floored.reduce((sum, p) => sum + p, 0);
  const byRemainder = exact.map((p, i) => ({ i, remainder: p - floored[i] })).sort((a, b) => b.remainder - a.remainder);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    floored[i] += 1;
    remaining -= 1;
  }
  return floored.map((p, i) => (p === 0 && values[i] > 0 ? null : p));
}

// Portfolio-total hero card for the دارایی‌ها (Assets) tab. Shares the
// black-canvas treatment of components/dashboard/balance-card.tsx (same
// gradient + soft glow), with the wallet-icon badge as the one solid-yellow
// accent. The number and "تومان" are split so the headline no longer wraps
// onto two lines at phone width. Cost basis and lifetime P/L sit side by
// side as two stats instead of a caption plus a parenthesized pill.
// Still no "today" framing: totalProfitLossToman/Percent is lifetime P/L vs
// cost basis - LivePriceCache (prisma/schema.prisma) is a single overwritten
// row, so there's no day-over-day history to honestly claim a daily change
// from.
export function AssetsHeroCard({
  totalValue,
  totalCostBasis,
  totalProfitLossToman,
  totalProfitLossPercent,
  allocation,
  priceStale,
  priceUnavailable,
}: AssetsHeroCardProps) {
  const isProfit = totalProfitLossToman >= 0;
  const allocationTotal = allocation.reduce((sum, slice) => sum + slice.value, 0);
  const shares =
    allocationTotal > 0
      ? wholePercentShares(
          allocation.map((slice) => slice.value),
          allocationTotal
        )
      : [];

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-5 text-white shadow-lg shadow-black/40">
      <div className="pointer-events-none absolute -left-10 -top-16 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-14 -right-6 h-32 w-32 rounded-full bg-primary/10 blur-3xl" />

      <div className="relative flex items-center justify-between">
        <p className="text-sm text-white/70">ارزش کل دارایی‌ها</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary">
          <WalletIcon className="h-4 w-4" />
        </div>
      </div>

      <p className="relative mt-1 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[2rem] font-extrabold leading-tight tabular-fa">{formatNumber(totalValue)}</span>
        <span className="text-sm font-medium text-white/60">تومان</span>
      </p>

      <div className="relative mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {totalProfitLossPercent !== null && !priceUnavailable && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-fa ${
              isProfit ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
            }`}
          >
            {isProfit ? <ArrowUpIcon className="h-3 w-3" /> : <ArrowDownIcon className="h-3 w-3" />}
            {formatDecimal(Math.abs(totalProfitLossPercent), 1)}٪ {isProfit ? "سود" : "زیان"}
          </span>
        )}
        {priceStale && <span className="text-[11px] text-white/50">قیمت‌ها ممکن است کاملاً به‌روز نباشند</span>}
      </div>

      {totalCostBasis > 0 && (
        <dl className="relative mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4">
          <div>
            <dt className="text-[11px] text-white/50">سرمایه اولیه</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-fa">{formatToman(totalCostBasis)}</dd>
          </div>
          {priceUnavailable ? (
            <div>
              <dt className="text-[11px] text-white/50">سود / زیان کل</dt>
              <dd className="mt-0.5 text-sm font-semibold text-white/60">نامشخص</dd>
            </div>
          ) : (
            <div>
              <dt className="text-[11px] text-white/50">{isProfit ? "سود کل" : "زیان کل"}</dt>
              <dd className={`mt-0.5 text-sm font-semibold tabular-fa ${isProfit ? "text-success" : "text-warning"}`}>
                {formatToman(Math.abs(totalProfitLossToman))}
              </dd>
            </div>
          )}
        </dl>
      )}

      {allocation.length >= 2 && allocationTotal > 0 && (
        <div className="relative mt-4">
          <p className="text-[11px] text-white/50">ترکیب سبد</p>
          {/* Part-to-whole stacked bar: 2px gaps between segments, rounded
              only at the two outer ends (the overflow-hidden track). The
              legend below always names every slice, so identity never rests
              on color alone. */}
          <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {allocation.map((slice) => (
              <div
                key={slice.type}
                title={`${slice.label}: ${formatToman(slice.value)}`}
                className="h-full"
                style={{
                  width: `${(slice.value / allocationTotal) * 100}%`,
                  backgroundColor: ALLOCATION_COLOR[slice.type] ?? ALLOCATION_COLOR.custom,
                }}
              />
            ))}
          </div>
          <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {allocation.map((slice, i) => {
              const share = shares[i];
              return (
                <li key={slice.type} className="flex items-center gap-1.5 text-xs text-white/70">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: ALLOCATION_COLOR[slice.type] ?? ALLOCATION_COLOR.custom }}
                  />
                  {slice.label}
                  <span className="font-semibold tabular-fa text-white">
                    {share === null ? "<۱" : formatNumber(share)}٪
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
