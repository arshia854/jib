// Offline transaction queue - IndexedDB-backed storage for a transaction
// create request that couldn't reach the server yet (see
// components/transactions/add-transaction-form.tsx's saveTransaction() for
// the write side and lib/offline/sync-transactions.ts for the retry side).
//
// Deliberately raw `indexedDB` rather than a wrapper library (`idb` etc.) -
// this codebase has no IndexedDB usage or dependency footprint for it today,
// and the actual surface area needed here (open one store, get/put/delete/
// getAll by the one keyPath) is small enough that a real dependency isn't
// justified. `localStorage` was ruled out per this task's own brief: it's
// synchronous, string-only, and size-limited, none of which fit a queue of
// full transaction payloads plus retry metadata.
//
// Client-only by nature (indexedDB doesn't exist server-side) - every export
// here checks for it and degrades to a no-op/empty result rather than
// throwing, the same progressive-enhancement precedent already established
// by components/pwa/service-worker-register.tsx's registration failure
// handling. Callers (the form, the pending-list UI, the sync module) never
// need to check availability themselves.

import type { CategoryType } from "@/lib/categories";

const DB_NAME = "jib-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "transactions";
const BROADCAST_CHANNEL_NAME = "jib-transaction-queue";

export type QueuedTransactionStatus = "pending" | "syncing" | "failed" | "synced";

// Mirrors exactly the POST /api/transactions body built in
// add-transaction-form.tsx's saveTransaction() - not a new/parallel shape,
// so a retried request is byte-for-byte what would have been sent had the
// connection been up the first time.
export interface QueuedTransactionPayload {
  amount: number;
  type: CategoryType;
  category: string;
  description?: string;
  date: string;
  rawInput: string;
  accountId: number;
  // SEC-10's idempotency key - also this record's IndexedDB keyPath (see
  // STORE_NAME below), so there's exactly one queued row per submit attempt
  // and a duplicate enqueueTransaction() call for the same attempt (e.g. a
  // re-render) overwrites rather than doubling up.
  idempotencyKey: string;
  source?: "assistant-suggestion";
  // "ثبت سریع" (quick submit, see add-transaction-form.tsx's
  // handleQuickSubmit()) - forwarded as-is on every retry
  // (lib/offline/sync-transactions.ts sends this payload verbatim), so a
  // quick-submit made while offline still triggers background AI
  // enrichment once it actually reaches the server.
  quick?: boolean;
}

export interface QueuedTransaction {
  idempotencyKey: string;
  payload: QueuedTransactionPayload;
  status: QueuedTransactionStatus;
  createdAt: number;
  retryCount: number;
  lastError?: string;
}

function isSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!isSupported()) {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, mode);
  const store = tx.objectStore(STORE_NAME);
  return requestToPromise(fn(store));
}

// Written immediately on submit, before the network attempt - see
// saveTransaction()'s own comment on why this ordering matters (a tab
// closed mid-request must still have the item recorded when it reopens).
export async function enqueueTransaction(payload: QueuedTransactionPayload): Promise<QueuedTransaction> {
  const record: QueuedTransaction = {
    idempotencyKey: payload.idempotencyKey,
    payload,
    status: "pending",
    createdAt: Date.now(),
    retryCount: 0,
  };
  await withStore("readwrite", (store) => store.put(record));
  notifyQueueChanged();
  return record;
}

export async function getQueuedTransaction(idempotencyKey: string): Promise<QueuedTransaction | undefined> {
  if (!isSupported()) return undefined;
  return withStore("readonly", (store) => store.get(idempotencyKey));
}

// Returns [] rather than throwing when IndexedDB is unavailable/storage was
// cleared - the pending-list UI renders nothing in that case instead of
// crashing, which is the correct behavior: there's genuinely nothing queued
// that this tab can see.
export async function listQueuedTransactions(): Promise<QueuedTransaction[]> {
  if (!isSupported()) return [];
  try {
    return await withStore("readonly", (store) => store.getAll());
  } catch {
    return [];
  }
}

export async function updateQueuedTransaction(
  idempotencyKey: string,
  patch: Partial<Pick<QueuedTransaction, "status" | "retryCount" | "lastError">>
): Promise<void> {
  const existing = await getQueuedTransaction(idempotencyKey);
  if (!existing) return;
  const updated: QueuedTransaction = { ...existing, ...patch };
  await withStore("readwrite", (store) => store.put(updated));
  notifyQueueChanged();
}

export async function deleteQueuedTransaction(idempotencyKey: string): Promise<void> {
  if (!isSupported()) return;
  await withStore("readwrite", (store) => store.delete(idempotencyKey));
  notifyQueueChanged();
}

// Cross-component (same tab) change notification, so the pending-list UI
// re-renders when the form enqueues a new item or the sync module updates
// one - IndexedDB itself has no built-in change events. BroadcastChannel
// (not a custom event on `window`) also naturally reaches other same-origin
// tabs, which matters here: two tabs both showing /app/transactions should
// both drop a pending row once either of them (or a background retry in
// either) actually syncs it.
//
// Deliberately NOT a single shared channel instance for both sending and
// listening: per the BroadcastChannel spec, an instance never receives its
// own postMessage() - only *other* instances of the same name do, even
// within the same tab. A shared singleton would mean a component's own
// notifyQueueChanged() call (e.g. the form enqueuing an item) could never
// be observed by that same tab's own subscribeToQueueChanges() listener if
// it happened to reuse that identical object. One dedicated sender channel
// plus one fresh receiver channel per subscription sidesteps that.
let senderChannel: BroadcastChannel | null = null;
function getSenderChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!senderChannel) senderChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  return senderChannel;
}

export function notifyQueueChanged(): void {
  getSenderChannel()?.postMessage("changed");
}

// Returns an unsubscribe function, matching the useEffect cleanup idiom.
export function subscribeToQueueChanges(callback: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  const handler = () => callback();
  ch.addEventListener("message", handler);
  return () => {
    ch.removeEventListener("message", handler);
    ch.close();
  };
}
