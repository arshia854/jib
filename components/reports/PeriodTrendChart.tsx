import type { TrendPeriod } from "@/lib/reports/trend-insights";
import type { ReportGranularity } from "@/lib/reports/period-range";
import { formatToman } from "@/lib/format";

interface PeriodTrendChartProps {
  periods: TrendPeriod[]; // oldest-first, as returned by getPeriodTrend
  granularity: ReportGranularity;
}

// Chart drawn in a fixed internal coordinate space, then scaled to the
// container's actual width via viewBox (same technique as any responsive
// SVG chart - no ResizeObserver/JS measuring needed).
const CHART_WIDTH = 320;
const CHART_HEIGHT = 132;
const LABEL_AREA_HEIGHT = 36; // reserved for the x-axis labels below the bars
const BAR_GAP_RATIO = 0.35; // fraction of each period's slot left empty as inter-bar gap

// Net can go either way (a deficit period is a real, common case), unlike income/expense which
// are both always >= 0 - so a single net bar per period was chosen over paired income/expense
// bars: it directly answers "did I save or overspend this period", the same question
// generateHighlights' savings/warning candidates are built around, without needing the reader to
// mentally subtract two bars against each other. It also reuses the same success/warning color
// semantics already used elsewhere in this file's siblings (CategoryComparisonBar's percent
// badges, HighlightCard) instead of introducing a third color for "income".
function barColor(net: number): string {
  return net >= 0 ? "var(--success)" : "var(--warning)";
}

// Week ("هفته ۵ - ۱۴۰۴") and month ("مرداد ۱۴۰۴") labels run long enough that, laid out
// horizontally under 6 narrow bars, neighboring labels would overlap - rotated, they fit in the
// same reserved label height. Year labels ("۱۴۰۴") are short enough to stay flat and centered,
// which also reads more naturally for the "fewer, wider bars" case the task calls out.
const ROTATE_LABEL: Record<ReportGranularity, boolean> = { week: true, month: true, year: false };
const LABEL_ROTATION_DEGREES = -40;

// Only meaningful for the rotated (week/month) labels - year labels are already short enough on
// their own that they never need it.
const LABEL_MAX_CHARS: Record<ReportGranularity, number> = { week: 11, month: 11, year: Infinity };

function truncateLabel(label: string, granularity: ReportGranularity): string {
  const max = LABEL_MAX_CHARS[granularity];
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/**
 * Grouped bar chart of TrendPeriod.net per period, raw SVG (no chart library installed - see
 * package.json). Bars share one scale across the whole series so periods are comparable, and
 * a horizontal zero-baseline is always drawn since net can be negative.
 */
export function PeriodTrendChart({ periods, granularity }: PeriodTrendChartProps) {
  if (periods.length === 0) return null;

  const maxAbsNet = Math.max(...periods.map((p) => Math.abs(p.net)), 1);
  const hasNegative = periods.some((p) => p.net < 0);
  const plotHeight = CHART_HEIGHT - LABEL_AREA_HEIGHT;
  // When every period is non-negative the baseline sits at the floor (an ordinary bar chart);
  // once any period dips below zero it moves to the middle so bars can extend both directions.
  const baselineY = hasNegative ? plotHeight / 2 : plotHeight;
  const maxBarHeight = hasNegative ? plotHeight / 2 : plotHeight;

  const slotWidth = CHART_WIDTH / periods.length;
  const barWidth = slotWidth * (1 - BAR_GAP_RATIO);
  const rotate = ROTATE_LABEL[granularity];

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <span className="text-sm font-semibold text-foreground">روند خالص دوره‌ای</span>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="mt-3 h-36 w-full"
        role="img"
        aria-label={`نمودار خالص درآمد و هزینه ${periods.length} دوره اخیر`}
      >
        <line x1={0} y1={baselineY} x2={CHART_WIDTH} y2={baselineY} style={{ stroke: "var(--border)" }} strokeWidth={1} />

        {periods.map((period, i) => {
          const barHeight = Math.max((Math.abs(period.net) / maxAbsNet) * maxBarHeight, 1);
          const x = i * slotWidth + (slotWidth - barWidth) / 2;
          const y = period.net >= 0 ? baselineY - barHeight : baselineY;
          const labelX = x + barWidth / 2;
          const labelY = CHART_HEIGHT - LABEL_AREA_HEIGHT + 14;

          return (
            <g key={period.periodKey}>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx={2} style={{ fill: barColor(period.net) }}>
                <title>{`${period.label}: ${formatToman(period.net)}`}</title>
              </rect>
              <text
                x={labelX}
                y={labelY}
                fontSize={8}
                style={{ fill: "var(--muted)" }}
                textAnchor={rotate ? "end" : "middle"}
                transform={rotate ? `rotate(${LABEL_ROTATION_DEGREES} ${labelX} ${labelY})` : undefined}
              >
                {truncateLabel(period.label, granularity)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
