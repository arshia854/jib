import { formatDecimal } from "@/lib/format";

// Opt-in line (app/app/settings/page.tsx's toggle, User.showBalanceInAssets)
// showing the balance converted into equivalent grams of 18k gold / USD,
// using the same live prices as the Assets feature. Rendered inside
// BalanceCard, under the amount it converts - hence the white-on-dark
// colors (that card stays dark in both themes) rather than theme tokens.
// app/app/page.tsx only passes it through when both values are non-null
// (the toggle is on AND a live price was actually available).
export function BalanceInAssets({ goldGrams, usd }: { goldGrams: number; usd: number }) {
  return (
    <p className="relative mt-1 text-xs text-white/60">
      معادل{" "}
      <span className="tabular-fa font-medium text-white/90">{formatDecimal(goldGrams)} گرم طلا</span>
      {" "}و{" "}
      <span className="tabular-fa font-medium text-white/90">{formatDecimal(usd)} دلار</span>
    </p>
  );
}
