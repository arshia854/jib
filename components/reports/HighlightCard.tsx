import type { Highlight } from "@/lib/reports/generate-highlights";
import { CheckIcon, AlertIcon, ShieldIcon } from "@/components/icons";

interface HighlightCardProps {
  highlight: Highlight;
}

// "info" (essential-cost movement) intentionally gets a neutral/muted card, not the warning
// card's red/amber tone - it's a necessary cost that grew, not something to act on. Same
// bg-border/text-muted pairing CategoryComparisonBar already uses for its own neutral state.
const TONE = {
  positive: { card: "border-success/20 bg-success/10", badge: "bg-success/15 text-success", text: "text-success", Icon: CheckIcon },
  warning: { card: "border-warning/20 bg-warning/10", badge: "bg-warning/15 text-warning", text: "text-warning", Icon: AlertIcon },
  info: { card: "border-border bg-border/10", badge: "bg-border/40 text-muted", text: "text-muted", Icon: ShieldIcon },
} as const;

export function HighlightCard({ highlight }: HighlightCardProps) {
  const { card, badge, text, Icon } = TONE[highlight.type];

  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${card}`}>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${badge}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className={`mt-1 text-sm leading-relaxed ${text}`}>{highlight.message}</p>
    </div>
  );
}
