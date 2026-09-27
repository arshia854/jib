"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/format";
import { toLatinDigits } from "@/lib/normalize";

// Shared live-comma-formatted amount field, replacing the identical
// "type=text inputMode=numeric, format via formatNumber, strip via
// toLatinDigits" pattern that used to be hand-duplicated in
// add-transaction-form.tsx, transfer-form.tsx, batch-add-transaction-form.tsx,
// and the local MoneyInput copies in goals-manager.tsx / assets-manager.tsx.
// Matches this app's existing digit convention (lib/format.ts's fa-IR
// formatter, lib/normalize.ts's toLatinDigits) rather than inventing a new
// Latin-digit/comma one - typed or pasted Eastern Arabic (۰-۹) or
// Arabic-Indic (٠-٩) digits are normalized the same way extract-amount.ts
// and merchant-lookup.ts already do.

const DEFAULT_CLASS =
  "mt-1 w-full rounded-xl border border-border bg-background p-3 text-sm tabular-fa outline-none focus:border-accent";

export interface AmountInputProps {
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  autoFocus?: boolean;
}

export function AmountInput({
  value,
  onChange,
  placeholder,
  className = DEFAULT_CLASS,
  disabled,
  id,
  autoFocus,
}: AmountInputProps) {
  // Digit string backing the display, kept separate from `value` so a
  // cleared/empty field and an in-progress "0" don't collapse into each
  // other the way deriving display text straight from the numeric value
  // would (formatNumber(0) is a real "۰", not blank).
  const [digits, setDigits] = useState(value ? String(value) : "");

  // Re-sync only when `value` changes from *outside* this input (form
  // reset, switching to editing a different record, etc.) - not on every
  // keystroke, since our own onChange already drives `value` and this
  // would otherwise fight in-progress typing/leading zeros. Adjusting state
  // during render (rather than in an effect) per React's guidance for
  // "resetting state when a prop changes" - avoids an extra render pass.
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value && Number(digits || 0) !== value) {
    setLastValue(value);
    setDigits(value ? String(value) : "");
  } else if (lastValue !== value) {
    setLastValue(value);
  }

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoFocus={autoFocus}
      disabled={disabled}
      value={digits ? formatNumber(Number(digits)) : ""}
      placeholder={placeholder}
      onChange={(e) => {
        // toLatinDigits handles Persian/Eastern-Arabic digits; stripping
        // everything but 0-9 after that also drops pasted thousand
        // separators (commas, Persian "٬") in one pass.
        const nextDigits = toLatinDigits(e.target.value).replace(/[^0-9]/g, "");
        setDigits(nextDigits);
        onChange(nextDigits ? Number(nextDigits) : 0);
      }}
      className={className}
    />
  );
}
