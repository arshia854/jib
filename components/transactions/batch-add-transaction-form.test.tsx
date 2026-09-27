// @vitest-environment jsdom
//
// Component tests for batch mode (components/transactions/
// batch-add-transaction-form.tsx). Follows the same pattern as
// add-transaction-form.test.tsx - fake-indexeddb/auto for the offline
// queue (submitCreateTransaction, reused from transaction-form-shared.tsx,
// writes to it on every create submit), next/navigation mocked so
// router.push/refresh calls can be asserted.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listQueuedTransactions, deleteQueuedTransaction } from "@/lib/offline/transaction-queue";

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { BatchAddTransactionForm } from "@/components/transactions/batch-add-transaction-form";

const categories = [
  { id: 1, name: "سایر", icon: "📦", color: "#f00", type: "expense" },
  { id: 2, name: "حقوق", icon: "💰", color: "#0f0", type: "income" },
];

const accounts = [{ id: 1, name: "نقدی", type: "cash" }];

const ROW_PLACEHOLDER = "مثلاً: ۵۰ هزار تومن ناهار خوردم";

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

function renderBatchForm() {
  const onAccountIdChange = vi.fn();
  const onCategoriesChange = vi.fn();
  const onAccountsChange = vi.fn();
  render(
    <BatchAddTransactionForm
      categories={categories}
      accounts={accounts}
      accountId={1}
      onAccountIdChange={onAccountIdChange}
      onCategoriesChange={onCategoriesChange}
      onAccountsChange={onAccountsChange}
    />
  );
  return { onAccountIdChange, onCategoriesChange, onAccountsChange };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  pushMock.mockClear();
  refreshMock.mockClear();
  const leftover = await listQueuedTransactions();
  await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
});

describe("BatchAddTransactionForm - parsing", () => {
  it("parses multiple lines and shows a per-row error for the one that fails, without blocking the other", async () => {
    const fetchMock = vi.fn(async (url: unknown, options?: RequestInit) => {
      expect(url).toBe("/api/transactions/parse");
      const body = JSON.parse(options!.body as string);
      if (body.text.includes("قهوه")) {
        return { ok: true, status: 200, json: async () => ({ parsed: parsedTransaction({ description: "قهوه سرد" }) }) };
      }
      return { ok: false, status: 502, json: async () => ({ error: "خطا در پردازش خط دوم." }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBatchForm();

    const rowInputs = screen.getAllByPlaceholderText(ROW_PLACEHOLDER);
    expect(rowInputs).toHaveLength(2);
    fireEvent.change(rowInputs[0], { target: { value: "۵۰ هزار تومن قهوه خوردم" } });
    fireEvent.change(rowInputs[1], { target: { value: "این خط قرار است خطا بدهد" } });

    fireEvent.click(screen.getByRole("button", { name: "پردازش همه" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByDisplayValue("قهوه سرد")).toBeDefined();
    expect(await screen.findByText("خطا در پردازش خط دوم.")).toBeDefined();
  });
});

describe("BatchAddTransactionForm - row cap", () => {
  it("allows adding rows up to 5 and disables adding a 6th", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderBatchForm();

    expect(screen.getAllByPlaceholderText(ROW_PLACEHOLDER)).toHaveLength(2);

    const addButton = screen.getByRole("button", { name: /افزودن ردیف/ });
    fireEvent.click(addButton);
    fireEvent.click(addButton);
    fireEvent.click(addButton);
    expect(screen.getAllByPlaceholderText(ROW_PLACEHOLDER)).toHaveLength(5);

    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(addButton);
    expect(screen.getAllByPlaceholderText(ROW_PLACEHOLDER)).toHaveLength(5);
  });
});

describe("BatchAddTransactionForm - sequential submit", () => {
  // Description deliberately distinct from the row's own raw text (not
  // just echoing it back) - otherwise the row's raw-text input and the
  // parsed preview's description input would share the same display value,
  // and findByDisplayValue/getByDisplayValue can't tell them apart.
  async function parseTwoRowsSuccessfully() {
    const fetchMock = vi.fn(async (url: unknown, options?: RequestInit) => {
      const body = JSON.parse(options!.body as string);
      if (url === "/api/transactions/parse") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ parsed: parsedTransaction({ description: `پردازش‌شده: ${body.text}` }) }),
        };
      }
      throw new Error("unexpected fetch in parse phase: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rowInputs = screen.getAllByPlaceholderText(ROW_PLACEHOLDER);
    fireEvent.change(rowInputs[0], { target: { value: "ردیف اول موفق" } });
    fireEvent.change(rowInputs[1], { target: { value: "ردیف دوم شکست‌خورده" } });
    fireEvent.click(screen.getByRole("button", { name: "پردازش همه" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByDisplayValue("پردازش‌شده: ردیف اول موفق");
    await screen.findByDisplayValue("پردازش‌شده: ردیف دوم شکست‌خورده");
  }

  it("continues past a failing row - the other still succeeds, is removed, and navigation does not fire", async () => {
    renderBatchForm();
    await parseTwoRowsSuccessfully();

    let createCallCount = 0;
    const createFetchMock = vi.fn(async (url: unknown, options?: RequestInit) => {
      expect(url).toBe("/api/transactions");
      createCallCount += 1;
      const body = JSON.parse(options!.body as string);
      if (body.rawInput.includes("شکست")) {
        return { ok: false, status: 400, json: async () => ({ error: "دسته‌بندی نامعتبر است." }) };
      }
      return { ok: true, status: 201, json: async () => ({ transaction: { id: createCallCount }, asset: null }) };
    });
    vi.stubGlobal("fetch", createFetchMock);

    fireEvent.click(screen.getByRole("button", { name: "ثبت همه" }));

    await waitFor(() => expect(createFetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("دسته‌بندی نامعتبر است.")).toBeDefined();

    // The failed row's line is still there to fix/retry; the succeeded
    // row's line is gone.
    expect(screen.queryByDisplayValue("پردازش‌شده: ردیف اول موفق")).toBeNull();
    expect(screen.getByDisplayValue("پردازش‌شده: ردیف دوم شکست‌خورده")).toBeDefined();

    // Not all rows succeeded - stays on the page instead of navigating away.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("generates a distinct idempotency key per row and navigates away once every row succeeds", async () => {
    renderBatchForm();
    await parseTwoRowsSuccessfully();

    const idempotencyKeys: string[] = [];
    const createFetchMock = vi.fn(async (url: unknown, options?: RequestInit) => {
      expect(url).toBe("/api/transactions");
      const body = JSON.parse(options!.body as string);
      idempotencyKeys.push(body.idempotencyKey);
      return { ok: true, status: 201, json: async () => ({ transaction: { id: idempotencyKeys.length }, asset: null }) };
    });
    vi.stubGlobal("fetch", createFetchMock);

    fireEvent.click(screen.getByRole("button", { name: "ثبت همه" }));

    await waitFor(() => expect(createFetchMock).toHaveBeenCalledTimes(2));

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
    // A real UUID (crypto.randomUUID()), not e.g. both rows sharing one
    // static/derived value.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const key of idempotencyKeys) {
      expect(key).toMatch(uuidPattern);
    }

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/transactions"));
    expect(refreshMock).toHaveBeenCalled();
  });
});
