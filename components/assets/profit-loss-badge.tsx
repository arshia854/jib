import { formatNumber } from "@/lib/format";

// Shared by assets-manager.tsx's per-asset list rows and
// assets-profit-loss-chart.tsx's bar rows - a higher value is the good
// outcome here (asset appreciated), the flip of e.g.
// components/reports/CategoryComparisonBar.tsx's expense-comparison badge
// where a decrease is the good outcome.
export function ProfitLossBadge({ toman, percent }: { toman: number; percent: number }) {
  const isProfit = toman >= 0;
  const tone = isProfit ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
  const sign = isProfit ? "+" : "−";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-fa ${tone}`}>
      {sign}
      {formatNumber(Math.abs(percent))}٪
    </span>
  );
}
