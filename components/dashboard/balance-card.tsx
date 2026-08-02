import { formatToman } from "@/lib/format";

export function BalanceCard({ balance }: { balance: number }) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-primary-dark to-primary-dark p-6 text-white shadow-lg shadow-primary/20">
      <p className="text-sm text-white/70">موجودی کل</p>
      <p className="mt-2 text-3xl font-bold tabular-fa">{formatToman(balance)}</p>
    </div>
  );
}
