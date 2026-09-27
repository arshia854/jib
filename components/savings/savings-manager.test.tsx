// @vitest-environment jsdom
// Same jsdom-scoping precedent as add-transaction-form.test.tsx's own
// top-of-file comment; router mock capture pattern (module-scope
// pushMock/refreshMock referenced from vi.mock's factory) mirrors
// transfer-form.test.tsx's own.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { SavingsManager } from "@/components/savings/savings-manager";

const suggestions = [
  { formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, suggestedMonthlyAmount: 2_000_000, hasData: true },
  { formulaType: "pay_yourself_first", targetPercent: 15, targetAmount: null, suggestedMonthlyAmount: 1_500_000, hasData: true },
  { formulaType: "leftover", targetPercent: null, targetAmount: 800_000, suggestedMonthlyAmount: 800_000, hasData: true },
  { formulaType: "roundup", targetPercent: null, targetAmount: 300_000, suggestedMonthlyAmount: 300_000, hasData: false },
  { formulaType: "custom", targetPercent: null, targetAmount: null, suggestedMonthlyAmount: null, hasData: false },
] as const;

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  refreshMock.mockClear();
  vi.unstubAllGlobals();
});

describe("SavingsManager - formula suggestion cards", () => {
  it("renders every formula type's label and its suggestion figure", () => {
    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    expect(screen.getByText("۵۰/۳۰/۲۰")).toBeDefined();
    expect(screen.getByText("۲۰٪")).toBeDefined();
    expect(screen.getByText("≈ ۲٬۰۰۰٬۰۰۰ تومان در ماه")).toBeDefined();

    expect(screen.getByText("اول به خودت پرداخت کن")).toBeDefined();
    expect(screen.getByText("۱۵٪")).toBeDefined();

    expect(screen.getByText("ته‌مانده‌ی ماه")).toBeDefined();
    expect(screen.getByText("۸۰۰٬۰۰۰ تومان")).toBeDefined();

    expect(screen.getByText("گرد کردن تراکنش‌ها")).toBeDefined();
    expect(screen.getByText("دلخواه")).toBeDefined();
  });

  it("shows the not-enough-data note instead of a figure when hasData is false", () => {
    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    const notes = screen.getAllByText("هنوز داده‌ی کافی برای پیشنهاد شخصی‌سازی‌شده نیست");
    // roundup and custom both have hasData:false in this fixture.
    expect(notes).toHaveLength(2);
  });

  it("shows the empty state below the always-visible cards when there are no strategies yet", () => {
    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    expect(screen.getByText("هنوز هیچ استراتژی‌ای رو پیاده‌سازی نکرده‌اید")).toBeDefined();
    // Cards remain visible regardless.
    expect(screen.getByText("۵۰/۳۰/۲۰")).toBeDefined();
  });
});

