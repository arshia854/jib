"use client";

import type { ChangeEvent, KeyboardEvent } from "react";
import { formatNumber, toPersianDigits } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";

// Live thousand-separator grouping for the *free-text* transaction boxes
// ("۵۰ هزار تومن ناهار خوردم"), as opposed to AmountInput's structured
// number-only field. Same visual result (lib/format.ts's fa-IR formatter,
// lib/normalize.ts's toLatinDigits - no new Latin-only convention), but
// the value the parent owns is deliberately *not* the formatted string:
//
//   - The canonical value (what add-transaction-form.tsx keeps in `text`,
//     feeds to buildQuickParsedTransaction, and sends as `rawInput`) never
//     contains a separator this component inserted. lib/extract-amount.ts's
//     NUMBER_TOKEN is /^\d+$/ - a single separator inside a number token
//     makes extractAmount return null and silently disables the whole
//     quick-submit path, so this stays a display-layer transform only.
//   - Separators the user's *own* text already had are equally load-bearing
//     in the opposite direction: lib/bank/extract-bank-amount.ts's
//     AMOUNT_TOKEN is /\d{1,3}(?:,\d{3})+/ - it only recognizes an amount
//     that *is* comma-grouped (that's how it tells a real amount from an
//     account number or OTP code). Blindly stripping every comma to recover
//     the canonical value would therefore break every pasted bank SMS.
//
// Both hold at once because the two separators are different characters:
// formatNumber (fa-IR) emits U+066C "٬", never an ASCII comma, so a "٬"
// sitting between two digits is always one this component inserted and is
// always safe to strip, while an ASCII "," is always the user's own and is
// kept verbatim. The one exception is a box whose entire content is a bare
// number (BARE_NUMBER below) - "5,646,132" pasted on its own is the user
// asking for that number, not prose that happens to contain commas, so its
// ASCII commas are stripped too.

// Shortest run worth grouping - 1-3 digits need no separator at all. They
// (and any run skipped by the rules below) are still transliterated to
// Persian digits, same as every other number this app renders: the
// canonical value is Latin-normalized, so leaving a short run "as-is" would
// mean someone typing "۵۰ هزار تومن" watched their own digits turn Latin
// mid-keystroke, then flip back to Persian the moment a run reached 4
// digits. Transliteration is 1:1, so it never moves the caret.
const MIN_RUN_LENGTH = 4;

// Above 15 digits Number() stops being exact (2^53 is 16 digits), so
// formatting would corrupt what's on screen. A digit run that long is a
// card/account/tracking number anyway, never an amount.
const MAX_RUN_LENGTH = 15;

// A digit run touching one of these is part of a larger numeric structure -
// a date ("1404/06/21"), a card number ("6037-9911-1234-5678"), an
// already-grouped amount ("2,300,000"), a decimal - not a standalone
// number. Grouping those would put a thousands separator inside a year or a
// card group, which is exactly the "pasted bank SMS must look untouched"
// case. Deliberately excludes ":" so "ناهار:50000" (no space after the
// colon) still groups.
const STRUCTURAL_NEIGHBORS = new Set(["/", "-", ",", "٬", ".", "٫"]);

// The separator formatNumber itself produces (U+066C). Every occurrence is
// removed, not just the ones still sitting between two digits: backspacing
// the digit in front of one leaves it orphaned mid-field, and an orphan
// kept in the canonical value would break extractAmount's NUMBER_TOKEN just
// as thoroughly as an embedded one. Nothing else in this app types a bare
// U+066C as prose.
const INSERTED_SEPARATOR = /٬/g;

// Whole content is one bare number (optionally comma-grouped/whitespace
// padded) - see the ASCII-comma exception in this file's header comment.
const BARE_NUMBER = /^\s*\d[\d,\s]*$/;

const DIGIT_RUN = /\d+/g;
const ANY_DIGIT = /[0-9۰-۹٠-٩]/;

/**
 * Display transform: every maximal ASCII-digit run of >= 4 digits becomes
 * its formatNumber form (grouped, Persian digits); every other run is only
 * transliterated; all non-digit text passes through byte-identical. Pure
 * function of the canonical value - there is no hidden state behind what's
 * on screen.
 */
