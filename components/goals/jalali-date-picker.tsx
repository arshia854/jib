"use client";

import { useState } from "react";
import { toJalaali, toGregorian, jalaaliMonthLength } from "jalaali-js";
import { formatJalaaliDate, formatNumber, jalaaliMonthKeyToFullLabel } from "@/lib/format";
import { BackIcon } from "@/components/icons";

// Saturday-start weekday header, matching lib/reports/period-range.ts's own
// week1Start convention (week 1 = the Saturday-Friday week containing
// Farvardin 1). Single-letter Persian weekday initials, same density as a
// typical Jalali calendar widget.
const WEEKDAY_LABELS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

const QUICK_SELECT_OPTIONS = [
  { label: "۱ ماه", months: 1 },
  { label: "۳ ماه", months: 3 },
  { label: "۶ ماه", months: 6 },
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Same Gregorian yyyy-mm-dd convention the native <input type="date"> this
// component replaces used, and that goals-manager.tsx's FormState.deadline
// / the /api/goals request body still expect.
function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseDateInputValue(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Whole-day difference `to - from`, computed off local calendar fields (not
 * a raw Date.now()/getTime() subtraction, which a DST shift could skew by a
 * hidden hour). Mirrors lib/reports/period-range.ts's own private
 * daysBetween exactly - replicated here rather than imported since that
 * function isn't exported and this task's scope doesn't extend to editing
 * period-range.ts to export it.
 */
export function daysBetween(from: Date, to: Date): number {
  const utcFrom = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const utcTo = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((utcTo - utcFrom) / MS_PER_DAY);
}

/**
 * Add `months` Jalali months to a Jalali (jy, jm) pair, wrapping the year as
 * needed - plain Jalali month arithmetic on the (year, month) pair itself,
 * not `Date.setMonth` (which walks the *Gregorian* calendar and would drift
 * against the Jalali month grid actually shown to the user, e.g. landing on
 * the wrong side of a Jalali/Gregorian month-boundary mismatch).
 */
export function addJalaaliMonths(jy: number, jm: number, months: number): { jy: number; jm: number } {
  const total = jy * 12 + (jm - 1) + months;
  return { jy: Math.floor(total / 12), jm: (((total % 12) + 12) % 12) + 1 };
}

interface JalaliDatePickerProps {
  /** Gregorian yyyy-mm-dd, same convention as the native date input this replaces. */
  value: string;
  onChange: (value: string) => void;
  /** Days before this are dimmed and unselectable. Future-only validation itself stays in goals-manager.tsx. */
  minDate?: Date;
}

export function JalaliDatePicker({ value, onChange, minDate }: JalaliDatePickerProps) {
  const selected = parseDateInputValue(value);
  const [open, setOpen] = useState(false);
  const initialJalaali = toJalaali(selected);
  const [viewYear, setViewYear] = useState(initialJalaali.jy);
  const [viewMonth, setViewMonth] = useState(initialJalaali.jm);

  function togglePanel() {
    if (!open) {
      // Re-sync the viewed month to the currently selected date every time
      // the panel is opened, so browsing away in a previous session without
      // picking a day doesn't leave a stale month showing next time.
      const jalaali = toJalaali(parseDateInputValue(value));
      setViewYear(jalaali.jy);
      setViewMonth(jalaali.jm);
    }
    setOpen((o) => !o);
  }

  function goToMonth(months: number) {
    const target = addJalaaliMonths(viewYear, viewMonth, months);
    setViewYear(target.jy);
    setViewMonth(target.jm);
  }

  function isDisabled(date: Date): boolean {
    return !!minDate && startOfDay(date) < startOfDay(minDate);
  }

  function selectDay(jd: number) {
    const g = toGregorian(viewYear, viewMonth, jd);
    const date = new Date(g.gy, g.gm - 1, g.gd);
    if (isDisabled(date)) return;
    onChange(toDateInputValue(date));
    setOpen(false);
  }

  function selectQuickOption(months: number) {
    const today = new Date();
    const { jy, jm, jd } = toJalaali(today);
    const target = addJalaaliMonths(jy, jm, months);
    // Clamp the day (e.g. Farvardin 31 + 6 months lands on Mehr, which only
    // has 30 days) rather than overflowing into the following month.
    const day = Math.min(jd, jalaaliMonthLength(target.jy, target.jm));
    const g = toGregorian(target.jy, target.jm, day);
    const date = new Date(g.gy, g.gm - 1, g.gd);
    onChange(toDateInputValue(date));
    setViewYear(target.jy);
    setViewMonth(target.jm);
    setOpen(false);
  }

  const monthLabel = jalaaliMonthKeyToFullLabel(`${viewYear}-${pad2(viewMonth)}`);
  const daysInMonth = jalaaliMonthLength(viewYear, viewMonth);
  const firstOfMonthG = toGregorian(viewYear, viewMonth, 1);
  const firstOfMonthDate = new Date(firstOfMonthG.gy, firstOfMonthG.gm - 1, firstOfMonthG.gd);
  // Date.getDay() is Sunday=0..Saturday=6; shift so Saturday (this
  // calendar's own week start) lands at grid index 0.
  const leadingBlanks = (firstOfMonthDate.getDay() + 1) % 7;

  const daysToDeadline = daysBetween(startOfDay(new Date()), startOfDay(selected));

  return (
    <div className="relative">
      <button
        type="button"
        onClick={togglePanel}
        className="mt-1 w-full rounded-xl border border-border bg-background p-3 text-start text-sm tabular-fa outline-none focus:border-accent"
      >
        {formatJalaaliDate(selected)}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-2 w-full rounded-2xl border border-border bg-surface p-3 shadow-lg">
            <p className="text-center text-xs text-muted">
              {daysToDeadline >= 0
                ? `${formatNumber(daysToDeadline)} روز تا موعود`
                : `${formatNumber(Math.abs(daysToDeadline))} روز از موعود گذشته`}
            </p>

            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => goToMonth(-1)}
                aria-label="ماه قبل"
                className="rounded-full p-1.5 text-muted hover:bg-background"
              >
                <BackIcon className="h-4 w-4 rotate-180" />
              </button>
              <span className="text-sm font-semibold text-foreground">{monthLabel}</span>
              <button
                type="button"
                onClick={() => goToMonth(1)}
                aria-label="ماه بعد"
                className="rounded-full p-1.5 text-muted hover:bg-background"
              >
                <BackIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs text-muted">
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-1">
              {Array.from({ length: leadingBlanks }).map((_, i) => (
                <span key={`blank-${i}`} />
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const jd = i + 1;
                const g = toGregorian(viewYear, viewMonth, jd);
                const date = new Date(g.gy, g.gm - 1, g.gd);
                const isSelected = toDateInputValue(date) === toDateInputValue(selected);
                const disabled = isDisabled(date);
                return (
                  <button
                    key={jd}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectDay(jd)}
                    className={`rounded-lg py-1.5 text-xs tabular-fa ${
                      isSelected
                        ? "bg-primary text-on-primary"
                        : disabled
                          ? "text-muted/40"
                          : "text-foreground hover:bg-background"
                    }`}
                  >
                    {formatNumber(jd)}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex gap-2 border-t border-border pt-3">
              {QUICK_SELECT_OPTIONS.map((option) => (
                <button
                  key={option.months}
                  type="button"
                  onClick={() => selectQuickOption(option.months)}
                  className="flex-1 rounded-xl bg-background py-2 text-xs font-medium text-muted hover:text-accent"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
