// @vitest-environment jsdom
//
// Conventions borrowed from add-transaction-form.test.tsx (this app's first
// component test): @testing-library/react under a per-file jsdom
// environment, next/navigation's useRouter mocked, fetch stubbed per test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AssetsManager } from "@/components/assets/assets-manager";
import { toLatinDigits } from "@/lib/normalize";

const emptySummary = {
  assets: [],
  totalValue: 0,
  totalCostBasis: 0,
  totalProfitLossToman: 0,
  totalProfitLossPercent: null,
  priceStale: false,
  priceUnavailable: false,
};

const goldAsset = {
  id: 1,
  type: "gold",
  name: null,
  quantity: 2,
  purchasePricePerUnit: 5_000_000,
  purchaseDate: "2026-08-01",
  currentPricePerUnit: 5_500_000,
  note: null,
  currentValue: 11_000_000,
  costBasis: 10_000_000,
  profitLossToman: 1_000_000,
  profitLossPercent: 10,
};

// "unavailable: true" keeps openCreate()'s live-price prefill a no-op, so
// these tests don't have to race/await an auto-filled purchase price - each
// test fills the fields it needs by hand.
function stubLivePricesFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unavailable: true }) });
}

// MoneyInput/AmountInput fields render as a plain <label> immediately
// followed by the <input> (see assets-manager.tsx's MoneyInput), with no
// htmlFor/id pairing - locate by that adjacency instead of getByLabelText.
function fieldAfterLabel(labelText: string): HTMLInputElement {
  return screen.getByText(labelText).nextElementSibling as HTMLInputElement;
}

// The raw quantity field (quantity-mode only) sits in its own <input
// type="number">, and its label is no longer a plain preceding sibling once
// the گرم/میلی‌گرم toggle shares the same row (see assets-manager.tsx) - so
// unlike fieldAfterLabel above, locate it directly by its input type. It's
// the only type="number" input the form renders.
function quantityInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="number"]') as HTMLInputElement;
}

async function openCreateForm() {
  vi.stubGlobal("fetch", stubLivePricesFetch());
  const { container } = render(<AssetsManager summary={emptySummary} />);
  fireEvent.click(screen.getByRole("button", { name: "افزودن دارایی" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "مبلغ کل" })).toBeDefined());
  return container;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssetsManager - amount calculator toggle visibility", () => {
  it("shows the مقدار/مبلغ کل toggle for a new live-priced asset", async () => {
    await openCreateForm();
    expect(screen.getByRole("button", { name: "مقدار" })).toBeDefined();
    expect(screen.getByRole("button", { name: "مبلغ کل" })).toBeDefined();
  });

  it("does not show the toggle for the custom asset type", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: /سایر \(دستی\)/ }));
    expect(screen.queryByRole("button", { name: "مبلغ کل" })).toBeNull();
  });

  it("does not show the toggle when editing an existing asset", () => {
    render(<AssetsManager summary={{ ...emptySummary, assets: [goldAsset] }} />);
    fireEvent.click(screen.getByRole("button", { name: /^ویرایش/ }));
    expect(screen.queryByRole("button", { name: "مبلغ کل" })).toBeNull();
  });

  it("resets entryMode to quantity when switching type", async () => {
    await openCreateForm();

    fireEvent.click(screen.getByRole("button", { name: "مبلغ کل" }));
    expect(screen.getByText("مبلغ کل (تومان)")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /دلار/ }));
    expect(screen.queryByText("مبلغ کل (تومان)")).toBeNull();
    // The raw quantity label ("مقدار (دلار)") is back - distinct from the
    // still-present "مقدار" toggle button by role.
    expect(screen.getByText(/^مقدار \(دلار\)/)).toBeDefined();
  });
});

