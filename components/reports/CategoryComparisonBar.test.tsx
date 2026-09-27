// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CategoryComparisonBar } from "@/components/reports/CategoryComparisonBar";
import type { ReportGranularity } from "@/lib/reports/period-range";
import type { CategoryComparison } from "@/lib/reports/monthly-comparison";
import { formatCompactToman, formatNumber } from "@/lib/format";

afterEach(() => {
  cleanup();
});

function comparison(overrides: Partial<CategoryComparison> = {}): CategoryComparison {
  return {
    category: "خوراک",
    previousAmount: 850_000,
    currentAmount: 2_300_000,
    percentChange: 171,
    isIncrease: true,
    isEssential: true,
    ...overrides,
  };
}

function renderBar(
  data: CategoryComparison,
  { granularity = "month", previousKey = "1404-05", currentKey = "1404-06" }: { granularity?: ReportGranularity; previousKey?: string; currentKey?: string } = {}
) {
  return render(
    <CategoryComparisonBar data={data} granularity={granularity} previousMonth={previousKey} currentMonth={currentKey} sharedMax={2_300_000} />
  );
}

describe("CategoryComparisonBar", () => {
  it("shows both the previous and current amounts", () => {
    renderBar(comparison());

    expect(screen.getByText(formatCompactToman(850_000))).toBeDefined();
    expect(screen.getByText(formatCompactToman(2_300_000))).toBeDefined();
  });

  it("shows a + badge for an increase", () => {
    renderBar(comparison({ percentChange: 171 }));

    expect(screen.getByText(`+${formatNumber(171)}٪`)).toBeDefined();
  });

  it("shows a − badge (real minus sign) for a decrease", () => {
    renderBar(comparison({ previousAmount: 2_300_000, currentAmount: 850_000, percentChange: -63, isIncrease: false }));

    expect(screen.getByText(`−${formatNumber(63)}٪`)).toBeDefined();
  });

  it("hides the badge when percentChange is null", () => {
    const { container } = renderBar(comparison({ previousAmount: 0, currentAmount: 500_000, percentChange: null }));

    expect(container.textContent).not.toContain("٪");
  });

  it("renders without error when previousAmount is 0", () => {
    const { container } = renderBar(comparison({ previousAmount: 0, currentAmount: 500_000, percentChange: null }));

    expect(screen.getByText(formatCompactToman(500_000))).toBeDefined();
    expect(screen.getByText(formatCompactToman(0))).toBeDefined();
    const fills = container.querySelectorAll<HTMLElement>("div[style]");
    expect(fills[0].style.width).toBe("0%");
  });

  it("tags essential vs. discretionary rows with a text label, not just an icon", () => {
    renderBar(comparison({ isEssential: true }));
    expect(screen.getByText("ضروری")).toBeDefined();
    cleanup();

    renderBar(comparison({ isEssential: false }));
    expect(screen.getByText("غیرضروری")).toBeDefined();
  });

  it("always draws the current-period bar in bg-primary", () => {
    const { container } = renderBar(comparison());

    expect(container.querySelectorAll(".bg-primary")).toHaveLength(1);
  });

  it("labels month rows with the bare month name", () => {
    renderBar(comparison());

    expect(screen.getByText("مرداد")).toBeDefined();
    expect(screen.getByText("شهریور")).toBeDefined();
  });

  it("labels week rows as «هفته N» with no year or raw key", () => {
    const { container } = renderBar(comparison(), { granularity: "week", previousKey: "1404-W05", currentKey: "1404-W06" });

    expect(screen.getByText("هفته ۵")).toBeDefined();
    expect(screen.getByText("هفته ۶")).toBeDefined();
    expect(container.textContent).not.toContain("W0");
  });

  it("labels year rows with Persian-digit years", () => {
    const { container } = renderBar(comparison(), { granularity: "year", previousKey: "1403", currentKey: "1404" });

    expect(screen.getByText("۱۴۰۳")).toBeDefined();
    expect(screen.getByText("۱۴۰۴")).toBeDefined();
    expect(container.textContent).not.toContain("1404");
  });
});
