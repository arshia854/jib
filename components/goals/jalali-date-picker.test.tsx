// @vitest-environment jsdom
//
// Component-render tests for JalaliDatePicker, following the jsdom + RTL
// convention introduced in components/transactions/add-transaction-form.test.tsx
// (the pure-function tests for addJalaaliMonths/daysBetween stay in the
// sibling jalali-date-picker.test.ts, which runs under the default `node`
// environment).
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toGregorian } from "jalaali-js";
import { formatJalaaliDate } from "@/lib/format";
import { JalaliDatePicker } from "./jalali-date-picker";

afterEach(() => {
  cleanup();
});

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const TODAY_ISO = toDateInputValue(new Date());

function openPanel() {
  fireEvent.click(screen.getByText(formatJalaaliDate(TODAY_ISO)));
}

describe("JalaliDatePicker - default behavior (no new props)", () => {
  // This is the regression check that matters most: goals-manager.tsx passes
  // only value/onChange/minDate, so nothing here should change - the deadline
  // countdown line and the ۱/۳/۶ ماه quick-select buttons must still render,
  // at the calendar's original (non-compact) footprint.
  it("renders the deadline countdown line", () => {
    render(<JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} />);
    openPanel();

    expect(screen.getByText(/روز تا موعود|روز از موعود گذشته/)).toBeDefined();
  });

  it("renders the default ۱/۳/۶ ماه quick-select buttons", () => {
    render(<JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} />);
    openPanel();

    expect(screen.getByRole("button", { name: "۱ ماه" })).toBeDefined();
    expect(screen.getByRole("button", { name: "۳ ماه" })).toBeDefined();
    expect(screen.getByRole("button", { name: "۶ ماه" })).toBeDefined();
  });
});

describe("JalaliDatePicker - showDeadlineCountdown", () => {
  it("omits the countdown line when showDeadlineCountdown is false", () => {
    render(
      <JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} showDeadlineCountdown={false} />
    );
    openPanel();

    expect(screen.queryByText(/روز تا موعود|روز از موعود گذشته/)).toBeNull();
  });

  it("still renders the countdown line when showDeadlineCountdown is true (explicit default)", () => {
    render(<JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} showDeadlineCountdown={true} />);
    openPanel();

    expect(screen.getByText(/روز تا موعود|روز از موعود گذشته/)).toBeDefined();
  });
});

describe("JalaliDatePicker - quickSelectOptions", () => {
  it("renders the custom options instead of the default ۱/۳/۶ ماه buttons", () => {
    render(
      <JalaliDatePicker
        value={TODAY_ISO}
        onChange={vi.fn()}
        quickSelectOptions={[
          { label: "امروز", getDate: (today) => today },
          { label: "دیروز", getDate: (today) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1) },
        ]}
      />
    );
    openPanel();

    expect(screen.getByRole("button", { name: "امروز" })).toBeDefined();
    expect(screen.getByRole("button", { name: "دیروز" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "۱ ماه" })).toBeNull();
  });

  it("selecting a custom option calls onChange with that option's getDate result", () => {
    const onChange = vi.fn();
    const today = new Date();
    const twoDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
    const expected = toDateInputValue(twoDaysAgo);

    render(
      <JalaliDatePicker
        value={TODAY_ISO}
        onChange={onChange}
        quickSelectOptions={[{ label: "پریروز", getDate: () => twoDaysAgo }]}
      />
    );
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "پریروز" }));

    expect(onChange).toHaveBeenCalledWith(expected);
  });
});

describe("JalaliDatePicker - density", () => {
  it("does not change classes when density is 'default' or omitted", () => {
    const { container: withoutProp } = render(<JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} />);
    fireEvent.click(within(withoutProp).getByText(formatJalaaliDate(TODAY_ISO)));
    const panelWithoutProp = withoutProp.querySelector(".absolute.z-20");

    const { container: withDefault } = render(
      <JalaliDatePicker value={TODAY_ISO} onChange={vi.fn()} density="default" />
    );
    fireEvent.click(within(withDefault).getByText(formatJalaaliDate(TODAY_ISO)));
    const panelWithDefault = withDefault.querySelector(".absolute.z-20");

    expect(panelWithoutProp?.className).toBe(panelWithDefault?.className);
  });
});

describe("JalaliDatePicker - year rendering", () => {
  // 12 Mordad 1404 - a fixed date so the expected strings are literals, not helper output.
  const { gy, gm, gd } = toGregorian(1404, 5, 12);
  const FIXED_ISO = `${gy}-${pad2(gm)}-${pad2(gd)}`;

  it("renders the year without a thousands separator in the trigger and the month header", () => {
    render(<JalaliDatePicker value={FIXED_ISO} onChange={vi.fn()} />);

    expect(screen.getByText("۱۲ مرداد ۱۴۰۴")).toBeDefined();
    fireEvent.click(screen.getByText("۱۲ مرداد ۱۴۰۴"));

    expect(screen.getByText("مرداد ۱۴۰۴")).toBeDefined();
    expect(document.body.textContent).not.toContain("۱٬۴۰۴");
  });
});
