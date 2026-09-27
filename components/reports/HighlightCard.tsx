import type { Highlight } from "@/lib/reports/generate-highlights";
import { CheckIcon, AlertIcon, ShieldIcon } from "@/components/icons";

interface HighlightCardProps {
  highlight: Highlight;
}

// Tone lives in the icon tile, the border and a soft wash behind the icon - never in the message
// text itself, which stays text-foreground so a paragraph of Persian stays easy to read. The icon
// shape (check / triangle / shield) carries the same distinction for anyone who can't rely on the
// green/red. "info" (essential-cost movement) intentionally gets a neutral/muted card, not the
// warning card's red/amber tone - it's a necessary cost that grew, not something to act on. Same
// bg-border/text-muted pairing CategoryComparisonBar already uses for its own neutral state.
const TONE = {
  positive: { card: "border-success/25", wash: "from-success/12", tile: "bg-success/15 text-success", Icon: CheckIcon },
  warning: { card: "border-warning/25", wash: "from-warning/12", tile: "bg-warning/15 text-warning", Icon: AlertIcon },
  info: { card: "border-border", wash: "from-border/40", tile: "bg-border/50 text-muted", Icon: ShieldIcon },
} as const;

export function HighlightCard({ highlight }: HighlightCardProps) {
  const { card, wash, tile, Icon } = TONE[highlight.type];

  return (
    <div className={`relative flex items-start gap-3 overflow-hidden rounded-2xl border bg-surface p-4 ${card}`}>
      {/* bg-linear-to-l in an RTL layout starts at the right - behind the icon - and fades out
          toward the text. */}
      <div aria-hidden="true" className={`pointer-events-none absolute inset-0 bg-linear-to-l ${wash} to-transparent to-55%`} />
      <div className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tile}`}>
        <Icon className="h-4.5 w-4.5" strokeWidth={2} />
      </div>
      <p className="relative self-center text-sm leading-relaxed text-foreground">{highlight.message}</p>
    </div>
  );
}
