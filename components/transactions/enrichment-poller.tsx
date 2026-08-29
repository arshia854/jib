"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 4000;

// Keeps a transactions list "live" while at least one visible row is still
// waiting on background AI enrichment (Transaction.enrichmentStatus ===
// "pending" - see lib/workflows/enrich-transaction.ts, started from a
// "ثبت سریع" quick submit). Plain setInterval(() => router.refresh())
// rather than reusing the offline queue's BroadcastChannel machinery
// (lib/offline/transaction-queue.ts) - that channel is for cross-tab
// notification of *this tab's own* queued writes, not for polling a
// *server-side* background job's progress, which has no client-side event
// to listen for in the first place.
//
// `hasPending` is computed by the server component that renders this, from
// the same transactions list it already fetched - each refresh() re-runs
// that server component, so this naturally stops polling on its own next
// render once no visible row is "pending" anymore (either enrichment
// succeeded, or it landed on "failed").
export function EnrichmentPoller({ hasPending }: { hasPending: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasPending, router]);

  return null;
}
