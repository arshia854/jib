"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listQueuedTransactions,
  subscribeToQueueChanges,
  type QueuedTransaction,
} from "@/lib/offline/transaction-queue";
import { retryQueuedTransactionNow } from "@/lib/offline/sync-transactions";
import { TransactionRow } from "./transaction-row";
import { SpinnerIcon, AlertIcon } from "@/components/icons";

interface CategoryOption {
  id: number;
  name: string;
  icon: string;
  color: string;
  type: string;
}

const FALLBACK_CATEGORY = { icon: "🏷️", color: "#a1a1aa" };

// Renders the locally-queued (not-yet-server-confirmed) transactions from
// lib/offline/transaction-queue.ts above app/app/transactions/page.tsx's
// normal, server-rendered list - the "optimistic, visually distinct
// pending entry" this task's brief asks for. A client component wrapping a
// server-fetched `categories` prop rather than fetching its own, since the
// page already loads that list for the filter bar - no second request.
export function PendingTransactionList({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [items, setItems] = useState<QueuedTransaction[]>([]);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  // Tracks the previous render's queue keys so refresh() can tell "an item
  // that used to be queued just disappeared" (synced) apart from "nothing
  // changed" - the trigger for router.refresh() below, which is what
  // actually reconciles the optimistic row into the real, server-rendered
  // transaction once it exists.
  const previousKeysRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    listQueuedTransactions()
      .then((all) => {
        const pending = all.filter((item) => item.status !== "synced");
        const previousKeys = previousKeysRef.current;
        const nowKeys = new Set(pending.map((item) => item.idempotencyKey));
        const anySynced = [...previousKeys].some((key) => !nowKeys.has(key));
        previousKeysRef.current = nowKeys;
        setItems(pending);
        if (anySynced) router.refresh();
      })
      .catch(() => setItems([]));
  }, [router]);

  useEffect(() => {
    refresh();
    return subscribeToQueueChanges(refresh);
  }, [refresh]);

  async function handleRetry(idempotencyKey: string) {
    setRetryingKey(idempotencyKey);
    try {
      await retryQueuedTransactionNow(idempotencyKey);
    } finally {
      setRetryingKey(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <div className="rounded-2xl border border-dashed border-accent/40 bg-accent/5 px-4">
      {items.map((item, i) => {
        const category = categories.find(
          (c) => c.name === item.payload.category && c.type === item.payload.type
        ) ?? { name: item.payload.category, ...FALLBACK_CATEGORY };

        return (
          <div key={item.idempotencyKey} className={i > 0 ? "border-t border-border/60" : ""}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 opacity-70">
                <TransactionRow
                  description={item.payload.description ?? null}
                  rawInput={item.payload.rawInput}
                  date={new Date(item.payload.date)}
                  amount={item.payload.amount}
                  type={item.payload.type}
                  category={category}
                />
              </div>
              {item.status === "failed" ? (
                <button
                  type="button"
                  onClick={() => handleRetry(item.idempotencyKey)}
                  disabled={retryingKey === item.idempotencyKey}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-warning px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {retryingKey === item.idempotencyKey ? (
                    <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "تلاش دوباره"
                  )}
                </button>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-accent">
                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  در حال همگام‌سازی
                </span>
              )}
            </div>
            {item.status === "failed" && item.lastError && (
              <p className="flex items-center gap-1 pb-2 text-xs text-warning">
                <AlertIcon className="h-3.5 w-3.5 shrink-0" />
                {item.lastError}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
