import { WalletIcon } from "@/components/icons";
import { formatToman } from "@/lib/format";

export function BalanceCard({ balance }: { balance: number }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-6 text-white shadow-[0_20px_50px_-12px_rgba(255,212,0,0.3)] ring-1 ring-white/10">
      <div className="pointer-events-none absolute -left-10 -top-16 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <p className="text-sm text-white/70">موجودی کل</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary">
          <WalletIcon className="h-4 w-4" />
        </div>
      </div>
      <p className="relative mt-2 text-4xl font-black tabular-fa">{formatToman(balance)}</p>
    </div>
  );
}