describe("AssetsManager - amount calculator computation", () => {
  it("shows the 'enter price first' message when price is empty", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "مبلغ کل" }));

    expect(screen.getByText("برای محاسبه، اول قیمت خرید را وارد کنید")).toBeDefined();
  });

  it("computes and displays the right quantity from a total amount and a purchase price", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "مبلغ کل" }));

    fireEvent.change(fieldAfterLabel("قیمت خرید (تومان، به ازای هر واحد)"), { target: { value: "5000000" } });
    fireEvent.change(fieldAfterLabel("مبلغ کل (تومان)"), { target: { value: "11750000" } });

    // 11,750,000 / 5,000,000 = 2.35 گرم (formatDecimal trims trailing zeros)
    expect(screen.getByText(/= ۲٫۳۵ گرم/)).toBeDefined();
  });

  it("sends the computed quantity, not the raw total amount, in the POST payload", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "مبلغ کل" }));

    fireEvent.change(fieldAfterLabel("قیمت خرید (تومان، به ازای هر واحد)"), { target: { value: "5000000" } });
    fireEvent.change(fieldAfterLabel("مبلغ کل (تومان)"), { target: { value: "11750000" } });

    const saveMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ asset: { id: 1 } }) });
    vi.stubGlobal("fetch", saveMock);

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith("/api/assets", expect.anything()));
    const [, requestInit] = saveMock.mock.calls[0];
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.quantity).toBe(2.35);
    expect(body).not.toHaveProperty("totalAmount");
  });
});

describe("AssetsManager - gold gram/milligram quantity unit", () => {
  it("only shows the گرم/میلی‌گرم toggle for gold", async () => {
    await openCreateForm(); // default type is gold
    expect(screen.getByRole("button", { name: "گرم" })).toBeDefined();
    expect(screen.getByRole("button", { name: "میلی‌گرم" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /دلار/ }));
    expect(screen.queryByRole("button", { name: "گرم" })).toBeNull();
    expect(screen.queryByRole("button", { name: "میلی‌گرم" })).toBeNull();
  });

  it("submits quantity 0.5 when 500 is typed with میلی‌گرم selected", async () => {
    const container = await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "میلی‌گرم" }));
    fireEvent.change(quantityInput(container), { target: { value: "500" } });
    fireEvent.change(fieldAfterLabel("قیمت خرید (تومان، به ازای هر واحد)"), { target: { value: "5000000" } });

    const saveMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ asset: { id: 1 } }) });
    vi.stubGlobal("fetch", saveMock);

    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith("/api/assets", expect.anything()));
    const [, requestInit] = saveMock.mock.calls[0];
    const body = JSON.parse((requestInit as RequestInit).body as string);
    expect(body.quantity).toBe(0.5);
  });

  it("does not alter the typed quantity value when toggling the unit", async () => {
    const container = await openCreateForm();
    fireEvent.change(quantityInput(container), { target: { value: "500" } });

    fireEvent.click(screen.getByRole("button", { name: "میلی‌گرم" }));
    expect(quantityInput(container).value).toBe("500");

    fireEvent.click(screen.getByRole("button", { name: "گرم" }));
    expect(quantityInput(container).value).toBe("500");
  });

  it("starts in gram mode showing the raw stored value when editing an existing gold asset", () => {
    const { container } = render(<AssetsManager summary={{ ...emptySummary, assets: [goldAsset] }} />);
    fireEvent.click(screen.getByRole("button", { name: /^ویرایش/ }));

    expect(screen.getByText("مقدار (گرم)")).toBeDefined();
    expect(quantityInput(container).value).toBe("2");
    // Gram is the active selection (primary-styled), not میلی‌گرم.
    expect(screen.getByRole("button", { name: "گرم" }).className).toMatch(/bg-primary/);
  });

  it("shows the amount-mode calculator result in میلی‌گرم when milligram is selected", async () => {
    await openCreateForm(); // default type is gold
    fireEvent.click(screen.getByRole("button", { name: "میلی‌گرم" }));
    fireEvent.click(screen.getByRole("button", { name: "مبلغ کل" }));

    fireEvent.change(fieldAfterLabel("قیمت خرید (تومان، به ازای هر واحد)"), { target: { value: "5000000" } });
    fireEvent.change(fieldAfterLabel("مبلغ کل (تومان)"), { target: { value: "11750000" } });

    // 11,750,000 / 5,000,000 = 2.35 گرم = 2350 میلی‌گرم.
    expect(screen.getByText(/= ۲٬۳۵۰ میلی‌گرم/)).toBeDefined();
  });
});

