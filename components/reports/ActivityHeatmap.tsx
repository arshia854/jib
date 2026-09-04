import type { ReactNode } from "react";
import type { ActivityHeatmapResult } from "@/lib/data/activity-heatmap";
import { formatJalaaliDate, formatNumber } from "@/lib/format";
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

// Visually matches components/dashboard/stat-card.tsx's pattern (icon
// circle + label + value on a bordered surface card), just condensed
// (p-3 not p-4, smaller icon circle/text) to fit three across instead of
// stat-card.tsx's two, and not money (no formatToman) - so a local variant
// here rather than reusing that component as-is.
function StatPill({
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
    tone === "primary" ? "bg-primary/10 text-primary" : tone === "success" ? "bg-success/10 text-success" : "bg-muted/10 text-muted";
  return (
    <div className="flex-1 rounded-2xl border border-border bg-surface p-3">
      <div className={`flex h-8 w-8 items-center justify-center rounded-full ${toneClasses}`}>{icon}</div>
      <p className="mt-2 text-[11px] text-muted">{label}</p>
      <p className="mt-1 text-sm font-bold tabular-fa text-foreground">{value}</p>
    </div>
  );
}

export function ActivityHeatmap({ heatmap }: ActivityHeatmapProps) {
  const weeks = buildWeeks(heatmap.days);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <StatPill label="استریک فعلی" value={formatNumber(heatmap.currentStreak)} tone="primary" icon={<ZapIcon className="h-4 w-4" />} />
        <StatPill label="بهترین استریک" value={formatNumber(heatmap.longestStreak)} tone="success" icon={<SparklesIcon className="h-4 w-4" />} />
        <StatPill label="روزهای فعال" value={formatNumber(heatmap.activeDays)} tone="muted" icon={<ChartIcon className="h-4 w-4" />} />
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="overflow-x-auto">
          {/* Chronological (oldest -> newest, left -> right) grid, same "LTR
              island inside an RTL page" technique already used for OTP
              digits/phone numbers (see components/auth/verify-form.tsx,
              login-form.tsx) - a mirrored calendar would read backwards. */}
          <div dir="ltr" className="flex w-max gap-1">
            <div className="flex flex-col gap-1">
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i} className="flex h-2.5 w-4 items-center justify-center text-[9px] text-muted">
                  {i % 2 === 1 ? label : ""}
                </span>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-1">
                {week.map((cell, di) => (
                  <div
                    key={di}
                    title={`${formatJalaaliDate(cell.date)} - ${cell.count > 0 ? `${formatNumber(cell.count)} تراکنش` : "بدون تراکنش"}`}
                    className={`h-2.5 w-2.5 rounded-sm ${intensityClass(cell.count)}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
