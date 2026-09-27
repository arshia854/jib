// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MonthSummaryCard } from "@/components/dashboard/month-summary-card";

afterEach(() => {
  cleanup();
});

describe("MonthSummaryCard", () => {
  it("shows income and expense side by side", () => {
    render(<MonthSummaryCard income={100_000_000} expense={40_000_000} />);

    expect(screen.getByText("درآمد")).toBeDefined();
    expect(screen.getByText("۱۰۰٬۰۰۰٬۰۰۰")).toBeDefined();
    expect(screen.getByText("هزینه")).toBeDefined();
    expect(screen.getByText("۴۰٬۰۰۰٬۰۰۰")).toBeDefined();
  });

  it("says how much of the income is spent and how much is left while under budget", () => {
    render(<MonthSummaryCard income={100_000_000} expense={40_000_000} />);

    expect(screen.getByText("۴۰٪")).toBeDefined();
    expect(screen.getByText("۶۰ میلیون")).toBeDefined();
    expect(screen.queryByText(/بیشتر از درآمدت/)).toBeNull();
  });

  it("never rounds a not-quite-spent income up to ۱۰۰٪", () => {
    render(<MonthSummaryCard income={1000} expense={996} />);

    expect(screen.getByText("۹۹٪")).toBeDefined();
  });

  it("warns, with the overspent amount, once expense exceeds income", () => {
    render(<MonthSummaryCard income={100_000_000} expense={401_460_000} />);

    expect(screen.getByText(/بیشتر از درآمدت خرج/)).toBeDefined();
    expect(screen.getByText("۳۰۱٫۵ میلیون")).toBeDefined();
  });

  it("has no meter when there's no income yet, and says so only if something was spent", () => {
    const { rerender } = render(<MonthSummaryCard income={0} expense={5000} />);
    expect(screen.getByText("هنوز درآمدی برای این ماه ثبت نکردی.")).toBeDefined();
    expect(screen.queryByText(/خرج شده/)).toBeNull();

    rerender(<MonthSummaryCard income={0} expense={0} />);
    expect(screen.queryByText("هنوز درآمدی برای این ماه ثبت نکردی.")).toBeNull();
  });
});
