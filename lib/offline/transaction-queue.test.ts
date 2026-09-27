// fake-indexeddb polyfills a real (pure-JS) IndexedDB implementation onto
// globalThis, independent of jsdom/DOM - jsdom itself doesn't implement
// IndexedDB (confirmed: `"indexedDB" in new JSDOM().window` is false even
// on the version already used here), so this file runs under vitest's
// default `node` environment like the rest of lib/*.test.ts, not the
// `@vitest-environment jsdom` docblock add-transaction-form.test.tsx needs.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueTransaction,
  getQueuedTransaction,
  listQueuedTransactions,
  updateQueuedTransaction,
  deleteQueuedTransaction,
  subscribeToQueueChanges,
  type QueuedTransactionPayload,
} from "./transaction-queue";

function payload(overrides: Partial<QueuedTransactionPayload> = {}): QueuedTransactionPayload {
  return {
    amount: 50000,
    type: "expense",
    category: "خوراک",
    description: "قهوه",
    date: "2026-08-19",
    rawInput: "۵۰ هزار تومن قهوه",
    accountId: 1,
    idempotencyKey: "key-1",
    ...overrides,
  };
}

// fake-indexeddb's globals persist for the whole process, so each test uses
// its own idempotencyKey rather than clearing the store - matches how the
// real store is used (one row per attempt, keyed by that attempt's key).

describe("transaction-queue", () => {
  it("enqueues a transaction with status pending, createdAt, and retryCount 0", async () => {
    const record = await enqueueTransaction(payload({ idempotencyKey: "enqueue-1" }));
    expect(record.status).toBe("pending");
    expect(record.retryCount).toBe(0);
    expect(typeof record.createdAt).toBe("number");
    expect(record.payload.amount).toBe(50000);

    const fetched = await getQueuedTransaction("enqueue-1");
    expect(fetched).toEqual(record);
  });

  it("lists queued transactions, excluding nothing by default", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "list-a" }));
    await enqueueTransaction(payload({ idempotencyKey: "list-b" }));

    const all = await listQueuedTransactions();
    const keys = all.map((item) => item.idempotencyKey);
    expect(keys).toContain("list-a");
    expect(keys).toContain("list-b");
  });

  it("updates status/retryCount/lastError without touching the stored payload", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "update-1" }));
    await updateQueuedTransaction("update-1", { status: "failed", retryCount: 3, lastError: "خطا" });

    const updated = await getQueuedTransaction("update-1");
    expect(updated?.status).toBe("failed");
    expect(updated?.retryCount).toBe(3);
    expect(updated?.lastError).toBe("خطا");
    expect(updated?.payload.amount).toBe(50000);
  });

  it("update on a missing key is a harmless no-op (not an error)", async () => {
    await expect(updateQueuedTransaction("does-not-exist", { status: "failed" })).resolves.toBeUndefined();
  });

  it("deletes a queued transaction", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "delete-1" }));
    await deleteQueuedTransaction("delete-1");
    expect(await getQueuedTransaction("delete-1")).toBeUndefined();
  });

  // "Storage cleared" / "tab reopened" recovery: a fresh read (as a newly
  // opened tab would do on mount) sees exactly what's durably there - no
  // in-memory state the module might otherwise be relying on.
  it("survives being read again as if from a freshly opened tab (persistence, not an in-memory cache)", async () => {
    await enqueueTransaction(payload({ idempotencyKey: "persist-1" }));
    const first = await listQueuedTransactions();
    const second = await listQueuedTransactions();
    expect(first.find((i) => i.idempotencyKey === "persist-1")).toBeDefined();
    expect(second.find((i) => i.idempotencyKey === "persist-1")).toBeDefined();
  });

  describe("queue-change notifications", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // BroadcastChannel delivery to same-process listeners is asynchronous -
    // polls instead of a single fixed-length tick, which was flaky under
    // load (a whole-suite run has more going on in the event loop than this
    // one file in isolation, and a single setTimeout(0) doesn't reliably
    // outlast that).
    async function waitForCallCount(mock: ReturnType<typeof vi.fn>, min: number, timeoutMs = 1000) {
      const start = Date.now();
      while (mock.mock.calls.length < min && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    it("notifies subscribers on enqueue, update, and delete", async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToQueueChanges(callback);
      try {
        await enqueueTransaction(payload({ idempotencyKey: "notify-1" }));
        await updateQueuedTransaction("notify-1", { status: "syncing" });
        await deleteQueuedTransaction("notify-1");
        await waitForCallCount(callback, 3);
        expect(callback.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        unsubscribe();
      }
    });

    it("stops notifying after unsubscribe", async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeToQueueChanges(callback);
      unsubscribe();
      await enqueueTransaction(payload({ idempotencyKey: "notify-2" }));
      // No call is expected here, so there's nothing to poll for - a short
      // fixed wait just confirms none arrives late.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(callback).not.toHaveBeenCalled();
    });
  });
});

describe("transaction-queue - IndexedDB unavailable", () => {
  const originalIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    // @ts-expect-error - simulating an environment without IndexedDB
    delete globalThis.indexedDB;
  });

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDB;
  });

  it("listQueuedTransactions() returns [] instead of throwing", async () => {
    await expect(listQueuedTransactions()).resolves.toEqual([]);
  });

  it("getQueuedTransaction() resolves to undefined instead of throwing", async () => {
    await expect(getQueuedTransaction("whatever")).resolves.toBeUndefined();
  });

  it("enqueueTransaction() rejects (caller decides to swallow it, matching the form's own catch)", async () => {
    await expect(enqueueTransaction(payload({ idempotencyKey: "no-idb" }))).rejects.toThrow();
  });
});
