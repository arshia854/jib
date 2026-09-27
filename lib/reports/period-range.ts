import { toGregorian, toJalaali, jalaaliWeek, MIN_JALAALI_YEAR, MAX_JALAALI_YEAR } from "jalaali-js";
import { jalaaliMonthToGregorianRange } from "./monthly-comparison";

// "day" is deliberately not a granularity here — it's not a comparison view (see
// lib/reports/today-spending.ts, which computes today's range directly instead of
// going through periodToGregorianRange).
export type ReportGranularity = "week" | "month" | "year";

export interface GregorianRange {
  start: Date;
  end: Date;
}

const WEEK_FORMAT = /^(\d{4})-W(\d{2})$/;
const YEAR_FORMAT = /^(\d{4})$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Whole-day difference `to - from`, computed off local calendar fields (not wall-clock ms) so DST shifts can't skew it. */
function daysBetween(from: Date, to: Date): number {
  const utcFrom = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const utcTo = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((utcTo - utcFrom) / MS_PER_DAY);
}

function jalaaliDateToLocalDate(jy: number, jm: number, jd: number): Date {
  const g = toGregorian(jy, jm, jd);
  return new Date(g.gy, g.gm - 1, g.gd);
}

/**
 * Gregorian date of the Saturday that begins Jalaali year `jy`'s week 1.
 *
 * jalaali-js has no week-of-year numbering (only `jalaaliWeek()`, which
 * bounds the week containing a *specific* date) so this project defines its
 * own convention: week 1 is the Saturday–Friday week containing Farvardin 1.
 * Since Farvardin 1 isn't always a Saturday, week 1 can start up to 6 days
 * *before* Farvardin 1, dipping into the tail of year `jy - 1` — but only
 * ever backward, never forward, which keeps the rule one-directional. Week N
 * is exactly 7*(N-1) days after this date. A year's final week can therefore
 * be a partial week, and doesn't necessarily line up with `jalaaliWeek()`
 * for dates right at the boundary with the next year — an accepted trade-off
 * of simple week-of-year numbering (ISO week-years have the same property).
 */
function week1Start(jy: number): Date {
  const { saturday } = jalaaliWeek(jy, 1, 1);
  return jalaaliDateToLocalDate(saturday.jy, saturday.jm, saturday.jd);
}

function jalaaliWeekToGregorianRange(week: string): GregorianRange {
  const match = WEEK_FORMAT.exec(week);
  if (!match) {
    throw new Error(`هفته نامعتبر است: "${week}". فرمت مورد انتظار "YYYY-Www" جلالی است.`);
  }

  const jy = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (weekNumber < 1 || weekNumber > 53) {
    throw new Error(`هفته نامعتبر است: "${week}". شماره هفته باید بین ۰۱ تا ۵۳ باشد.`);
  }

  const start = addDays(week1Start(jy), 7 * (weekNumber - 1));
  return { start, end: addDays(start, 7) };
}

function jalaaliYearToGregorianRange(year: string): GregorianRange {
  const match = YEAR_FORMAT.exec(year);
  if (!match) {
    throw new Error(`سال نامعتبر است: "${year}". فرمت مورد انتظار "YYYY" جلالی است.`);
  }

  const jy = Number(match[1]);
  if (jy < MIN_JALAALI_YEAR || jy > MAX_JALAALI_YEAR) {
    throw new Error(`سال نامعتبر است: "${year}". سال باید بین ${MIN_JALAALI_YEAR} تا ${MAX_JALAALI_YEAR} باشد.`);
  }

  return {
    start: jalaaliDateToLocalDate(jy, 1, 1),
    end: jalaaliDateToLocalDate(jy + 1, 1, 1),
  };
}

/** Gregorian [start, end) bounds of a Jalaali period, for the week/month/year comparison granularities. */
export function periodToGregorianRange(period: string, granularity: ReportGranularity): GregorianRange {
  switch (granularity) {
    case "week":
      return jalaaliWeekToGregorianRange(period);
    case "month":
      return jalaaliMonthToGregorianRange(period);
    case "year":
      return jalaaliYearToGregorianRange(period);
  }
}

/** Inverse of periodToGregorianRange: the period key (of the given granularity) that `date` falls into. */
export function dateToPeriodKey(date: Date, granularity: ReportGranularity): string {
  const { jy, jm } = toJalaali(date);
  switch (granularity) {
    case "month":
      return `${jy}-${pad2(jm)}`;
    case "year":
      return `${jy}`;
    case "week": {
      const weekNumber = Math.floor(daysBetween(week1Start(jy), date) / 7) + 1;
      return `${jy}-W${pad2(weekNumber)}`;
    }
  }
}

/** The period key immediately preceding `period`, one unit back at the given granularity. */
export function getPreviousPeriod(period: string, granularity: ReportGranularity): string {
  const { start } = periodToGregorianRange(period, granularity);
  const dayBeforeStart = addDays(start, -1);
  return dateToPeriodKey(dayBeforeStart, granularity);
}
