import { WalletIcon, ArrowUpIcon, ArrowDownIcon } from "@/components/icons";
import { formatToman, formatNumber } from "@/lib/format";

interface AssetsHeroCardProps {
  totalValue: number;
  totalCostBasis: number;
  totalProfitLossToman: number;
  totalProfitLossPercent: number | null;
}

// Portfolio-total hero card for the دارایی‌ها (Assets) page - restyled after
// a reference gold-tracking app's balance card (richer gradient + a soft
// glow instead of the old flat from-x-to-x fill, directional arrow on the
// P/L pill, a cost-basis caption for context). Now shares the black-canvas
// treatment of components/dashboard/balance-card.tsx exactly (same gradient),
// with the wallet-icon badge as this card's one solid-yellow accent and the
// P/L pill tinted success/warning by direction. No "today" framing anywhere:
// totalProfitLossToman/Percent is lifetime P/L vs cost basis
// (lib/data/assets.ts's listAssetsWithValue) - there's no day-over-day price
// history in the schema (LivePriceCache is a single overwritten row, see
// prisma/schema.prisma) to honestly claim a daily change from.
export function AssetsHeroCard({ totalValue, totalCostBasis, totalProfitLossToman, totalProfitLossPercent }: AssetsHeroCardProps) {
  const isProfit = totalProfitLossToman >= 0;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-6 text-white shadow-lg shadow-black/40">
      <div className="pointer-events-none absolute -left-10 -top-16 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-14 -right-6 h-32 w-32 rounded-full bg-primary/10 blur-3xl" />

      <div className="relative flex items-center justify-between">
        <p className="text-sm text-white/70">ارزش کل دارایی‌ها</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary">
          <WalletIcon className="h-4 w-4" />
        </div>
      </div>

      <p className="relative mt-2 text-4xl font-extrabold tabular-fa">{formatToman(totalValue)}</p>

      {totalCostBasis > 0 && (
        <p className="relative mt-1 text-xs text-white/60">
          نسبت به <span className="tabular-fa">{formatToman(totalCostBasis)}</span> سرمایه اولیه
        </p>
      )}

      {totalProfitLossPercent !== null && (
        <span
          className={`relative mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-fa ${
            isProfit ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
          }`}
        >
          {isProfit ? <ArrowUpIcon className="h-3 w-3" /> : <ArrowDownIcon className="h-3 w-3" />}
          {formatToman(Math.abs(totalProfitLossToman))} ({formatNumber(Math.abs(totalProfitLossPercent))}٪)
        </span>
      )}
    </div>
  );
}
