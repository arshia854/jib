import { toJalaali, toGregorian } from "jalaali-js";

const PERSIAN_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

const numberFormatter = new Intl.NumberFormat("fa-IR");

export function formatToman(amount: number): string {
  return `${numberFormatter.format(Math.round(amount))} تومان`;
}

export function formatNumber(amount: number): string {
  return numberFormatter.format(Math.round(amount));
}

// Unlike formatNumber (always rounds to a whole number - correct for Toman
// amounts, which never have a fractional unit smaller than 1 in this app),
// asset quantities routinely are fractional (grams of gold, a BTC holding
// like 0.015) - Math.round would silently show "۰" for a real, non-zero
// holding. `maxDecimals` defaults to 2 (a rough "equivalent value" blurb,
// e.g. the dashboard's gold/dollar-equivalent line, reads better without 6
// digits of noise); components/assets/assets-manager.tsx passes 6 for an
// actual holding's own quantity, where a small BTC amount needs it.
export function formatDecimal(amount: number, maxDecimals = 2): string {
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: maxDecimals }).format(amount);
}

export function formatJalaaliDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jy, jm, jd } = toJalaali(d);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]} ${numberFormatter.format(jy)}`;
}

export function formatJalaaliDateShort(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jm, jd } = toJalaali(d);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]}`;
}

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Jalali date + zero-padded time, e.g. "۱۲ مرداد ۱۴۰۴ - ۱۴:۰۵" (admin error logs). */
export function formatJalaaliDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jy, jm, jd } = toJalaali(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`.replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]} ${numberFormatter.format(jy)} - ${time}`;
}

export function currentJalaaliMonthLabel(date: Date = new Date()): string {
  const { jy, jm } = toJalaali(date);
  return `${PERSIAN_MONTHS[jm - 1]} ${numberFormatter.format(jy)}`;
}

const MONTH_KEY_FORMAT = /^(\d{4})-(\d{2})$/;

/** Persian month name for a Jalaali month key like "1404-05" (→ "مرداد"). */
export function jalaaliMonthKeyToLabel(monthKey: string): string {
  const match = MONTH_KEY_FORMAT.exec(monthKey);
  if (!match) return monthKey;
  const jm = Number(match[2]);
  return PERSIAN_MONTHS[jm - 1] ?? monthKey;
}

// Phase 1 (trend-insights) - lib/reports/trend-insights.ts's multi-period
// trend can span a year boundary, where jalaaliMonthKeyToLabel's bare month
// name (used for CategoryComparisonBar's tight single-comparison labels,
// which never cross a year) would be ambiguous between e.g. اسفند ۱۴۰۲ and
// اسفند ۱۴۰۳.
const WEEK_KEY_FORMAT = /^(\d{4})-W(\d{2})$/;

/** "مرداد ۱۴۰۴" for a Jalaali month key like "1404-05" - like jalaaliMonthKeyToLabel but with the year included, for contexts (a multi-period trend) where the bare month name alone could be ambiguous. */
export function jalaaliMonthKeyToFullLabel(monthKey: string): string {
  const match = MONTH_KEY_FORMAT.exec(monthKey);
  if (!match) return monthKey;
  const jy = Number(match[1]);
  const jm = Number(match[2]);
  const monthName = PERSIAN_MONTHS[jm - 1];
  return monthName ? `${monthName} ${numberFormatter.format(jy)}` : monthKey;
}

/** "هفته ۵ - ۱۴۰۴" for a Jalaali week key like "1404-W05" (see lib/reports/period-range.ts for this app's week-of-year convention). */
export function jalaaliWeekKeyToLabel(weekKey: string): string {
  const match = WEEK_KEY_FORMAT.exec(weekKey);
  if (!match) return weekKey;
  const jy = Number(match[1]);
  const weekNumber = Number(match[2]);
  return `هفته ${numberFormatter.format(weekNumber)} - ${numberFormatter.format(jy)}`;
}

/** "۱۴۰۴" for a Jalaali year key like "1404". */
export function jalaaliYearKeyToLabel(yearKey: string): string {
  const jy = Number(yearKey);
  return Number.isFinite(jy) ? numberFormatter.format(jy) : yearKey;
}

/** Gregorian [start, end) bounds of the Jalaali month containing `date`. */
export function getJalaaliMonthRange(date: Date = new Date()): {
  start: Date;
  end: Date;
  label: string;
} {
  const { jy, jm } = toJalaali(date);
  const startG = toGregorian(jy, jm, 1);
  const endG = jm === 12 ? toGregorian(jy + 1, 1, 1) : toGregorian(jy, jm + 1, 1);

  return {
    start: new Date(startG.gy, startG.gm - 1, startG.gd),
    end: new Date(endG.gy, endG.gm - 1, endG.gd),
    label: `${PERSIAN_MONTHS[jm - 1]} ${numberFormatter.format(jy)}`,
  };
}
