import { formatDecimal } from "@/lib/format";

// Opt-in dashboard line (app/app/settings/page.tsx's toggle,
// User.showBalanceInAssets) showing the total balance converted into
// equivalent grams of 18k gold / USD, using the same live prices as the
// Assets feature. Only rendered by app/app/page.tsx when both values are
// non-null (the toggle is on AND a live price was actually available).
export function BalanceInAssets({ goldGrams, usd }: { goldGrams: number; usd: number }) {
  return (
    <p className="text-xs text-muted">
      معادل{" "}
      <span className="tabular-fa font-medium text-foreground">{formatDecimal(goldGrams)} گرم طلا</span>
      {" "}و{" "}
      <span className="tabular-fa font-medium text-foreground">{formatDecimal(usd)} دلار</span>
    </p>
  );
}
