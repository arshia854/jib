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
  /**
   * Days after this are dimmed and unselectable - the mirror of minDate, for
   * a date that can't be in the future (assets-manager.tsx's purchase date).
   */
  maxDate?: Date;
  /**
   * Overrides the trigger button's classes - lets callers with their own
   * inline layout (e.g. add-transaction-form.tsx's input/preview stages)
   * match their surrounding fields' look instead of inheriting
   * goals-manager.tsx's bottom-sheet-form styling. Defaults to exactly the
   * classes goals-manager.tsx already relies on, so that usage is
   * byte-for-byte unaffected by this prop's existence.
   */
  triggerClassName?: string;
  /**
   * Whether the "N days until/past the deadline" countdown line renders
   * inside the calendar. Defaults to `true`, which preserves
   * goals-manager.tsx's current behavior with zero changes needed there -
   * that line is meaningless for a plain transaction date (there's no
   * deadline), so add-transaction-form.tsx passes `false`.
   */
  showDeadlineCountdown?: boolean;
  /**
   * Overrides the quick-select row at the bottom of the calendar. Defaults
   * to the goal-oriented "۱/۳/۶ ماه" buttons (unchanged for
   * goals-manager.tsx). Each option's `getDate` receives "today" and
   * returns the Date to jump to - a plain calendar-day offset for
   * add-transaction-form.tsx's "امروز/دیروز/پریروز", as opposed to the
   * default options' Jalali-month arithmetic.
   */
  quickSelectOptions?: { label: string; getDate: (today: Date) => Date }[];
  /**
   * `'compact'` shrinks the calendar's padding/gaps/font sizes for inline
   * embedding in a tighter layout (add-transaction-form.tsx) while keeping
   * the same colors, Saturday-first grid, and selected-day highlight.
   * Defaults to `'default'`, which changes nothing from the calendar's
   * current footprint.
   */
  density?: "default" | "compact";
}

const DEFAULT_TRIGGER_CLASSNAME =
  "mt-1 w-full rounded-xl border border-border bg-background p-3 text-start text-sm tabular-fa outline-none focus:border-accent";

export function JalaliDatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  triggerClassName,
  showDeadlineCountdown = true,
  quickSelectOptions,
  density = "default",
}: JalaliDatePickerProps) {
  const compact = density === "compact";
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
    return (
      (!!minDate && startOfDay(date) < startOfDay(minDate)) ||
      (!!maxDate && startOfDay(date) > startOfDay(maxDate))
    );
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

  function selectQuickDate(getDate: (today: Date) => Date) {
    const date = getDate(new Date());
    const jalaali = toJalaali(date);
    onChange(toDateInputValue(date));
    setViewYear(jalaali.jy);
    setViewMonth(jalaali.jm);
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
        className={triggerClassName ?? DEFAULT_TRIGGER_CLASSNAME}
      >
        {formatJalaaliDate(selected)}
      </button>

      {open && (
        <>
          <div
            className={`absolute z-20 mt-2 w-full rounded-2xl border border-border bg-surface shadow-lg ${
              compact ? "p-2" : "p-3"
            }`}
          >
            {showDeadlineCountdown && (
              <p className="text-center text-xs text-muted">
                {daysToDeadline >= 0
                  ? `${formatNumber(daysToDeadline)} روز تا موعود`
                  : `${formatNumber(Math.abs(daysToDeadline))} روز از موعود گذشته`}
              </p>
            )}

            <div
              className={`flex items-center justify-between ${
                showDeadlineCountdown ? (compact ? "mt-2" : "mt-3") : ""
              }`}
            >
              <button
                type="button"
                onClick={() => goToMonth(-1)}
                aria-label="ماه قبل"
                className={`rounded-full text-muted hover:bg-background ${compact ? "p-1" : "p-1.5"}`}
              >
                <BackIcon className="h-4 w-4 rotate-180" />
              </button>
              <span className={`font-semibold text-foreground ${compact ? "text-xs" : "text-sm"}`}>
                {monthLabel}
              </span>
              <button
                type="button"
                onClick={() => goToMonth(1)}
                aria-label="ماه بعد"
                className={`rounded-full text-muted hover:bg-background ${compact ? "p-1" : "p-1.5"}`}
              >
                <BackIcon className="h-4 w-4" />
              </button>
            </div>

            <div
              className={`grid grid-cols-7 text-center text-xs text-muted ${
                compact ? "mt-2 gap-0.5" : "mt-3 gap-1"
              }`}
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>

            <div className={`mt-1 grid grid-cols-7 ${compact ? "gap-0.5" : "gap-1"}`}>
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
                    className={`rounded-lg text-xs tabular-fa ${compact ? "py-1" : "py-1.5"} ${
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

            <div
              className={`flex gap-2 border-t border-border ${compact ? "mt-2 pt-2" : "mt-3 pt-3"}`}
            >
              {quickSelectOptions
                ? quickSelectOptions.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => selectQuickDate(option.getDate)}
                      className={`flex-1 rounded-xl bg-background text-xs font-medium text-muted hover:text-accent ${
                        compact ? "py-1.5" : "py-2"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))
                : QUICK_SELECT_OPTIONS.map((option) => (
                    <button
                      key={option.months}
                      type="button"
                      onClick={() => selectQuickOption(option.months)}
                      className={`flex-1 rounded-xl bg-background text-xs font-medium text-muted hover:text-accent ${
                        compact ? "py-1.5" : "py-2"
                      }`}
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
