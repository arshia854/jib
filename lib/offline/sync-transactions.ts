// Background retry for the offline transaction queue (lib/offline/
// transaction-queue.ts). Retried via an `online` event listener + in-tab
// backoff timers, NOT the Background Sync API (`registration.sync.register`).
//
// Why not Background Sync API: it would be the more "textbook" PWA answer,
// but it's Chromium-only (Chrome/Edge/Samsung Internet/Opera) - notably
// unsupported in Safari and Firefox, on both desktop and iOS. This app's own
// manifest/layout already commit to iOS PWA support (`appleWebApp: {
// capable: true, ... }` in app/layout.tsx, plus the maskable/apple icon set
// in app/manifest.ts) - a sync mechanism that silently never fires for every
// iOS user (a large share of any real Iranian mobile user base) isn't a
// reliable primary path for a finance app's data integrity feature. The
// `online` event + foreground backoff retry fallback the task's own brief
// names is universally supported and is used here as the *only* mechanism,
// not a secondary fallback - see components/pwa/offline-sync-register.tsx
// for where it's wired up. The tradeoff this accepts: a tab that's fully
// closed while offline won't sync until it's reopened (covered - see that
// component and the queue's own persistence) rather than syncing silently
// in the background the way Background Sync API could on supporting
// browsers. Documented here rather than left implicit, per this task's own
// instruction to state the reasoning.

import {
  listQueuedTransactions,
  getQueuedTransaction,
  updateQueuedTransaction,
  deleteQueuedTransaction,
  type QueuedTransactionPayload,
} from "./transaction-queue";

// Exported so tests can reference it instead of duplicating the number
// (same precedent as MAX_STORE_SIZE in lib/rate-limit.ts).
export const MAX_AUTO_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

function backoffDelayMs(retryCount: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** retryCount, MAX_RETRY_DELAY_MS);
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: "network" }
  | { ok: false; reason: "server"; message: string };

// The one place that actually calls POST /api/transactions for a queued
// item - used both by the immediate foreground attempt path (indirectly;
// add-transaction-form.tsx has its own inline fetch for that, see its own
// comment on why) and every retry here. Deliberately has no special case for
// "the server already has this one" (SEC-10 idempotent replay): a retry that
// reaches a request the server actually processed the first time gets back
// the exact same 201 + { transaction } shape as a fresh create (see
// createTransaction() in lib/data/transactions.ts) - from here, that's
// indistinguishable from - and exactly as good as - success.
export async function attemptSubmitTransaction(payload: QueuedTransactionPayload): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // fetch() rejects (TypeError) on a connectivity failure - the one
    // signal this module treats as "retry later", never as "give up".
    return { ok: false, reason: "network" };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      reason: "server",
      message: typeof data?.error === "string" ? data.error : "خطا در ذخیره تراکنش.",
    };
  }
  return { ok: true };
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearScheduledRetry(idempotencyKey: string): void {
  const timer = retryTimers.get(idempotencyKey);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(idempotencyKey);
  }
}

function scheduleRetry(idempotencyKey: string, delayMs: number): void {
  clearScheduledRetry(idempotencyKey);
  const timer = setTimeout(() => {
    retryTimers.delete(idempotencyKey);
    void syncOne(idempotencyKey);
  }, delayMs);
  retryTimers.set(idempotencyKey, timer);
}

// Attempts (or re-attempts) exactly one queued item. Not exported - callers
// go through syncQueuedTransactions() (the reconnect/mount sweep) or
// retryQueuedTransactionNow() (the manual "تلاش دوباره" button), both of
// which know *which* item(s) they mean; this is just the shared single-item
// logic between them.
async function syncOne(idempotencyKey: string): Promise<void> {
  const item = await getQueuedTransaction(idempotencyKey);
  // Already gone (synced/deleted by another tab or a racing call) or
  // already in flight - nothing to do.
  if (!item || item.status === "syncing" || item.status === "synced") return;

  await updateQueuedTransaction(idempotencyKey, { status: "syncing" });
  const result = await attemptSubmitTransaction(item.payload);

  if (result.ok) {
    await deleteQueuedTransaction(idempotencyKey);
    return;
  }

  if (result.reason === "network") {
    const retryCount = item.retryCount + 1;
    if (retryCount > MAX_AUTO_RETRIES) {
      // Stop auto-retrying and surface it - a manual retry
      // (retryQueuedTransactionNow) resets the counter and tries again.
      await updateQueuedTransaction(idempotencyKey, {
        status: "failed",
        retryCount,
        lastError: "اتصال اینترنت برقرار نشد. بعداً دوباره تلاش کنید.",
      });
      return;
    }
    await updateQueuedTransaction(idempotencyKey, { status: "pending", retryCount });
    scheduleRetry(idempotencyKey, backoffDelayMs(retryCount));
    return;
  }

  // A real server-side rejection (validation/auth) - retrying the exact
  // same payload again won't succeed on its own, so this doesn't
  // auto-retry; it's surfaced for the user to act on (edit the underlying
  // account/category state, then hit "تلاش دوباره").
  await updateQueuedTransaction(idempotencyKey, { status: "failed", retryCount: item.retryCount, lastError: result.message });
}

// The reconnect/mount sweep - reads every retryable item and attempts each
// in turn (sequentially, not in parallel: this is a low-volume personal
// queue, not a throughput-sensitive job, and sequential keeps concurrent-
// request bookkeeping simple). Called from
// components/pwa/offline-sync-register.tsx on mount and on the `online`
// event; safe to call redundantly/concurrently from multiple triggers -
// syncOne() no-ops on anything already "syncing".
export async function syncQueuedTransactions(): Promise<void> {
  const items = await listQueuedTransactions();
  const retryable = items.filter((item) => item.status === "pending" || item.status === "failed");
  for (const item of retryable) {
    clearScheduledRetry(item.idempotencyKey);
    await syncOne(item.idempotencyKey);
  }
}

// The manual "تلاش دوباره" affordance (components/transactions/
// pending-transaction-list.tsx) for an item that's exhausted its automatic
// retries or was rejected server-side. Explicit user action, so it gets a
// fresh retry budget rather than picking up where the automatic count left
// off.
export async function retryQueuedTransactionNow(idempotencyKey: string): Promise<void> {
  clearScheduledRetry(idempotencyKey);
  await updateQueuedTransaction(idempotencyKey, { retryCount: 0 });
  await syncOne(idempotencyKey);
}

// Test-only cleanup - not used by any production code path. A test that
// triggers a network-failure retry schedules a real setTimeout (seconds to
// minutes out via backoffDelayMs); without clearing it, that timer would
// keep firing (and calling whatever fetch mock a *later* test has stubbed
// in) well after the test that scheduled it has finished.
export function __clearScheduledRetriesForTests(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}
