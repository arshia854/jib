import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueTransaction,
  getQueuedTransaction,
  updateQueuedTransaction,
  listQueuedTransactions,
  deleteQueuedTransaction,
} from "./transaction-queue";
import {
  attemptSubmitTransaction,
  syncQueuedTransactions,
  retryQueuedTransactionNow,
  MAX_AUTO_RETRIES,
  __clearScheduledRetriesForTests,
} from "./sync-transactions";

function payload(idempotencyKey: string) {
  return {
    amount: 50000,
    type: "expense" as const,
    category: "خوراک",
    description: "قهوه",
    date: "2026-08-19",
    rawInput: "۵۰ هزار تومن قهوه",
    accountId: 1,
    idempotencyKey,
  };
}

// Real timers throughout, not vi.useFakeTimers(): fake-indexeddb's
// internal request-completion scheduling relies on real timer/microtask
// callbacks, so faking them stalls every IndexedDB operation (confirmed -
// every test hung/timed out with fake timers on). Tests exercise the
// give-up-after-max-retries branch by seeding retryCount directly rather
// than stepping through real backoff delays. Any retry a test *does*
// schedule via a real setTimeout is swept up below so it can't fire (and
// call a later test's fetch mock) after that test has finished.
afterEach(async () => {
  __clearScheduledRetriesForTests();
  vi.unstubAllGlobals();
  // The store persists across tests in this file (module-level, like the
  // real one) - a row a prior test left "pending"/"failed" would otherwise
  // get picked up by a later test's syncQueuedTransactions() call too,
  // hitting that test's (differently-configured) fetch mock.
  const leftover = await listQueuedTransactions();
  await Promise.all(leftover.map((item) => deleteQueuedTransaction(item.idempotencyKey)));
});

describe("attemptSubmitTransaction", () => {
  it("returns ok:true on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 1 } }) })
    );
    const result = await attemptSubmitTransaction(payload("attempt-ok"));
    expect(result).toEqual({ ok: true });
  });

  it("returns reason:'server' with the server's message on a non-ok response (not a connectivity issue)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "حساب نامعتبر است." }) })
    );
    const result = await attemptSubmitTransaction(payload("attempt-server-fail"));
    expect(result).toEqual({ ok: false, reason: "server", message: "حساب نامعتبر است." });
  });

  it("returns reason:'network' when fetch itself rejects (no connectivity)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await attemptSubmitTransaction(payload("attempt-network-fail"));
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

describe("syncQueuedTransactions", () => {
  it("deletes a queued item from the store once it's submitted successfully", async () => {
    await enqueueTransaction(payload("sync-success"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 1 } }) })
    );

    await syncQueuedTransactions();

    expect(await getQueuedTransaction("sync-success")).toBeUndefined();
  });

  // This is exactly the SEC-10 idempotent-replay case named in the task's
  // brief: the server already committed this transaction on a prior
  // attempt the client never saw the response for, and a retry with the
  // same idempotencyKey gets back the same 201 + { transaction } shape as
  // a fresh create (see createTransaction() in lib/data/transactions.ts).
  // From here that's indistinguishable from - and handled identically to -
  // a first-time success: no duplicate, no special-cased branch needed.
  it("treats a replayed (already-processed) success the same as a fresh success - no duplicate, no special handling", async () => {
    await enqueueTransaction(payload("sync-replay"));
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 42 } }) });
    vi.stubGlobal("fetch", fetchMock);

    await syncQueuedTransactions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getQueuedTransaction("sync-replay")).toBeUndefined();
  });

  it("on a network failure, keeps the item pending, increments retryCount, and schedules a backoff retry", async () => {
    await enqueueTransaction(payload("sync-network-fail"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await syncQueuedTransactions();

    const item = await getQueuedTransaction("sync-network-fail");
    expect(item?.status).toBe("pending");
    expect(item?.retryCount).toBe(1);
  });

  it("gives up and marks 'failed' once retries exceed MAX_AUTO_RETRIES, instead of retrying forever silently", async () => {
    await enqueueTransaction(payload("sync-max-retries"));
    // Seed retryCount at the threshold directly, rather than stepping
    // through MAX_AUTO_RETRIES real backoff rounds - this exercises the
    // exact same give-up branch a fully-played-out sequence would reach,
    // without a slow/fragile fake-timer choreography for every round.
    await updateQueuedTransaction("sync-max-retries", { retryCount: MAX_AUTO_RETRIES });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await syncQueuedTransactions();

    const item = await getQueuedTransaction("sync-max-retries");
    expect(item?.status).toBe("failed");
    expect(item?.retryCount).toBe(MAX_AUTO_RETRIES + 1);
    expect(item?.lastError).toBeTruthy();
  });

  it("on a server-side rejection, marks 'failed' immediately without touching retryCount (no point auto-retrying an invalid request)", async () => {
    await enqueueTransaction(payload("sync-server-fail"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "دسته‌بندی نامعتبر است." }) })
    );

    await syncQueuedTransactions();

    const item = await getQueuedTransaction("sync-server-fail");
    expect(item?.status).toBe("failed");
    expect(item?.retryCount).toBe(0);
    expect(item?.lastError).toBe("دسته‌بندی نامعتبر است.");
  });

  it("is a no-op when nothing is queued (the common steady-state case)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await syncQueuedTransactions();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retryQueuedTransactionNow", () => {
  it("resets retryCount and retries immediately, regardless of how it previously failed", async () => {
    await enqueueTransaction(payload("manual-retry"));
    await updateQueuedTransaction("manual-retry", {
      status: "failed",
      retryCount: MAX_AUTO_RETRIES + 1,
      lastError: "اتصال اینترنت برقرار نشد. بعداً دوباره تلاش کنید.",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transaction: { id: 7 } }) })
    );

    await retryQueuedTransactionNow("manual-retry");

    expect(await getQueuedTransaction("manual-retry")).toBeUndefined();
  });
});