describe("AssetsManager - delete confirmation", () => {
  it("only sends DELETE after the second, confirming tap", async () => {
    const deleteMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", deleteMock);
    render(<AssetsManager summary={{ ...emptySummary, assets: [goldAsset] }} />);

    fireEvent.click(screen.getByRole("button", { name: /^ویرایش/ }));
    fireEvent.click(screen.getByRole("button", { name: "حذف دارایی" }));
    expect(deleteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/api/assets/1", { method: "DELETE" }));
  });

  it("backs out of the confirmation with انصراف without deleting", () => {
    const deleteMock = vi.fn();
    vi.stubGlobal("fetch", deleteMock);
    render(<AssetsManager summary={{ ...emptySummary, assets: [goldAsset] }} />);

    fireEvent.click(screen.getByRole("button", { name: /^ویرایش/ }));
    fireEvent.click(screen.getByRole("button", { name: "حذف دارایی" }));
    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));

    expect(screen.queryByRole("button", { name: "بله، حذف شود" })).toBeNull();
    expect(screen.getByRole("button", { name: "حذف دارایی" })).toBeDefined();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("offers no delete button on a new asset", async () => {
    await openCreateForm();
    expect(screen.queryByRole("button", { name: "حذف دارایی" })).toBeNull();
  });
});

describe("AssetsManager - purchase total preview", () => {
  it("shows quantity × price, converting milligrams to grams first", async () => {
    const container = await openCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "میلی‌گرم" }));
    fireEvent.change(quantityInput(container), { target: { value: "500" } });
    fireEvent.change(fieldAfterLabel("قیمت خرید (تومان، به ازای هر واحد)"), { target: { value: "5000000" } });

    // 500 میلی‌گرم = 0.5 گرم × 5,000,000 = 2,500,000.
    expect(screen.getByText("۲٬۵۰۰٬۰۰۰ تومان")).toBeDefined();
  });
});

describe("AssetsManager - portfolio summary", () => {
  it("shows the lifetime P/L as unknown, not ۰٪, while live prices are unavailable", () => {
    const unpricedGold = { ...goldAsset, currentValue: null, profitLossToman: null, profitLossPercent: null };
    render(
      <AssetsManager
        summary={{
          ...emptySummary,
          assets: [unpricedGold],
          totalValue: 10_000_000,
          totalCostBasis: 10_000_000,
          totalProfitLossPercent: 0,
          priceUnavailable: true,
        }}
      />
    );

    expect(screen.getByText("نامشخص")).toBeDefined();
    expect(screen.queryByText(/٪ سود/)).toBeNull();
  });

  it("labels allocation shares that always add up to ۱۰۰٪", () => {
    // 49.4 / 25.4 / 25.2 would round to 49 + 25 + 25 = 99 one slice at a time.
    const lotWorth = (id: number, type: string, value: number) => ({
      ...goldAsset,
      id,
      type,
      currentValue: value,
      costBasis: value,
      profitLossToman: 0,
      profitLossPercent: 0,
    });
    const assets = [lotWorth(1, "gold", 494), lotWorth(2, "usd", 254), lotWorth(3, "bitcoin", 252)];
    render(<AssetsManager summary={{ ...emptySummary, assets, totalValue: 1000, totalCostBasis: 1000 }} />);

    const legendPercents = screen
      .getByText("ترکیب سبد")
      .parentElement!.querySelectorAll("li > span:last-child");
    const total = [...legendPercents].reduce(
      (sum, el) => sum + Number(toLatinDigits(el.textContent!.replace("٪", ""))),
      0
    );
    expect(total).toBe(100);
  });
});
