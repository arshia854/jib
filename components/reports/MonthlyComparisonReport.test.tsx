// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MonthlyComparisonReport } from "@/components/reports/MonthlyComparisonReport";
import type { ReportGranularity } from "@/lib/reports/period-range";
import type { NarrativeReport } from "@/lib/reports/narrative-report";

// Sibling cards are unrelated to the category-list heading; stub them so the test only
// exercises MonthlyComparisonReport's own markup (CategoryComparisonBar stays real).
vi.mock("@/components/reports/NarrativeReportCard", () => ({ NarrativeReportCard: () => null }));
vi.mock("@/components/reports/PeriodTrendChart", () => ({ PeriodTrendChart: () => null }));
vi.mock("@/components/reports/DiscretionarySplitCard", () => ({ DiscretionarySplitCard: () => null }));
vi.mock("@/components/reports/RecurringExpensesCard", () => ({ RecurringExpensesCard: () => null }));
vi.mock("@/components/reports/UnusualTransactionsCard", () => ({ UnusualTransactionsCard: () => null }));

afterEach(() => {
  cleanup();
});

function renderReport(granularity: ReportGranularity) {
  return render(
    <MonthlyComparisonReport
      comparison={{
        previousMonth: "1404-05",
        currentMonth: "1404-06",
        categories: [
          { category: "خوراک", previousAmount: 100_000, currentAmount: 200_000, percentChange: 100, isIncrease: true, isEssential: true },
          { category: "رستوران", previousAmount: 300_000, currentAmount: 150_000, percentChange: -50, isIncrease: false, isEssential: false },
        ],
      } as never}
      highlights={[]}
      trend={[]}
      granularity={granularity}
      recurringExpenses={[]}
      unusualTransactions={[]}
      narrative={{} as NarrativeReport}
    />
  );
}

describe("MonthlyComparisonReport category list header", () => {
  it.each([
    ["week", "نسبت به هفته قبل"],
    ["month", "نسبت به ماه قبل"],
    ["year", "نسبت به سال قبل"],
  ] as const)("shows the heading and %s caption", (granularity, caption) => {
    renderReport(granularity);

    expect(screen.getByRole("heading", { name: "مقایسه دسته‌ها" })).toBeDefined();
    expect(screen.getByText(caption)).toBeDefined();
  });

  // The ضروری/غیرضروری key moved from a standalone legend onto each row (CategoryComparisonBar's
  // own text tag), so exactly one of each here - one essential and one discretionary row above.
  it("shows the bar key, and each row's essential/non-essential tag", () => {
    renderReport("month");

    expect(screen.getByText("نوار پررنگ = این دوره · نوار کم‌رنگ = دوره قبل")).toBeDefined();
    expect(screen.getByText("ضروری")).toBeDefined();
    expect(screen.getByText("غیرضروری")).toBeDefined();
  });
});
