import type { NarrativeReport, NarrativeStatus } from "@/lib/reports/narrative-report";
import { formatToman, formatNumber } from "@/lib/format";
import { CheckIcon, AlertIcon, ShieldIcon, ChartIcon, SparklesIcon, TagIcon } from "@/components/icons";

interface NarrativeReportCardProps {
  report: NarrativeReport;
}

// Same tone-color mapping approach as HighlightCard's TONE (border/bg/badge/text per state) -
// "unknown" gets its own neutral entry rather than reusing "info"'s wording, since it's a
// "not enough data yet" state, not a judgment about spending.
const STATUS_TONE: Record<NarrativeStatus, { card: string; badge: string; text: string; label: string; Icon: typeof CheckIcon }> = {
  good: { card: "border-success/20 bg-success/10", badge: "bg-success/15 text-success", text: "text-success", label: "وضعیت خوب", Icon: CheckIcon },
  medium: { card: "border-warning/20 bg-warning/10", badge: "bg-warning/15 text-warning", text: "text-warning", label: "وضعیت متوسط", Icon: ShieldIcon },
  bad: { card: "border-warning/20 bg-warning/10", badge: "bg-warning/15 text-warning", text: "text-warning", label: "نیاز به توجه", Icon: AlertIcon },
  unknown: { card: "border-border bg-border/10", badge: "bg-border/40 text-muted", text: "text-muted", label: "داده ناکافی", Icon: ShieldIcon },
};

function TrendBadge({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const isDecrease = percent < 0;
  const isIncrease = percent > 0;
  const tone = isDecrease ? "bg-success/10 text-success" : isIncrease ? "bg-warning/10 text-warning" : "bg-border/50 text-muted";
  const sign = isIncrease ? "+" : isDecrease ? "−" : "";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-fa ${tone}`}>
      {sign}
      {formatNumber(Math.abs(percent))}٪
    </span>
  );
}

/**
 * One cohesive narrative card for the current week/month/year report period - status, headline
 * income/expense, top category, trend, and the deterministic insight/projection/suggestion/
 * opportunity from lib/reports/narrative-report.ts. Rendered at the top of the tab's content,
 * above everything from the trend chart/highlight cards. Every sub-block is optional and only
 * rendered when present on `report` - no placeholder text for an omitted field.
 */
export function NarrativeReportCard({ report }: NarrativeReportCardProps) {
  const tone = STATUS_TONE[report.status];

  return (
    <div className={`rounded-2xl border p-4 ${tone.card}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${tone.badge}`}>
          <tone.Icon className="h-3.5 w-3.5" />
          {tone.label}
        </span>
        <TrendBadge percent={report.overallTrendPercent} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{report.periodLabel}</span>
        <span className="text-xs text-muted">
          درآمد {formatToman(report.income)} · هزینه {formatToman(report.expense)}
          {report.savingsRate !== undefined && <> · پس‌انداز {formatNumber(report.savingsRate)}٪</>}
        </span>
      </div>

      {report.topCategory && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <TagIcon className="h-3.5 w-3.5 shrink-0" />
          بیشترین هزینه: «{report.topCategory.name}» ({formatToman(report.topCategory.amount)})
        </div>
      )}

      {report.insight && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-surface/60 p-2.5">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm leading-relaxed text-foreground">{report.insight.message}</p>
        </div>
      )}

      {report.projection && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-surface/60 p-2.5">
          <ChartIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-sm leading-relaxed text-foreground">{report.projection.message}</p>
        </div>
      )}

      {report.suggestion && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-surface/60 p-2.5">
          <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-sm leading-relaxed text-foreground">{report.suggestion.message}</p>
        </div>
      )}

      {report.opportunity && (
        <div className="mt-2 flex items-start gap-2 rounded-xl bg-surface/60 p-2.5">
          <SparklesIcon className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="text-sm leading-relaxed text-foreground">{report.opportunity.message}</p>
        </div>
      )}
    </div>
  );
}
