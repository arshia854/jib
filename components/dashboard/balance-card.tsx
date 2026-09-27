import Link from "next/link";
import { WalletIcon, PiggyBankIcon, BackIcon } from "@/components/icons";
import { BalanceInAssets } from "@/components/dashboard/balance-in-assets";
import { formatNumber, formatToman } from "@/lib/format";

export function BalanceCard({
  balance,
  savingsBalance,
  assetEquivalent,
}: {
  balance: number;
  savingsBalance?: number;
  assetEquivalent?: { goldGrams: number; usd: number };
}) {
  const isNegative = balance < 0;
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-5 text-white shadow-[0_20px_50px_-12px_rgba(255,212,0,0.3)] ring-1 ring-white/10">
      <div className="pointer-events-none absolute -left-10 -top-16 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative flex items-center justify-between">
        {/* balance excludes savings (see lib/data/dashboard.ts's availableBalance),
            so once savings is shown next to it, "کل" would overstate it. */}
        <p className="text-sm text-white/70">{savingsBalance !== undefined ? "موجودی قابل خرج" : "موجودی کل"}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary">
          <WalletIcon className="h-4 w-4" />
        </div>
      </div>
      {/* Number and unit split so the unit can step down in size - at
          text-4xl the whole "... تومان" string crowded the card, and a
          negative balance's minus sign read as a dash between the two.
          dir="ltr" pins the minus to the digits. */}
      <p className="relative mt-1 flex flex-wrap items-baseline gap-x-2">
        <span dir="ltr" className={`text-4xl font-black tabular-fa ${isNegative ? "text-red-400" : ""}`}>
          {formatNumber(balance)}
        </span>
        <span className="text-base font-medium text-white/60">تومان</span>
      </p>
      {assetEquivalent && <BalanceInAssets goldGrams={assetEquivalent.goldGrams} usd={assetEquivalent.usd} />}

      {savingsBalance !== undefined && (
        <Link
          href="/app/transfer"
          className="relative mt-4 flex items-center justify-between rounded-xl bg-white/5 px-3 py-3 transition-colors hover:bg-white/10"
        >
          <span className="flex items-center gap-2">
            <PiggyBankIcon className="h-4 w-4 text-primary" />
            <span className="text-sm text-white/70">پس‌انداز</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-sm font-bold tabular-fa">{formatToman(savingsBalance)}</span>
            <BackIcon className="h-4 w-4 text-white/50" />
          </span>
        </Link>
      )}
    </div>
  );
}
