// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PeriodTrendChart } from "@/components/reports/PeriodTrendChart";
import type { TrendPeriod } from "@/lib/reports/trend-insights";
import { formatToman } from "@/lib/format";

afterEach(() => {
  cleanup();
});

function period(periodKey: string, label: string, income: number, expense: number): TrendPeriod {
  return { periodKey, label, income, expense, net: income - expense };
}

// Oldest-first, like getPeriodTrend. Every net is distinct so each compact value is a unique text.
const ALL_POSITIVE: TrendPeriod[] = [
  period("1404-04", "تیر ۱۴۰۴", 10_000_000, 9_150_000), // +850_000
  period("1404-05", "مرداد ۱۴۰۴", 12_000_000, 9_700_000), // +2_300_000
  period("1404-06", "شهریور ۱۴۰۴", 11_500_000, 10_000_000), // +1_500_000
];

const WITH_DEFICIT: TrendPeriod[] = [
  period("1404-04", "تیر ۱۴۰۴", 10_000_000, 9_150_000), // +850_000
  period("1404-05", "مرداد ۱۴۰۴", 8_000_000, 9_200_000), // -1_200_000
  period("1404-06", "شهریور ۱۴۰۴", 11_500_000, 10_000_000), // +1_500_000
];

describe("PeriodTrendChart", () => {
  it("renders nothing for empty periods", () => {
    const { container } = render(<PeriodTrendChart periods={[]} granularity="month" />);

    expect(container.firstChild).toBeNull();
  });

  it("renders the title, subtitle and savings legend entry", () => {
    render(<PeriodTrendChart periods={ALL_POSITIVE} granularity="month" />);

    expect(screen.getByText("روند پس‌انداز دوره‌ها")).toBeDefined();
    expect(screen.getByText("درآمد منهای هزینه‌ی هر دوره")).toBeDefined();
    expect(screen.getByText("پس‌انداز (درآمد بیشتر از هزینه)")).toBeDefined();
  });

  it("hides the overspending legend entry when no period has a negative net", () => {
    render(<PeriodTrendChart periods={ALL_POSITIVE} granularity="month" />);

    expect(screen.queryByText("اضافه‌خرج (هزینه بیشتر از درآمد)")).toBeNull();
  });

  it("shows the overspending legend entry when some period has a negative net", () => {
    render(<PeriodTrendChart periods={WITH_DEFICIT} granularity="month" />);

    expect(screen.getByText("اضافه‌خرج (هزینه بیشتر از درآمد)")).toBeDefined();
    expect(screen.getByText("پس‌انداز (درآمد بیشتر از هزینه)")).toBeDefined();
  });

  it("shows every period's compact net value, with a real minus sign for negatives", () => {
    render(<PeriodTrendChart periods={WITH_DEFICIT} granularity="month" />);

    const labels = screen.getAllByTestId("period-value-label").map((el) => el.textContent);
    expect(labels).toHaveLength(3);
    expect(labels).toContain("۸۵۰ هزار");
    expect(labels).toContain("−۱٫۲ میلیون");
    expect(labels).toContain("۱٫۵ میلیون");
  });

  it("lays value labels out RTL (number then unit) with the signed number as an LTR isolate", () => {
    render(<PeriodTrendChart periods={WITH_DEFICIT} granularity="month" />);

    const negative = screen.getAllByTestId("period-value-label").find((el) => el.textContent === "−۱٫۲ میلیون");
    expect(negative?.getAttribute("dir")).toBe("rtl");
    const bdi = negative?.querySelector("bdi");
    expect(bdi?.getAttribute("dir")).toBe("ltr");
    expect(bdi?.textContent).toBe("−۱٫۲");
  });

  it("renders a number-only value (no unit) correctly", () => {
    render(<PeriodTrendChart periods={[period("1404-04", "تیر ۱۴۰۴", 950, 0)]} granularity="month" />);

    const label = screen.getByTestId("period-value-label");
    expect(label.textContent).toBe("۹۵۰");
    expect(label.getAttribute("dir")).toBe("rtl");
    expect(label.querySelector("bdi")?.textContent).toBe("۹۵۰");
  });

  it("shows every period's label", () => {
    render(<PeriodTrendChart periods={ALL_POSITIVE} granularity="month" />);

    for (const { label } of ALL_POSITIVE) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it("marks only the last period as جاری", () => {
    render(<PeriodTrendChart periods={ALL_POSITIVE} granularity="month" />);

    const captions = screen.getAllByText("جاری");
    expect(captions).toHaveLength(1);

    const lastColumn = screen.getByText("شهریور ۱۴۰۴").parentElement;
    expect(lastColumn?.contains(captions[0])).toBe(true);
    const otherColumn = screen.getByText("تیر ۱۴۰۴").parentElement;
    expect(otherColumn?.contains(captions[0])).toBe(false);
  });

  it("marks a single period as جاری", () => {
    render(<PeriodTrendChart periods={[ALL_POSITIVE[0]]} granularity="year" />);

    expect(screen.getAllByText("جاری")).toHaveLength(1);
  });

  it("gives each column a title with label, income, expense and net in full Toman", () => {
    render(<PeriodTrendChart periods={WITH_DEFICIT} granularity="month" />);

    const title = screen.getByText("مرداد ۱۴۰۴").parentElement?.getAttribute("title");
    expect(title).toBe(
      ["مرداد ۱۴۰۴", `درآمد: ${formatToman(8_000_000)}`, `هزینه: ${formatToman(9_200_000)}`, `خالص: ${formatToman(-1_200_000)}`].join("\n")
    );
  });

  it("keeps the img role and an accessible label on the chart container", () => {
    render(<PeriodTrendChart periods={ALL_POSITIVE} granularity="month" />);

    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toBe("نمودار خالص درآمد و هزینه 3 دوره اخیر");
    expect(chart.getAttribute("dir")).toBe("ltr");
  });
});
