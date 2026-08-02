import type { Highlight } from "@/lib/reports/generate-highlights";
import { CheckIcon, AlertIcon } from "@/components/icons";

interface HighlightCardProps {
  highlight: Highlight;
}

export function HighlightCard({ highlight }: HighlightCardProps) {
  const isPositive = highlight.type === "positive";

  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border p-4 ${
        isPositive ? "border-success/20 bg-success/10" : "border-warning/20 bg-warning/10"
      }`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isPositive ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
        }`}
      >
        {isPositive ? <CheckIcon className="h-4 w-4" /> : <AlertIcon className="h-4 w-4" />}
      </div>
      <p className={`mt-1 text-sm leading-relaxed ${isPositive ? "text-success" : "text-warning"}`}>
        {highlight.message}
      </p>
    </div>
  );
}
