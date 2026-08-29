// @vitest-environment jsdom
//
// This is the first component test in the repo - there's no existing
// component-test pattern to follow (only lib/ and API-route unit tests, all
// running under the default `node` environment - see vitest.config.ts). The
// `@vitest-environment jsdom` docblock above scopes jsdom to just this file
// so the rest of the suite keeps running under `node`, and
// @testing-library/react/@testing-library/dom/jsdom were added as
// devDependencies to support it.
//
// fake-indexeddb/auto polyfills IndexedDB, which jsdom itself doesn't
// implement (see lib/offline/transaction-queue.test.ts's own comment) -
// needed here because saveTransaction() now writes to the offline queue
// (lib/offline/transaction-queue.ts) on every create submit.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listQueuedTransactions, deleteQueuedTransaction } from "@/lib/offline/transaction-queue";

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

describe("AddTransactionForm - confidence-aware confirmation hint (Phase 8)", () => {
  function renderPreview(overrides: Partial<ParsedTransaction>) {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={parsedTransaction(overrides)}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );
  }

  it("shows the low-confidence hint when categorizationConfidence is low", () => {
    renderPreview({ needsConfirmation: true, categorizationConfidence: "low" });
    expect(screen.getByText("دسته‌بندی را مطمئن نیستم، لطفاً خودت انتخاب کن")).toBeDefined();
  });

  it("shows the existing softer hint when categorizationConfidence is medium", () => {
    renderPreview({ needsConfirmation: true, categorizationConfidence: "medium" });
    expect(screen.getByText("دسته‌بندی پیشنهادی است، لطفاً بررسی کنید")).toBeDefined();
  });

  it("shows the bank-sms hint regardless of categorizationConfidence", () => {
    renderPreview({ needsConfirmation: true, source: "bank-sms", categorizationConfidence: "low" });
    expect(screen.getByText("چی خریدی؟ کمکم کن درست دسته‌بندی‌ش کنم 🙂")).toBeDefined();
  });

  it("shows no confirmation hint at all when needsConfirmation is false", () => {
    renderPreview({ needsConfirmation: false, categorizationConfidence: "high" });
    expect(screen.queryByText(/دسته‌بندی را مطمئن نیستم/)).toBeNull();
    expect(screen.queryByText(/دسته‌بندی پیشنهادی است/)).toBeNull();
  });
});

describe("AddTransactionForm - offline transaction queue", () => {
  // Skips straight to the "preview" stage with a ready-to-submit
  // transaction (same mechanism the chat assistant's "ویرایش کن" handoff
  // uses - see app/app/add/page.tsx's parseSuggestionParams) - these tests
  // are about saveTransaction()'s queue behavior, not the parse flow
  // already covered above.
  const initialTransaction = parsedTransaction();

  afterEach(async () => {
    // The IndexedDB store is module-level (like the real one) and persists
    // across tests in this file - clear it so one test's leftover queued
    // item can't be counted by the next test's assertions.
    const leftover = await listQueuedTransactions();
    await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
  });

  function renderReadyToSubmit() {
    render(
      <AddTransactionForm
        categories={categories}
        accounts={accounts}
        defaultAccountId={1}
        initialTransaction={initialTransaction}
        initialRawInput="۵۰ هزار تومن قهوه"
      />
    );
  }

  it("queues the transaction and shows no inline error when the network is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    await waitFor(async () => {
      const queued = await listQueuedTransactions();
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("pending");
      expect(queued[0].payload.amount).toBe(initialTransaction.amount);
      expect(queued[0].payload.category).toBe(initialTransaction.category);
    });
    // The offline case is treated as an optimistic success (see
    // saveTransaction()'s own comment) - no inline error banner, unlike the
    // server-rejection case below.
    expect(screen.queryByText("خطای ناشناخته رخ داد.")).toBeNull();
  });

  it("removes the queued item once the server confirms the create (online, happy path unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 1 } }) })
    );
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    await waitFor(async () => {
      expect(await listQueuedTransactions()).toHaveLength(0);
    });
  });

  it("removes the queued item and still shows the inline error on a real server-side rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "دسته‌بندی نامعتبر است." }) })
    );
    renderReadyToSubmit();

    fireEvent.click(screen.getByRole("button", { name: "تأیید و ذخیره" }));

    expect(await screen.findByText("دسته‌بندی نامعتبر است.")).toBeDefined();
    await waitFor(async () => {
      expect(await listQueuedTransactions()).toHaveLength(0);
    });
  });
});