export function formatDigitRuns(value: string): string {
  return value.replace(DIGIT_RUN, (run: string, index: number, whole: string) => {
    if (run.length < MIN_RUN_LENGTH || run.length > MAX_RUN_LENGTH) return toPersianDigits(run);
    // Leading zeros don't survive Number() ("007000" would render as
    // "۷٬۰۰۰"), and a leading zero means it isn't an amount anyway.
    if (run.startsWith("0")) return toPersianDigits(run);
    if (STRUCTURAL_NEIGHBORS.has(whole[index - 1] ?? "")) return toPersianDigits(run);
    if (STRUCTURAL_NEIGHBORS.has(whole[index + run.length] ?? "")) return toPersianDigits(run);
    return formatNumber(Number(run));
  });
}

/**
 * Inverse of formatDigitRuns: recovers the canonical value from whatever
 * the browser currently has in the field. Digits are normalized to Latin
 * (the same toLatinDigits convention lib/extract-amount.ts and
 * lib/bank/normalize.ts already apply before parsing), separators this
 * component inserted are removed, and the user's own ASCII commas are kept
 * unless the whole field is a bare number. formatDigitRuns(strip(x)) is a
 * fixed point for anything this component itself rendered, so repeated
 * keystrokes can't drift.
 */
export function stripDisplayFormatting(displayed: string): string {
  const latin = toLatinDigits(displayed).replace(INSERTED_SEPARATOR, "");
  return BARE_NUMBER.test(latin) ? latin.replace(/,/g, "") : latin;
}

function countDigits(text: string): number {
  let count = 0;
  for (const character of text) {
    if (ANY_DIGIT.test(character)) count += 1;
  }
  return count;
}

// Earliest offset in `text` with exactly `digitsBefore` digits before it -
// i.e. immediately after that many digits, on the *near* side of any
// separator that follows. Being earliest is what makes backspacing over a
// separator progress: the caret lands before the separator, so the next
// backspace deletes a digit instead of the separator again.
function offsetAfterDigits(text: string, digitsBefore: number): number {
  if (digitsBefore === 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (ANY_DIGIT.test(text[i])) {
      seen += 1;
      if (seen === digitsBefore) return i + 1;
    }
  }
  return text.length;
}

/**
 * Wires a plain <textarea>/<input> to the transform above. Returns the
 * props to spread onto the field; the parent keeps owning the canonical
 * (separator-free) string via the same `onChange(value: string)` shape a
 * bare field already has, so no downstream consumer changes.
 */
export function useCommaFormattedText(
  value: string,
  onChange: (value: string) => void
): {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
} {
  function handleChange(event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const element = event.currentTarget;
    const typed = element.value;
    const caret = element.selectionStart ?? typed.length;

    const nextValue = stripDisplayFormatting(typed);
    const nextDisplay = formatDigitRuns(nextValue);

    // Only when grouping actually changed what the browser just inserted is
    // the field's value (and therefore the caret) ours to correct. Editing
    // non-digit text leaves `typed` already equal to its own display form,
    // and the browser's caret is then exactly right - re-deriving it from a
    // digit count would drag the caret back to the last digit instead.
    if (nextDisplay !== typed) {
      const nextCaret = offsetAfterDigits(nextDisplay, countDigits(typed.slice(0, caret)));
      // Written straight to the DOM node: React won't re-render for a value
      // it never saw (a keystroke that leaves the canonical value unchanged,
      // e.g. backspacing over a separator), and even when it does, the field
      // it would restore is the display string, not what was typed.
      element.value = nextDisplay;
      element.setSelectionRange(nextCaret, nextCaret);
    }

    onChange(nextValue);
  }

  return { value: formatDigitRuns(value), onChange: handleChange };
}

export interface NaturalLanguageAmountFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

/** Multi-line free-text box (the single "add transaction" flow). */
export function NaturalLanguageAmountTextarea({
  value,
  onChange,
  rows = 4,
  ...rest
}: NaturalLanguageAmountFieldProps & {
  rows?: number;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  "aria-describedby"?: string;
}) {
  const formatted = useCommaFormattedText(value, onChange);
  return <textarea {...rest} rows={rows} {...formatted} />;
}

/** Single-line variant (one batch row). */
export function NaturalLanguageAmountInput({ value, onChange, ...rest }: NaturalLanguageAmountFieldProps) {
  const formatted = useCommaFormattedText(value, onChange);
  return <input type="text" {...rest} {...formatted} />;
}
