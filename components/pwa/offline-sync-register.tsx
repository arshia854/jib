"use client";

import { useEffect } from "react";
import { syncQueuedTransactions } from "@/lib/offline/sync-transactions";

// Drives the offline transaction queue's background retry (see
// lib/offline/sync-transactions.ts for why this is an `online`-event
// listener rather than the Background Sync API). Mounted once at the root
// layout, next to ServiceWorkerRegister - not scoped to
// /app/transactions, since a queued item written on that page should still
// sync while the user is elsewhere in the app, not only while that specific
// page happens to be open.
export function OfflineSyncRegister() {
  useEffect(() => {
    // Covers both "app opened while already online with items left over
    // from a previous offline session" and "app was offline at mount,
    // syncQueuedTransactions() itself just no-ops on a network failure and
    // schedules its own backoff retry" - no need to gate this on
    // navigator.onLine first.
    void syncQueuedTransactions();

    function handleOnline() {
      void syncQueuedTransactions();
    }
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  return null;
}
