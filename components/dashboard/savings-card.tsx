import { PiggyBankIcon } from "@/components/icons";
import { formatToman } from "@/lib/format";

// Phase A3 (docs/roadmap-status.md savings roadmap). Same visual/structural
// shell as balance-card.tsx (gradient hero card, icon badge, big tabular-fa
// number) - deliberately not stat-card.tsx's smaller inline style, per this
// phase's own spec to follow BalanceCard's convention. Only the icon
// (PiggyBankIcon, not WalletIcon) and label differ, so the two hero cards
// read as siblings rather than duplicates at a glance.
//
// No month-over-month comparison: balance-card.tsx itself has no such
// figure for total balance (getDashboardData computes monthIncome/
// monthExpense, not a prior-month *balance* to diff against) - there is no
// existing pattern to reuse here, and this phase's own instructions say not
// to invent a new metric un-asked, so this only ever shows the current sum.
export function SavingsCard({ balance }: { balance: number }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-neutral-900 to-black p-6 text-white shadow-[0_20px_50px_-12px_rgba(255,212,0,0.3)] ring-1 ring-white/10">
      <div className="pointer-events-none absolute -left-10 -top-16 h-40 w-40 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <p className="text-sm text-white/70">پس‌انداز</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary">
          <PiggyBankIcon className="h-4 w-4" />
        </div>
      </div>
      <p className="relative mt-2 text-4xl font-black tabular-fa">{formatToman(balance)}</p>
    </div>
  );
}
