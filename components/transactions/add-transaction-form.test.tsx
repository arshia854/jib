// @vitest-environment jsdom
//
// This is the first component test in the repo - there's no existing
// component-test pattern to follow (only lib/ and API-route unit tests, all
// running under the default `node` environment - see vitest.config.ts). The
// `@vitest-environment jsdom` docblock above scopes jsdom to just this file
// so the rest of the suite keeps running under `node`, and
// @testing-library/react/@testing-library/dom/jsdom were added as
// devDependencies to support it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AddTransactionForm } from "@/components/transactions/add-transaction-form";

const categories = [
  { id: 1, name: "خوراک", icon: "🍔", color: "#f00", type: "expense" },
  { id: 2, name: "حقوق", icon: "💰", color: "#0f0", type: "income" },
];

const accounts = [{ id: 1, name: "نقدی", type: "cash" }];

function parsedTransaction(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    amount: 50000,
    type: "expense",
    category: "سایر",
    description: "قهوه",
    date: "2026-08-06",
    source: "ai",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddTransactionForm - inline live preview", () => {
  it("renders the \"suggested new category\" prompt when the parse result includes one", async () => {
    const parsed = parsedTransaction({
      suggestedCategory: { name: "قهوه", parentName: null, reason: "خرید قهوه", icon: "☕" },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ parsed }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: "پردازش" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/transactions/parse", expect.anything()));

    expect(await screen.findByText(/براش پیدا نشد — می‌خوای/)).toBeDefined();
    expect(screen.getByRole("button", { name: "بساز" })).toBeDefined();
  });

  it("does not render the prompt when the parse result has no suggested category", async () => {
    const parsed = parsedTransaction();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ parsed }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddTransactionForm categories={categories} accounts={accounts} defaultAccountId={1} />);

    fireEvent.change(screen.getByPlaceholderText("مثلاً: ۵۰ هزار تومن ناهار خوردم"), {
      target: { value: "۵۰ هزار تومن قهوه خوردم" },
    });
    fireEvent.click(screen.getByRole("button", { name: "پردازش" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await screen.findByText(/پیش‌نمایش هوش مصنوعی/);

    expect(screen.queryByText(/براش پیدا نشد — می‌خوای/)).toBeNull();
  });
});
