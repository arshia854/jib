// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BalanceCard } from "@/components/dashboard/balance-card";

afterEach(() => {
  cleanup();
});

describe("BalanceCard", () => {
  it("renders the total balance in Eastern-Arabic digits, with the unit as its own smaller span", () => {
    render(<BalanceCard balance={1000000} />);

    expect(screen.getByText("۱٬۰۰۰٬۰۰۰")).toBeDefined();
    expect(screen.getByText("تومان")).toBeDefined();
    expect(screen.getByText("موجودی کل")).toBeDefined();
  });

  it("colors a negative balance and keeps its minus sign pinned to the digits", () => {
    render(<BalanceCard balance={-43327841} />);

    const amount = screen.getByText(/۴۳٬۳۲۷٬۸۴۱/);
    expect(amount.textContent).toContain("−");
    expect(amount.getAttribute("dir")).toBe("ltr");
    expect(amount.className).toContain("text-red-400");
  });

  it("does not render the savings sub-row when savingsBalance is not provided", () => {
    render(<BalanceCard balance={1000000} />);

    expect(screen.queryByText("پس‌انداز")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders the savings sub-row, linked to /app/transfer, and relabels the balance as spendable, when savingsBalance is provided", () => {
    render(<BalanceCard balance={1000000} savingsBalance={2540000} />);

    expect(screen.getByText("پس‌انداز")).toBeDefined();
    expect(screen.getByText("۲٬۵۴۰٬۰۰۰ تومان")).toBeDefined();
    const link = screen.getByRole("link", { name: /پس‌انداز/ });
    expect(link.getAttribute("href")).toBe("/app/transfer");
    expect(screen.getByText("موجودی قابل خرج")).toBeDefined();
    expect(screen.queryByText("موجودی کل")).toBeNull();
  });

  it("renders the gold/dollar equivalent line only when assetEquivalent is provided", () => {
    const { rerender } = render(<BalanceCard balance={1000000} />);
    expect(screen.queryByText(/گرم طلا/)).toBeNull();

    rerender(<BalanceCard balance={1000000} assetEquivalent={{ goldGrams: 12.5, usd: 456 }} />);
    expect(screen.getByText("۱۲٫۵ گرم طلا")).toBeDefined();
    expect(screen.getByText("۴۵۶ دلار")).toBeDefined();
  });
});