describe("SavingsManager - already-active formula card", () => {
  it("shows a disabled, relabeled button on the card whose formula already has an active strategy, and leaves the others implementable", () => {
    const strategies = [
      { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "active" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    const disabled = screen.getByRole("button", { name: "از قبل فعاله" });
    expect(disabled).toHaveProperty("disabled", true);
    expect(disabled.className).toContain("bg-border/40");
    expect(disabled.className).toContain("text-muted");
    expect(disabled.className).not.toContain("bg-primary");

    // Clicking it does nothing - no implement modal opens.
    fireEvent.click(disabled);
    expect(screen.queryByText("پیاده‌سازی ۵۰/۳۰/۲۰")).toBeNull();

    // The other four formulas keep their normal button.
    expect(screen.getAllByRole("button", { name: "پیاده‌سازی" })).toHaveLength(4);
  });

  it("keeps the normal implement button when the formula's existing strategy is paused or abandoned", () => {
    const strategies = [
      { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "paused" },
      { id: 2, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "abandoned" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    expect(screen.queryByRole("button", { name: "از قبل فعاله" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "پیاده‌سازی" })).toHaveLength(5);
  });
});

describe("SavingsManager - implement flow", () => {
  it("POSTs the suggestion's percent-based payload and refreshes on confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ strategy: { id: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getAllByRole("button", { name: "پیاده‌سازی" })[0]);
    expect(screen.getByText("پیاده‌سازی ۵۰/۳۰/۲۰")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /ذخیره/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/savings-strategies");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      formulaType: "fifty_thirty_twenty",
      status: "active",
      targetPercent: 20,
    });

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("POSTs the suggestion's amount-based payload for a leftover-style formula", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ strategy: { id: 2 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getAllByRole("button", { name: "پیاده‌سازی" })[2]);
    expect(screen.getByText("پیاده‌سازی ته‌مانده‌ی ماه")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /ذخیره/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      formulaType: "leftover",
      status: "active",
      targetAmount: 800_000,
    });
  });
});

describe("SavingsManager - existing strategy actions", () => {
  const strategies = [
    { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "active" },
  ];

  it("PATCHes status to paused and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ strategy: { id: 1 } }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getByRole("button", { name: "متوقف کردن" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/savings-strategies/1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body as string)).toEqual({ status: "paused" });

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("DELETEs after the inline confirm toggle and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getByRole("button", { name: "حذف" }));
    fireEvent.click(screen.getByRole("button", { name: "حذف" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/savings-strategies/1");
    expect(options.method).toBe("DELETE");

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});

describe("SavingsManager - do-this-transfer-now shortcut", () => {
  const accounts = [
    { id: 10, name: "نقدی", type: "cash" },
    { id: 11, name: "بانک", type: "bank" },
    { id: 12, name: "پس‌انداز", type: "savings" },
  ];
  const shortcutName = /همین الان انتقالشو انجام بده/;

  it("links a percent-based active strategy using the matching suggestion's suggestedMonthlyAmount, first non-savings -> first savings account", () => {
    const strategies = [
      { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "active" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={accounts} actualTransferredThisMonth={0} />);

    const link = screen.getByRole("link", { name: shortcutName });
    expect(link.getAttribute("href")).toBe(
      `/app/transfer?from=10&to=12&amount=2000000&note=${encodeURIComponent("پیاده‌سازی استراتژی ۵۰/۳۰/۲۰")}`
    );
  });

  it("links an amount-based active strategy using its own targetAmount, even when the suggestion differs", () => {
    const strategies = [
      { id: 2, formulaType: "leftover", targetPercent: null, targetAmount: 950_000, status: "active" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={accounts} actualTransferredThisMonth={0} />);

    const link = screen.getByRole("link", { name: shortcutName });
    expect(link.getAttribute("href")).toBe(
      `/app/transfer?from=10&to=12&amount=950000&note=${encodeURIComponent("پیاده‌سازی استراتژی ته‌مانده‌ی ماه")}`
    );
  });

  it("omits the link when neither the strategy nor its suggestion resolves to a positive amount", () => {
    const strategies = [
      // custom: no stored amount, and its suggestion is all-null/hasData:false.
      { id: 3, formulaType: "custom", targetPercent: null, targetAmount: null, status: "active" },
      // roundup: suggestedMonthlyAmount is a placeholder (hasData:false), not a real figure.
      { id: 4, formulaType: "roundup", targetPercent: 5, targetAmount: null, status: "active" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={accounts} actualTransferredThisMonth={0} />);

    expect(screen.queryByRole("link", { name: shortcutName })).toBeNull();
  });

  it("omits the link for paused and abandoned strategies even when an amount resolves", () => {
    const strategies = [
      { id: 5, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "paused" },
      { id: 6, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "abandoned" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={accounts} actualTransferredThisMonth={0} />);

    expect(screen.queryByRole("link", { name: shortcutName })).toBeNull();
  });

  it("shows one muted message linking to the accounts settings, and no shortcut links, when there is no savings-type account", () => {
    const strategies = [
      { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "active" },
      { id: 2, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "active" },
    ];
    render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[accounts[0], accounts[1]]}
        actualTransferredThisMonth={0}
      />
    );

    expect(screen.queryByRole("link", { name: shortcutName })).toBeNull();
    // Once for the list, not once per active row.
    expect(screen.getAllByText(/برای این کار به یک حساب پس‌انداز نیاز داری/)).toHaveLength(1);
    const link = screen.getByRole("link", { name: "افزودن حساب" });
    expect(link.getAttribute("href")).toBe("/app/settings/accounts");
  });

  it("does not show the no-savings-account message when a savings account exists", () => {
    const strategies = [
      { id: 1, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "active" },
    ];
    render(<SavingsManager strategies={strategies} suggestions={[...suggestions]} goals={[]} accounts={accounts} actualTransferredThisMonth={0} />);

    expect(screen.queryByText(/برای این کار به یک حساب پس‌انداز نیاز داری/)).toBeNull();
  });
});

describe("SavingsManager - this-month progress line", () => {
  // The bar's fill div is the only child of the progress block's track; its
  // width/tone are what the spec cares about.
  function progressFill(container: HTMLElement): HTMLElement {
    const block = container.querySelector('[data-testid="strategy-month-progress"]') as HTMLElement;
    return block.querySelector(".h-full") as HTMLElement;
  }

  it("shows a primary-toned bar at actual/target percent width when actual < target", () => {
    const strategies = [
      { id: 1, formulaType: "leftover", targetPercent: null, targetAmount: 1_000_000, status: "active" },
    ];
    const { container } = render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={250_000}
      />
    );

    expect(screen.getByText("این ماه: ۲۵۰٬۰۰۰ تومان از ۱٬۰۰۰٬۰۰۰ تومان")).toBeDefined();
    const fill = progressFill(container);
    expect(fill.style.width).toBe("25%");
    expect(fill.className).toContain("bg-primary");
    expect(fill.className).not.toContain("bg-success");
  });

  it("shows a success-toned, full-width bar when actual >= target, clamped at 100% when actual exceeds it", () => {
    const strategies = [
      { id: 1, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "active" },
      { id: 2, formulaType: "custom", targetPercent: null, targetAmount: 500_000, status: "active" },
    ];
    const { container } = render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={800_000}
      />
    );

    const [exact, exceeded] = Array.from(
      container.querySelectorAll('[data-testid="strategy-month-progress"] .h-full')
    ) as HTMLElement[];
    // actual == target (800,000 / 800,000).
    expect(exact.style.width).toBe("100%");
    expect(exact.className).toContain("bg-success");
    expect(exact.className).not.toContain("bg-primary");
    // actual > target (800,000 / 500,000) - width must not exceed 100%.
    expect(exceeded.style.width).toBe("100%");
    expect(exceeded.className).toContain("bg-success");
  });

  it("uses the matching suggestion's suggestedMonthlyAmount as the target for a percent-based strategy", () => {
    const strategies = [
      { id: 1, formulaType: "fifty_thirty_twenty", targetPercent: 20, targetAmount: null, status: "active" },
    ];
    const { container } = render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={500_000}
      />
    );

    expect(screen.getByText("این ماه: ۵۰۰٬۰۰۰ تومان از ۲٬۰۰۰٬۰۰۰ تومان")).toBeDefined();
    expect(progressFill(container).style.width).toBe("25%");
  });

  it("omits the progress line for an active row with no resolvable target", () => {
    const strategies = [
      // custom: no stored amount, suggestion is all-null/hasData:false.
      { id: 1, formulaType: "custom", targetPercent: null, targetAmount: null, status: "active" },
      // roundup: suggestedMonthlyAmount is a placeholder (hasData:false).
      { id: 2, formulaType: "roundup", targetPercent: 5, targetAmount: null, status: "active" },
    ];
    render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={100_000}
      />
    );

    expect(screen.queryByTestId("strategy-month-progress")).toBeNull();
    expect(screen.queryByText(/این ماه:/)).toBeNull();
  });

  it("never renders the progress line for paused or abandoned rows, even when a target resolves", () => {
    const strategies = [
      { id: 1, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "paused" },
      { id: 2, formulaType: "leftover", targetPercent: null, targetAmount: 800_000, status: "abandoned" },
    ];
    render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={100_000}
      />
    );

    expect(screen.queryByTestId("strategy-month-progress")).toBeNull();
    expect(screen.queryByText(/این ماه:/)).toBeNull();
  });

  it("renders the same actual figure on every active row, each against its own target", () => {
    const strategies = [
      { id: 1, formulaType: "leftover", targetPercent: null, targetAmount: 1_000_000, status: "active" },
      { id: 2, formulaType: "custom", targetPercent: null, targetAmount: 400_000, status: "active" },
    ];
    render(
      <SavingsManager
        strategies={strategies}
        suggestions={[...suggestions]}
        goals={[]}
        accounts={[]}
        actualTransferredThisMonth={400_000}
      />
    );

    expect(screen.getByText("این ماه: ۴۰۰٬۰۰۰ تومان از ۱٬۰۰۰٬۰۰۰ تومان")).toBeDefined();
    expect(screen.getByText("این ماه: ۴۰۰٬۰۰۰ تومان از ۴۰۰٬۰۰۰ تومان")).toBeDefined();
  });
});

// Same todayInputValue() shape as the component's own local helper - kept as
// a separate copy here (not imported, the component doesn't export it) so
// the POST payload assertions below can independently compute the expected
// purchaseDate.
function todayInputValueForTest(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("SavingsManager - goal allocation section", () => {
  const goalAllocations = [
    { id: 1, name: "سفر شمال", targetAmount: 10_000_000, alreadySaved: 2_000_000, availableBalance: 1_000_000, status: "active" },
    { id: 2, name: "خرید لپ‌تاپ", targetAmount: 5_000_000, alreadySaved: 5_000_000, availableBalance: 0, status: "achieved" },
  ];

  it("shows a coverage row for each active goal with the right percentage and Toman figures, excluding achieved goals", () => {
    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={goalAllocations} accounts={[]} actualTransferredThisMonth={0} />);

    expect(screen.getByText("سفر شمال")).toBeDefined();
    expect(screen.getByText("۳۰٪")).toBeDefined();
    expect(screen.getByText("پوشش داده‌شده: ۳٬۰۰۰٬۰۰۰ تومان")).toBeDefined();
    expect(screen.getByText("هدف: ۱۰٬۰۰۰٬۰۰۰ تومان")).toBeDefined();

    expect(screen.queryByText("خرید لپ‌تاپ")).toBeNull();
  });

  it("shows a muted suggestion with a link to the goals tab when there are no active goals", () => {
    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[goalAllocations[1]]} accounts={[]} actualTransferredThisMonth={0} />);

    const link = screen.getByRole("link", { name: "از تب هدف‌ها یکی بساز" });
    expect(link.getAttribute("href")).toBe("/app/dashboard?tab=goals");
  });
});

describe("SavingsManager - convert savings to asset", () => {
  it("derives quantity from a Toman amount for a live-priced type and POSTs the computed payload", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ unavailable: false, goldGramPricePerUnit: 5_000_000 }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ asset: { id: 1 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getByRole("button", { name: /تبدیل پس‌انداز به دارایی/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/assets/live-prices");
    await waitFor(() => expect(screen.getByText("مبلغ (تومان)")).toBeDefined());

    const amountInput = container.querySelector('input[inputMode="numeric"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10000000" } });

    await waitFor(() => expect(screen.getByText("۲ گرم")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/assets");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      type: "gold",
      quantity: 2,
      purchasePricePerUnit: 5_000_000,
      purchaseDate: todayInputValueForTest(),
      note: null,
    });

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("requires a name for a custom asset, then POSTs the manually entered quantity/price", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ unavailable: false, goldGramPricePerUnit: 5_000_000 }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ asset: { id: 2 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getByRole("button", { name: /تبدیل پس‌انداز به دارایی/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /سایر \(دستی\)/ }));

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    expect(screen.getByText("برای دارایی دستی، نام الزامی است.")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("مثلاً سهام فولاد، خودرو"), { target: { value: "سهام فولاد" } });
    fireEvent.change(container.querySelector('input[type="number"]') as HTMLInputElement, { target: { value: "3" } });
    fireEvent.change(container.querySelector('input[inputMode="numeric"]') as HTMLInputElement, {
      target: { value: "1000000" },
    });

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/assets");
    expect(JSON.parse(options.body as string)).toEqual({
      type: "custom",
      quantity: 3,
      purchasePricePerUnit: 1_000_000,
      purchaseDate: todayInputValueForTest(),
      note: null,
      name: "سهام فولاد",
    });
  });

  it("disables the confirm button when live prices are unavailable for a live-priced type", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ unavailable: true }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavingsManager strategies={[]} suggestions={[...suggestions]} goals={[]} accounts={[]} actualTransferredThisMonth={0} />);

    fireEvent.click(screen.getByRole("button", { name: /تبدیل پس‌انداز به دارایی/ }));

    await waitFor(() => expect(screen.getByText("قیمت لحظه‌ای در دسترس نیست")).toBeDefined());
    expect(screen.getByRole("button", { name: "ذخیره" })).toHaveProperty("disabled", true);
  });
});
