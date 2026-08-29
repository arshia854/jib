// @vitest-environment jsdom
// See add-transaction-form.test.tsx's own comment on fake-indexeddb/auto
// and the jsdom scoping.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  enqueueTransaction,
  listQueuedTransactions,
  deleteQueuedTransaction,
  type QueuedTransactionPayload,
} from "@/lib/offline/transaction-queue";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

import { PendingTransactionList } from "@/components/transactions/pending-transaction-list";

const categories = [
  { id: 1, name: "خوراک", icon: "🍔", color: "#f00", type: "expense" },
  { id: 2, name: "حقوق", icon: "💰", color: "#0f0", type: "income" },
];

function payload(overrides: Partial<QueuedTransactionPayload> = {}): QueuedTransactionPayload {
  return {
    amount: 50000,
    type: "expense",
    category: "خوراک",
    description: "قهوه",
    date: "2026-08-19",
    rawInput: "۵۰ هزار تومن قهوه",
    accountId: 1,
    idempotencyKey: `key-${Math.random()}`,
    ...overrides,
  };
}

afterEach(async () => {
  cleanup();
  refreshMock.mockClear();
  const leftover = await listQueuedTransactions();
  await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
});

describe("PendingTransactionList", () => {
  it("renders nothing when the queue is empty", async () => {
    const { container } = render(<PendingTransactionList categories={categories} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("shows a pending item with a syncing indicator, resolving its category from the categories prop", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "pending-1", description: "قهوه" }));

    render(<PendingTransactionList categories={categories} />);

    expect(await screen.findByText("قهوه")).toBeDefined();
    expect(screen.getByText("در حال همگام‌سازی")).toBeDefined();
    // No retry button for a plain pending item - that's failed-only.
    expect(screen.queryByRole("button", { name: "تلاش دوباره" })).toBeNull();
  });

  it("shows a retry button and the last error for a failed item, and clears it on successful retry", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "failed-1", description: "بلیط اتوبوس" }));
    const item = (await listQueuedTransactions())[0];
    await import("@/lib/offline/transaction-queue").then(({ updateQueuedTransaction }) =>
      updateQueuedTransaction(item.idempotencyKey, { status: "failed", lastError: "حساب نامعتبر است." })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 9 } }) })
    );

    render(<PendingTransactionList categories={categories} />);

    expect(await screen.findByText("حساب نامعتبر است.")).toBeDefined();
    const retryButton = screen.getByRole("button", { name: "تلاش دوباره" });

    fireEvent.click(retryButton);

    await waitFor(() => expect(screen.queryByText("بلیط اتوبوس")).toBeNull());
    // A successful sync means the confirmed transactions list (server data)
    // now has a row the pending list didn't know about before - refresh()
    // is what pulls it in.
    expect(refreshMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("falls back to a generic label when the queued category no longer matches any known category", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "unknown-cat", category: "دسته‌ی حذف‌شده" }));

    render(<PendingTransactionList categories={categories} />);

    // TransactionRow renders "{category.name} · {date}" as one paragraph -
    // a regex match against the category name substring, not an exact
    // match against the whole (date-suffixed) text.
    expect(await screen.findByText(/دسته‌ی حذف‌شده/)).toBeDefined();
  });
});
