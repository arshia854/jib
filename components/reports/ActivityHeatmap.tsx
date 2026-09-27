import type { ReactNode } from "react";
import { toJalaali } from "jalaali-js";
import type { ActivityHeatmapResult } from "@/lib/data/activity-heatmap";
import { formatJalaaliDate, formatNumber, jalaaliMonthKeyToLabel } from "@/lib/format";
import { ZapIcon, SparklesIcon, ChartIcon } from "@/components/icons";

interface ActivityHeatmapProps {
  heatmap: ActivityHeatmapResult;
}

const HEATMAP_WEEKS = 53; // matches getActivityHeatmap's own 371-day (53-week) window

// شنبه..جمعه (Saturday-start), matching lib/reports/period-range.ts's own
// week convention and the row order buildWeeks() below produces.
const WEEKDAY_LABELS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

// 0 = Saturday ... 6 = Friday. Gregorian and Jalali share the same 7-day
// week cycle, so this is plain weekday arithmetic off the native
// (Sunday-based) getDay() - no jalaali-js needed just for this.
function saturdayIndex(date: Date): number {
  return (date.getDay() + 1) % 7;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Independent re-implementation of lib/data/activity-heatmap.ts's private
// toDayKey() - same "prove it lines up independently" precedent as that
// module's own test file (lib/data/activity-heatmap.test.ts).
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

interface HeatmapCell {
  date: Date;
  count: number;
}

/**
 * HEATMAP_WEEKS full Saturday-start weeks ending with the week containing
 * today. Anchored on today rather than on heatmap.days' own key range, so
 * the grid is always a clean 53x7 - a few cells at each edge can fall
 * outside getActivityHeatmap()'s own 371-day fetch window whenever today
 * isn't exactly a Friday, but those just render as ordinary empty cells
 * (`days` has no entry for them either way), same as any other zero-
 * transaction day.
 */
function buildWeeks(days: Map<string, number>): HeatmapCell[][] {
  const today = new Date();
  const currentWeekStart = addDays(today, -saturdayIndex(today));
  const gridStart = addDays(currentWeekStart, -7 * (HEATMAP_WEEKS - 1));

  const weeks: HeatmapCell[][] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: HeatmapCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      week.push({ date, count: days.get(dayKey(date)) ?? 0 });
    }
    weeks.push(week);
  }
  return weeks;
}

// 4-5 shading steps via bg-primary at increasing opacity - the same
// opacity-modified-token mechanism this codebase already uses for tone
// (e.g. components/reports/CategoryComparisonBar.tsx's badges,
// components/assets/assets-hero-card.tsx's glow), not a new color system.
function intensityClass(count: number): string {
  if (count === 0) return "bg-border/40";
  if (count === 1) return "bg-primary/30";
  if (count === 2) return "bg-primary/55";
  if (count === 3) return "bg-primary/80";
  return "bg-primary";
}

// Jalali month name for the week column that contains a month's 1st day,
// so the grid gets GitHub-style month markers along its top edge. Weeks
// without a 1st get no label - one label per month, never per column.
function monthStartLabel(week: HeatmapCell[]): string | null {
  for (const cell of week) {
    const { jy, jm, jd } = toJalaali(cell.date);
    if (jd === 1) return jalaaliMonthKeyToLabel(`${jy}-${String(jm).padStart(2, "0")}`);
  }
  return null;
}

// One column of the stats strip at the top of the card - value first (the
// thing worth reading), label under it. Condensed from the home page's
// icon-circle + label + value pattern (components/dashboard/month-summary-card.tsx)
// into an inline row, since this strip is secondary to the tabs/list below
// and shouldn't take that pattern's full height three times over.
function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "primary" | "success" | "muted";
  icon: ReactNode;
}) {
  const toneClasses =
    tone === "primary" ? "bg-primary/15 text-primary-soft" : tone === "success" ? "bg-success/15 text-success" : "bg-muted/15 text-muted";
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 px-2 text-center">
      <span className="flex items-center gap-1.5">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${toneClasses}`}>{icon}</span>
        <span className="text-lg font-bold leading-none text-foreground">{value}</span>
      </span>
      <span className="truncate text-[11px] text-muted">{label}</span>
    </div>
  );
}

export function ActivityHeatmap({ heatmap }: ActivityHeatmapProps) {
  const weeks = buildWeeks(heatmap.days);

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="grid grid-cols-3 divide-x divide-border py-3.5">
        <Stat label="استریک فعلی" value={formatNumber(heatmap.currentStreak)} tone="primary" icon={<ZapIcon className="h-3.5 w-3.5" />} />
        <Stat label="بهترین استریک" value={formatNumber(heatmap.longestStreak)} tone="success" icon={<SparklesIcon className="h-3.5 w-3.5" />} />
        <Stat label="روزهای فعال" value={formatNumber(heatmap.activeDays)} tone="muted" icon={<ChartIcon className="h-3.5 w-3.5" />} />
      </div>

      <div className="flex gap-2 border-t border-border py-3 ps-3 pe-2">
        {/* Weekday labels sit outside the scroller, on the right: the
            scroller opens scrolled to its newest (right-hand) end, so labels
            placed inside it on the left - as they used to be - started out
            off-screen. The h-4 spacer lines them up under the month row. */}
        <div aria-hidden="true" className="flex shrink-0 flex-col gap-[3px]">
          <span className="h-4" />
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className="flex h-3 w-3 items-center justify-center text-[9px] leading-none text-muted">
              {i % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>

        {/* Left-edge fade hints that older weeks continue past the edge. */}
        <div className="min-w-0 flex-1 overflow-x-auto mask-l-from-85% [scrollbar-width:none]">
          {/* Chronological (oldest -> newest, left -> right) grid, same "LTR
              island inside an RTL page" technique already used for OTP
              digits/phone numbers (see components/auth/verify-form.tsx,
              login-form.tsx) - a mirrored calendar would read backwards. */}
          <div dir="ltr" className="flex w-max gap-[3px]">
            {weeks.map((week, wi) => {
              const monthLabel = monthStartLabel(week);
              // A label hangs rightward off its column, which would push past the
              // grid's newest (right) edge - where an RTL scroller can't reach -
              // for a month starting in the last few weeks; anchor those leftward.
              const anchor = wi >= weeks.length - 3 ? "right-0" : "left-0";
              return (
                <div key={wi} className="flex flex-col gap-[3px]">
                  <span className="relative h-4">
                    {monthLabel && (
                      <span dir="rtl" className={`absolute top-0 whitespace-nowrap text-[10px] leading-none text-muted ${anchor}`}>
                        {monthLabel}
                      </span>
                    )}
                  </span>
                  {week.map((cell, di) => (
                    <div
                      key={di}
                      title={`${formatJalaaliDate(cell.date)} - ${cell.count > 0 ? `${formatNumber(cell.count)} تراکنش` : "بدون تراکنش"}`}
                      className={`h-3 w-3 rounded-[3px] ${intensityClass(cell.count)}`}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
