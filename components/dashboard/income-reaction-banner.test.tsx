// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IncomeReactionBanner } from "@/components/dashboard/income-reaction-banner";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const items = [
  {
    strategyId: 1,
    label: "۵۰/۳۰/۲۰",
    percent: 20,
    suggestedAmount: 200_000,
    transferHref: "/app/transfer?from=1&to=2&amount=200000&note=x",
  },
  {
    strategyId: 2,
    label: "اول به خودت پرداخت کن",
    percent: 12.5,
    suggestedAmount: 125_000,
    transferHref: null,
  },
];

const KEY_7 = "jib:income-reaction-dismissed:7";

describe("IncomeReactionBanner", () => {
  it("renders the income amount and one line per strategy", () => {
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    expect(screen.getByText(/این درآمد ۱٬۰۰۰٬۰۰۰ تومان‌ی یعنی/)).toBeDefined();
    expect(screen.getByText("طبق «۵۰/۳۰/۲۰» (۲۰٪): ۲۰۰٬۰۰۰ تومان")).toBeDefined();
    // Fractional percent isn't rounded away.
    expect(screen.getByText("طبق «اول به خودت پرداخت کن» (۱۲٫۵٪): ۱۲۵٬۰۰۰ تومان")).toBeDefined();
  });

  it("links to the prefilled transfer only for items that have a transferHref", () => {
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/app/transfer?from=1&to=2&amount=200000&note=x");
  });

  it("renders no links at all when no item has a transferHref", () => {
    render(
      <IncomeReactionBanner
        incomeTransactionId={7}
        incomeAmount={1_000_000}
        items={items.map((i) => ({ ...i, transferHref: null }))}
      />
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("طبق «۵۰/۳۰/۲۰» (۲۰٪): ۲۰۰٬۰۰۰ تومان")).toBeDefined();
  });

  it("hides itself when dismissed", () => {
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    fireEvent.click(screen.getByRole("button", { name: "بستن" }));

    expect(screen.queryByText(/این درآمد/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("IncomeReactionBanner - persisted dismissal", () => {
  it("dismissing via the X button writes the per-income key", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    fireEvent.click(screen.getByRole("button", { name: "بستن" }));

    expect(setItem).toHaveBeenCalledWith(KEY_7, "1");
    expect(localStorage.getItem(KEY_7)).toBe("1");
  });

  it("stays hidden on mount when this income event was already dismissed", () => {
    localStorage.setItem(KEY_7, "1");
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    // The mount effect has run by the time render() returns (RTL wraps it in act).
    expect(screen.queryByText(/این درآمد/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still shows for a different income event even if another one was dismissed", () => {
    localStorage.setItem(KEY_7, "1");
    render(<IncomeReactionBanner incomeTransactionId={8} incomeAmount={1_000_000} items={items} />);

    expect(screen.getByText(/این درآمد/)).toBeDefined();
  });

  it("ignores any stored value other than \"1\"", () => {
    localStorage.setItem(KEY_7, "0");
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    expect(screen.getByText(/این درآمد/)).toBeDefined();
  });

  it("clicking an انتقال link writes the key too (and doesn't block the navigation)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    const link = screen.getByRole("link", { name: /انتقال/ });
    // jsdom doesn't implement navigation. This document-level listener runs
    // after React's handlers: it records whether the component itself called
    // preventDefault(), then cancels the click so jsdom doesn't try to navigate.
    let preventedByComponent: boolean | null = null;
    const swallowNavigation = (e: Event) => {
      preventedByComponent = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", swallowNavigation);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener("click", swallowNavigation);
    }

    expect(setItem).toHaveBeenCalledWith(KEY_7, "1");
    expect(localStorage.getItem(KEY_7)).toBe("1");
    expect(preventedByComponent).toBe(false);
    expect(screen.queryByText(/این درآمد/)).toBeNull();
  });

  it("renders normally, and dismisses locally, when localStorage throws on read and write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    render(<IncomeReactionBanner incomeTransactionId={7} incomeAmount={1_000_000} items={items} />);

    // Read failed -> fail open: behaves as "not dismissed".
    expect(screen.getByText(/این درآمد/)).toBeDefined();

    // Write failing must not crash the click handler or block the local dismissal.
    fireEvent.click(screen.getByRole("button", { name: "بستن" }));
    expect(screen.queryByText(/این درآمد/)).toBeNull();
  });
});
