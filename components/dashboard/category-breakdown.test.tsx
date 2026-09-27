// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CategoryBreakdown } from "@/components/dashboard/category-breakdown";

afterEach(() => {
  cleanup();
});

function segment(name: string, total: number) {
  return { name, icon: "•", color: "#888888", total };
}

describe("CategoryBreakdown", () => {
  it("shows an empty message when there are no expenses", () => {
    render(<CategoryBreakdown segments={[]} totalExpense={0} />);

    expect(screen.getByText("هنوز هزینه‌ای برای این ماه ثبت نشده.")).toBeDefined();
  });

  it("shows each category's compact amount and share in Persian digits", () => {
    render(
      <CategoryBreakdown
        segments={[segment("خانه", 400_000_000), segment("سیگار", 1_460_000)]}
        totalExpense={401_460_000}
      />
    );

    expect(screen.getByText("۴۰۰ میلیون")).toBeDefined();
    expect(screen.getByText("۱٫۵ میلیون")).toBeDefined();
    // 99.64% must not round up to ۱۰۰٪ next to a non-zero sibling...
    expect(screen.getByText("۹۹٪")).toBeDefined();
    // ...and 0.36% must not round down to a misleading ۰٪.
    expect(screen.getByText("۰٫۴٪")).toBeDefined();
  });

  it("folds everything past the fourth category into one سایر row once there are more than five", () => {
    render(
      <CategoryBreakdown
        segments={[
          segment("a", 600),
          segment("b", 200),
          segment("c", 100),
          segment("d", 50),
          segment("e", 30),
          segment("f", 20),
        ]}
        totalExpense={1000}
      />
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText(/سایر/)).toBeDefined();
    expect(screen.queryByText(/\be\b/)).toBeNull();
    // e + f = 50 of 1000
    expect(screen.getAllByText("۵٪")).toHaveLength(2);
  });

  it("lists exactly five categories without folding", () => {
    render(
      <CategoryBreakdown
        segments={[segment("a", 1), segment("b", 1), segment("c", 1), segment("d", 1), segment("e", 1)]}
        totalExpense={5}
      />
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText(/سایر/)).toBeNull();
  });
});
