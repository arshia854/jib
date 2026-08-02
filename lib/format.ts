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
