import { toJalaali, toGregorian } from "jalaali-js";
import type { ReportGranularity } from "@/lib/reports/period-range";

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

// Ascending, so the loop below can just keep the last unit the amount reaches. Thresholds are
// hand-rolled rather than Intl's `notation: "compact"` because fa-IR's compact ICU output isn't
// guaranteed to be stable across runtimes.
const COMPACT_UNITS = [
  { value: 1, suffix: "" },
  { value: 1e3, suffix: " هزار" },
  { value: 1e6, suffix: " میلیون" },
  { value: 1e9, suffix: " میلیارد" },
];

// Whole numbers below 1000 (like formatNumber), one decimal place once a unit is applied.
function roundForUnit(scaled: number, unitIndex: number): number {
  return unitIndex === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
}

/**
 * Short Toman amount for tight spots (chart bar values), e.g. 2_300_000 → "۲٫۳ میلیون",
 * -850_000 → "−۸۵۰ هزار". No "تومان" suffix - the caller supplies the unit context. Negatives use
 * a real minus sign (U+2212), not a hyphen.
 */
export function formatCompactToman(amount: number): string {
  const abs = Math.abs(amount);

  let unitIndex = 0;
  COMPACT_UNITS.forEach((unit, i) => {
    if (abs >= unit.value) unitIndex = i;
  });

  let scaled = roundForUnit(abs / COMPACT_UNITS[unitIndex].value, unitIndex);
  // Rounding can carry a value up to the next unit (999_999 → 1000 هزار); show it as 1 میلیون instead.
  if (scaled >= 1000 && unitIndex < COMPACT_UNITS.length - 1) {
    unitIndex += 1;
    scaled = roundForUnit(abs / COMPACT_UNITS[unitIndex].value, unitIndex);
  }

  // No sign on something that rounded to zero (a tiny negative shouldn't read "−۰").
  const sign = amount < 0 && scaled > 0 ? "−" : "";
  return `${sign}${formatDecimal(scaled, 1)}${COMPACT_UNITS[unitIndex].suffix}`;
}

export function formatJalaaliDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jy, jm, jd } = toJalaali(d);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]} ${formatJalaaliYear(jy)}`;
}

export function formatJalaaliDateShort(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jm, jd } = toJalaali(d);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]}`;
}

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

// Digit-for-digit transliteration, the exact inverse of lib/normalize.ts's
// toLatinDigits. Unlike formatNumber it goes nowhere near Number(), so
// leading zeros and digit runs longer than 2^53 survive intact - which is
// why a zero-padded clock time, and any digit run that isn't an amount
// (components/ui/natural-language-amount-textarea.tsx), go through here
// instead.
export function toPersianDigits(text: string): string {
  return text.replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/** Jalali date + zero-padded time, e.g. "۱۲ مرداد ۱۴۰۴ - ۱۴:۰۵" (admin error logs). */
export function formatJalaaliDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const { jy, jm, jd } = toJalaali(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const time = toPersianDigits(`${hh}:${mm}`);
  return `${numberFormatter.format(jd)} ${PERSIAN_MONTHS[jm - 1]} ${formatJalaaliYear(jy)} - ${time}`;
}

export function currentJalaaliMonthLabel(date: Date = new Date()): string {
  const { jy, jm } = toJalaali(date);
  return `${PERSIAN_MONTHS[jm - 1]} ${formatJalaaliYear(jy)}`;
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
  return monthName ? `${monthName} ${formatJalaaliYear(jy)}` : monthKey;
}

/** "هفته ۵ - ۱۴۰۴" for a Jalaali week key like "1404-W05" (see lib/reports/period-range.ts for this app's week-of-year convention). */
export function jalaaliWeekKeyToLabel(weekKey: string): string {
  const match = WEEK_KEY_FORMAT.exec(weekKey);
  if (!match) return weekKey;
  const jy = Number(match[1]);
  const weekNumber = Number(match[2]);
  return `هفته ${numberFormatter.format(weekNumber)} - ${formatJalaaliYear(jy)}`;
}

// The shared numberFormatter groups thousands ("۱٬۴۰۴"), which is wrong for a year.
const yearFormatter = new Intl.NumberFormat("fa-IR", { useGrouping: false });

/** "۱۴۰۴" for a Jalaali year number - Persian digits, never grouped. */
export function formatJalaaliYear(jy: number): string {
  return yearFormatter.format(jy);
}

/** "۱۴۰۴" for a Jalaali year key like "1404". */
export function jalaaliYearKeyToLabel(yearKey: string): string {
  const jy = Number(yearKey);
  return Number.isFinite(jy) ? formatJalaaliYear(jy) : yearKey;
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
    label: `${PERSIAN_MONTHS[jm - 1]} ${formatJalaaliYear(jy)}`,
  };
}

/**
 * Tight label for one side of a comparison row (CategoryComparisonBar), by granularity:
 * month → bare month name, week → "هفته ۵" (no year - the two rows are adjacent weeks), year → "۱۴۰۴".
 * A key that doesn't parse is returned unchanged, like the helpers it builds on.
 */
export function periodKeyToShortLabel(key: string, granularity: ReportGranularity): string {
  switch (granularity) {
    case "month":
      return jalaaliMonthKeyToLabel(key);
    case "week": {
      const match = WEEK_KEY_FORMAT.exec(key);
      return match ? `هفته ${numberFormatter.format(Number(match[2]))}` : key;
    }
    case "year":
      return jalaaliYearKeyToLabel(key);
  }
}
