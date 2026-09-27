// @vitest-environment jsdom
//
// Component test (jsdom scoped to this file, same convention as
// components/transactions/add-transaction-form.test.tsx and
// components/ui/amount-input.test.tsx).
//
// The invariant every test here is ultimately about: whatever the box shows,
// the value the parent receives is the one the deterministic extractors
// still understand - lib/extract-amount.ts (needs digit runs with no
// separator at all) and lib/bank/extract-bank-amount.ts (needs the user's
// own comma grouping left intact). Both are asserted directly, not
// approximated, since a break in either silently disables the quick-submit
// path rather than failing loudly.
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  NaturalLanguageAmountTextarea,
  NaturalLanguageAmountInput,
  formatDigitRuns,
  stripDisplayFormatting,
} from "@/components/ui/natural-language-amount-textarea";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate } from "@/lib/extract-date";
import { parseBankSms } from "@/lib/bank/parse-bank-sms";

afterEach(cleanup);

const SEPARATORS = /[,٬]/;

function Controlled({
  initial = "",
  onChange,
  single = false,
}: {
  initial?: string;
  onChange?: (value: string) => void;
  single?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const handleChange = (next: string) => {
    setValue(next);
    onChange?.(next);
  };
  const Field = single ? NaturalLanguageAmountInput : NaturalLanguageAmountTextarea;
  return <Field value={value} onChange={handleChange} placeholder="مثلاً: ۵۰ هزار تومن ناهار خوردم" />;
}

function renderField(options: { initial?: string; single?: boolean } = {}) {
  const onChange = vi.fn();
  render(<Controlled onChange={onChange} {...options} />);
  return { field: screen.getByRole("textbox") as HTMLTextAreaElement, onChange };
}

// Mirrors what a browser actually delivers on a keystroke/paste: the full
// new field value plus the caret where the browser put it, which is what
// the component reads off the native event.
function edit(field: HTMLTextAreaElement, value: string, caret: number) {
  fireEvent.change(field, { target: { value, selectionStart: caret, selectionEnd: caret } });
}

function typeAt(field: HTMLTextAreaElement, text: string, index: number) {
  edit(field, field.value.slice(0, index) + text + field.value.slice(index), index + text.length);
}

function typeAtEnd(field: HTMLTextAreaElement, text: string) {
  typeAt(field, text, field.value.length);
}

function backspaceAt(field: HTMLTextAreaElement, caret: number) {
  edit(field, field.value.slice(0, caret - 1) + field.value.slice(caret), caret - 1);
}

describe("NaturalLanguageAmountTextarea - typing a bare number", () => {
  it("groups live, exactly like AmountInput, while the value stays plain digits", () => {
    const { field, onChange } = renderField();

    typeAtEnd(field, "5");
    expect(field.value).toBe("۵");
    expect(onChange).toHaveBeenLastCalledWith("5");

    typeAtEnd(field, "6");
    expect(field.value).toBe("۵۶");
    expect(onChange).toHaveBeenLastCalledWith("56");

    typeAtEnd(field, "4");
    expect(field.value).toBe("۵۶۴");
    expect(onChange).toHaveBeenLastCalledWith("564");

    typeAtEnd(field, "6");
    expect(field.value).toBe("۵٬۶۴۶");
    expect(onChange).toHaveBeenLastCalledWith("5646");

    typeAtEnd(field, "1");
    expect(field.value).toBe("۵۶٬۴۶۱");
    expect(onChange).toHaveBeenLastCalledWith("56461");

    typeAtEnd(field, "3");
    expect(field.value).toBe("۵۶۴٬۶۱۳");
    expect(onChange).toHaveBeenLastCalledWith("564613");

    typeAtEnd(field, "2");
    expect(field.value).toBe("۵٬۶۴۶٬۱۳۲");
    expect(onChange).toHaveBeenLastCalledWith("5646132");

    // Not one keystroke along the way handed the parent a separator.
    for (const [value] of onChange.mock.calls) {
      expect(value).not.toMatch(SEPARATORS);
    }
    expect(extractAmount("5646132")).toBe(5646132);
  });

  it("keeps the caret after the digit just typed when a separator appears", () => {
    const { field } = renderField();

    typeAtEnd(field, "9");
    typeAtEnd(field, "9");
    typeAtEnd(field, "9");
    expect(field.value).toBe("۹۹۹");
    expect(field.selectionStart).toBe(3);

    // 999 -> 9999: a separator is inserted *behind* the caret, so the caret
    // has to move past it rather than staying on its old index.
    typeAtEnd(field, "9");
    expect(field.value).toBe("۹٬۹۹۹");
    expect(field.selectionStart).toBe(5);
    expect(field.value[field.selectionStart! - 1]).toBe("۹");
  });

  it("removes exactly one digit per backspace, including over a separator", () => {
    const { field, onChange } = renderField();
    edit(field, "5646", 4);
    expect(field.value).toBe("۵٬۶۴۶");

    // Caret sits right after the separator; the browser deletes the
    // separator itself. The digits are unchanged, so the value must be too -
    // and the caret must end up *before* the separator, or the next
    // backspace would delete it again forever.
    backspaceAt(field, 2);
    expect(field.value).toBe("۵٬۶۴۶");
    expect(onChange).toHaveBeenLastCalledWith("5646");
    expect(field.selectionStart).toBe(1);

    // Next backspace deletes one digit - not two, and no separator is left
    // stranded in the value.
    backspaceAt(field, 1);
    expect(onChange).toHaveBeenLastCalledWith("646");
    expect(field.value).toBe("۶۴۶");
    expect(field.selectionStart).toBe(0);

    backspaceAt(field, 3);
    expect(onChange).toHaveBeenLastCalledWith("64");
    expect(field.value).toBe("۶۴");

    for (const [value] of onChange.mock.calls) {
      expect(value).not.toMatch(SEPARATORS);
    }
  });

  it("inserts a digit in the middle of the text without stranding the caret", () => {
    const { field, onChange } = renderField();
    edit(field, "1234", 4);
    expect(field.value).toBe("۱٬۲۳۴");

    // Caret after "۱٬۲" (3 chars in, 2 digits in) - type a digit there.
    typeAt(field, "9", 3);

    expect(onChange).toHaveBeenLastCalledWith("12934");
    expect(field.value).toBe("۱۲٬۹۳۴");
    // Immediately after the "۹" that was just typed, i.e. 3 digits in - the
    // naive "reformat and jump to the end" bug would leave this at 6.
    expect(field.selectionStart).toBe(4);
    expect(field.value[field.selectionStart! - 1]).toBe("۹");
  });

  it("moves the caret past a separator inserted behind it mid-text", () => {
    const { field, onChange } = renderField();
    edit(field, "123", 3);
    expect(field.value).toBe("۱۲۳");

    // Typing after the first digit grows the run to 4, so a separator
    // appears *between* the caret and the text before it: the browser left
    // the caret at 2, but the correct spot is now 3, past the separator.
    typeAt(field, "9", 1);

    expect(onChange).toHaveBeenLastCalledWith("1923");
    expect(field.value).toBe("۱٬۹۲۳");
    expect(field.selectionStart).toBe(3);
    expect(field.value[field.selectionStart! - 1]).toBe("۹");
  });
});

describe("NaturalLanguageAmountTextarea - natural language", () => {
  it("normalizes Eastern Arabic digits to Latin in the value, keeps them Persian on screen", () => {
    const { field, onChange } = renderField();

    edit(field, "۵۰ هزار تومن خرج کردم", 21);

    expect(onChange).toHaveBeenLastCalledWith("50 هزار تومن خرج کردم");
    expect(field.value).toBe("۵۰ هزار تومن خرج کردم");

    // What actually matters: extraction still resolves off the value.
    const [value] = onChange.mock.lastCall!;
    expect(extractAmount(value)).toBe(50000);
    expect(extractAmount(value)).toBe(extractAmount("۵۰ هزار تومن خرج کردم"));
  });

  it("leaves non-digit text byte-identical and does not disturb date extraction", () => {
    const { field, onChange } = renderField();

    edit(field, "دیروز 2500000 تومن شام خوردیم!", 30);

    expect(onChange).toHaveBeenLastCalledWith("دیروز 2500000 تومن شام خوردیم!");
    expect(field.value).toBe("دیروز ۲٬۵۰۰٬۰۰۰ تومن شام خوردیم!");
    const [value] = onChange.mock.lastCall!;
    expect(extractAmount(value)).toBe(2500000);
    expect(extractDate(value, new Date("2026-09-13T00:00:00Z"))).toBe("2026-09-12");
  });

  it("types plain prose after a number without dragging the caret back to it", () => {
    const { field } = renderField();
    edit(field, "2500000", 7);
    expect(field.value).toBe("۲٬۵۰۰٬۰۰۰");

    typeAtEnd(field, " ق");
    expect(field.value).toBe("۲٬۵۰۰٬۰۰۰ ق");
    expect(field.selectionStart).toBe(field.value.length);
  });

  it("leaves short digit runs ungrouped", () => {
    const { field, onChange } = renderField();

    edit(field, "2 تا قهوه 250 تومن", 18);

    expect(onChange).toHaveBeenLastCalledWith("2 تا قهوه 250 تومن");
    expect(field.value).toBe("۲ تا قهوه ۲۵۰ تومن");
    expect(field.value).not.toMatch(SEPARATORS);
  });
});

describe("NaturalLanguageAmountTextarea - pasting", () => {
  it("strips the separators out of an already-formatted number", () => {
    const { field, onChange } = renderField();

    edit(field, "5,646,132", 9);

    expect(onChange).toHaveBeenLastCalledWith("5646132");
    expect(field.value).toBe("۵٬۶۴۶٬۱۳۲");
    expect(extractAmount("5646132")).toBe(5646132);
  });

  it("does not double-format a number pasted in this app's own display form", () => {
    const { field, onChange } = renderField();

    edit(field, "۵٬۶۴۶٬۱۳۲", 9);

    expect(onChange).toHaveBeenLastCalledWith("5646132");
    expect(field.value).toBe("۵٬۶۴۶٬۱۳۲");
  });

  // The regression this whole design is shaped around: extract-bank-amount's
  // AMOUNT_TOKEN (/\d{1,3}(?:,\d{3})+/) only recognizes an amount that is
  // comma-grouped, so the user's own commas have to reach it untouched.
  const BANK_SMS = "بانک ملت\nبرداشت: 150,000\nمانده: 2,300,000\n1404/06/21 14:32";

  it("passes a pasted bank SMS through to the value byte-identically", () => {
    const { field, onChange } = renderField();

    edit(field, BANK_SMS, BANK_SMS.length);

    expect(onChange).toHaveBeenLastCalledWith(BANK_SMS);
    const [value] = onChange.mock.lastCall!;
    expect(parseBankSms(value)).toMatchObject({ amount: 150000, type: "expense" });
  });

  it("renders a pasted bank SMS without inserting a separator anywhere", () => {
    const { field } = renderField();

    edit(field, BANK_SMS, BANK_SMS.length);

    // Only the digit scripts change; the SMS's own commas, colons, slashes,
    // line breaks and Persian text are all still exactly where they were,
    // and the "1404" of the date is never grouped into "۱٬۴۰۴".
    expect(field.value).toBe("بانک ملت\nبرداشت: ۱۵۰,۰۰۰\nمانده: ۲,۳۰۰,۰۰۰\n۱۴۰۴/۰۶/۲۱ ۱۴:۳۲");
    expect(field.value).not.toContain("٬");
  });

  it("keeps typing correct after a bank SMS paste", () => {
    const { field, onChange } = renderField();
    edit(field, BANK_SMS, BANK_SMS.length);

    typeAtEnd(field, " قهوه");

    // The commas survive a subsequent keystroke - a naive "strip every
    // comma to recover the value" would quietly eat them here.
    expect(onChange).toHaveBeenLastCalledWith(`${BANK_SMS} قهوه`);
    expect(parseBankSms(`${BANK_SMS} قهوه`)).toMatchObject({ amount: 150000 });
  });
});

describe("formatDigitRuns / stripDisplayFormatting", () => {
  it("round-trips every display string back to its canonical value", () => {
    const values = [
      "",
      "5646132",
      "50 هزار تومن خرج کردم",
      "بانک ملت\nبرداشت: 150,000\nمانده: 2,300,000\n1404/06/21 14:32",
      "کارت 6037-9911-1234-5678",
      "حساب 0123456789",
      "12.5 تومن",
      "2 تا قهوه 250 تومن",
    ];

    for (const value of values) {
      expect(stripDisplayFormatting(formatDigitRuns(value))).toBe(value);
      // Idempotent: re-rendering what's already on screen changes nothing.
      expect(formatDigitRuns(stripDisplayFormatting(formatDigitRuns(value)))).toBe(formatDigitRuns(value));
    }
  });

  it("never groups a run that belongs to a date, card number, or leading-zero id", () => {
    expect(formatDigitRuns("1404/06/21")).toBe("۱۴۰۴/۰۶/۲۱");
    expect(formatDigitRuns("6037-9911-1234-5678")).toBe("۶۰۳۷-۹۹۱۱-۱۲۳۴-۵۶۷۸");
    expect(formatDigitRuns("0123456789")).toBe("۰۱۲۳۴۵۶۷۸۹");
    expect(formatDigitRuns("12345678901234567890")).toBe("۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸۹۰");
  });

  it("groups a standalone run of 4+ digits", () => {
    expect(formatDigitRuns("1000")).toBe("۱٬۰۰۰");
    expect(formatDigitRuns("ناهار:50000")).toBe("ناهار:۵۰٬۰۰۰");
    expect(formatDigitRuns("999")).toBe("۹۹۹");
  });
});

describe("NaturalLanguageAmountInput (batch row)", () => {
  it("behaves identically to the textarea variant", () => {
    const { field, onChange } = renderField({ single: true });

    edit(field, "5646132", 7);

    expect(field.value).toBe("۵٬۶۴۶٬۱۳۲");
    expect(onChange).toHaveBeenLastCalledWith("5646132");
  });
});
