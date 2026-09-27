import type { TrendPeriod } from "@/lib/reports/trend-insights";
import type { ReportGranularity } from "@/lib/reports/period-range";
import { formatCompactToman, formatToman } from "@/lib/format";

interface PeriodTrendChartProps {
  periods: TrendPeriod[]; // oldest-first, as returned by getPeriodTrend
  // Kept as part of the component's contract (MonthlyComparisonReport passes it), but the layout no
  // longer depends on it: labels used to rotate/truncate per granularity, now they simply wrap.
  granularity: ReportGranularity;
}

// Pixel height shared by all bars (positive and negative together), plus the headroom each side of
// the zero line reserves for its value labels (a two-line number-over-unit label, see ValueLabel).
// The zero line sits wherever the data puts it: a series with one small deficit gets a short
// negative side, rather than always reserving half the plot for it.
const BAR_AREA_PX = 128;
const LABEL_HEADROOM_PX = 34;

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

// The chart is dir="ltr", which would put the number to the LEFT of its unit word ("هزار ۸۵۰" to a
// Persian reader). The label is dir="rtl" (number, then unit, like every other amount in the app),
// while the signed number stays an LTR isolate so the "−" sits directly left of the digits.
// Number over unit, on purpose, instead of letting "۱۲٫۳ میلیون" wrap wherever a narrow column
// happens to break it.
function ValueLabel({ net, current }: { net: number; current: boolean }) {
  const text = formatCompactToman(net);
  const unitStart = text.indexOf(" "); // formatCompactToman's suffix is " هزار" etc., or "" for plain numbers
  const number = unitStart === -1 ? text : text.slice(0, unitStart);
  const unit = unitStart === -1 ? "" : text.slice(unitStart);

  return (
    <span dir="rtl" data-testid="period-value-label" className="block shrink-0 py-1 text-center leading-tight tabular-fa">
      <bdi dir="ltr" className={`block text-[11px] font-semibold ${current ? "text-foreground" : "text-muted"}`}>
        {number}
      </bdi>
      {unit && <span className="block text-[9px] text-muted">{unit}</span>}
    </span>
  );
}

/**
 * Bar chart of TrendPeriod.net per period, plain HTML/CSS (no chart library, and no stretched SVG
 * so text is never distorted). Bars share one scale across the whole series so periods are
 * comparable, and a zero baseline is always drawn since net can be negative. The container is
 * dir="ltr" (same technique as ActivityHeatmap) so periods read oldest -> newest, left -> right.
 * The current (last) period gets a highlighted column and full-strength bar; earlier ones recede.
 */
export function PeriodTrendChart({ periods }: PeriodTrendChartProps) {
  if (periods.length === 0) return null;

  const maxPositive = Math.max(...periods.map((p) => p.net), 0);
  const maxNegative = Math.max(...periods.map((p) => -p.net), 0);
  const hasNegative = periods.some((p) => p.net < 0);
  const lastIndex = periods.length - 1;
  // One px-per-toman scale for the whole series: the tallest positive bar and the deepest negative
  // one together span BAR_AREA_PX, so each side of the zero line is only as tall as its data needs.
  const scaleTotal = Math.max(maxPositive + maxNegative, 1);
  // +2 leaves room for a zero-net period's 2px hairline bar under its label.
  const aboveHeight = LABEL_HEADROOM_PX + (maxPositive / scaleTotal) * BAR_AREA_PX + 2;
  const belowHeight = LABEL_HEADROOM_PX + (maxNegative / scaleTotal) * BAR_AREA_PX;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <span className="text-sm font-semibold text-foreground">روند پس‌انداز دوره‌ها</span>
      <p className="mt-0.5 text-xs text-muted">درآمد منهای هزینه‌ی هر دوره</p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-success" />
          پس‌انداز (درآمد بیشتر از هزینه)
        </span>
        {hasNegative && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-warning" />
            اضافه‌خرج (هزینه بیشتر از درآمد)
          </span>
        )}
      </div>

      <div dir="ltr" role="img" aria-label={`نمودار خالص درآمد و هزینه ${periods.length} دوره اخیر`} className="mt-4 flex">
        {periods.map((period, i) => {
          const isPositive = period.net >= 0;
          const isCurrent = i === lastIndex;
          // minHeight keeps a zero (or tiny) net visible as a hairline instead of vanishing.
          const bar = {
            height: (Math.abs(period.net) / scaleTotal) * BAR_AREA_PX,
            minHeight: 2,
            backgroundColor: barColor(period.net),
            opacity: isCurrent ? 1 : 0.7,
          };

          return (
            <div
              key={period.periodKey}
              title={[
                period.label,
                `درآمد: ${formatToman(period.income)}`,
                `هزینه: ${formatToman(period.expense)}`,
                `خالص: ${formatToman(period.net)}`,
              ].join("\n")}
              className={`flex min-w-0 flex-1 flex-col items-center pb-1.5 ${isCurrent ? "rounded-xl bg-border/25" : ""}`}
            >
              {/* No horizontal padding on the column itself, so every column's 1px border-b
                  touches its neighbours' and the zero line reads as one continuous rule. */}
              <div className="flex w-full flex-col items-center justify-end border-b border-border" style={{ height: aboveHeight }}>
                {isPositive && (
                  <>
                    <ValueLabel net={period.net} current={isCurrent} />
                    <div className="w-full max-w-6 shrink-0 rounded-t-[4px]" style={bar} />
                  </>
                )}
              </div>
              {hasNegative && (
                <div className="flex w-full flex-col items-center justify-start" style={{ height: belowHeight }}>
                  {!isPositive && (
                    <>
                      <div className="w-full max-w-6 shrink-0 rounded-b-[4px]" style={bar} />
                      <ValueLabel net={period.net} current={isCurrent} />
                    </>
                  )}
                </div>
              )}

              {/* dir="rtl" here only: the chart is ltr for period order, but a Persian phrase like
                  "مرداد ۱۴۰۴" would otherwise show its words in reversed reading order. */}
              <span
                dir="rtl"
                className={`mt-2 block px-0.5 text-center text-[10px] leading-tight ${isCurrent ? "font-semibold text-foreground" : "text-muted"}`}
              >
                {period.label}
              </span>
              {isCurrent && (
                <span dir="rtl" className="mt-1 rounded-full bg-primary-bg px-1.5 py-px text-center text-[10px] leading-tight text-primary-soft">
                  جاری
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
