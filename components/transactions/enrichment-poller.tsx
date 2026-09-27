"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const BASE_POLL_DELAY_MS = 3000;
const MAX_BACKOFF_DELAY_MS = 15000;
const MAX_TOTAL_POLL_MS = 90000;

// Keeps a transactions list "live" while at least one visible row is still
// waiting on background AI enrichment (Transaction.enrichmentStatus ===
// "pending" - see lib/workflows/enrich-transaction.ts, started from a
// "ثبت سریع" quick submit).
//
// Previously this ran a plain setInterval(() => router.refresh()), which
// re-ran the whole server render of the page on every tick - each render
// took 5-9s on its own, and since the 4s interval was shorter than that,
// refresh requests stacked up (~35 concurrent GETs observed) and polling
// kept going well after enrichment had actually already finished.
//
// This version instead polls a cheap, read-only status endpoint
// (GET /api/transactions/enrichment-status) with a self-scheduling
// setTimeout chain - the next poll is only scheduled once the previous
// fetch has settled, so requests never overlap - and only calls
// router.refresh() once, when the endpoint reports that at least one of
// the ids it was given is no longer pending (resolved, failed, or
// deleted). That refresh re-renders the server component that computes
// `pendingIds`, which naturally restarts this effect with a new (possibly
// empty) set if other rows are still pending.
export function EnrichmentPoller({ pendingIds }: { pendingIds: number[] }) {
  const router = useRouter();
  const pendingIdsKey = pendingIds.slice().sort((a, b) => a - b).join(",");

  useEffect(() => {
    if (!pendingIdsKey) return;

    const ids = pendingIdsKey.split(",");
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let delay = BASE_POLL_DELAY_MS;
    let inFlight = false;
    const deadline = Date.now() + MAX_TOTAL_POLL_MS;

    async function poll() {
      if (cancelled || inFlight) return;

      if (document.hidden) {
        schedule(delay);
        return;
      }

      inFlight = true;
      controller = new AbortController();
      try {
        const res = await fetch(`/api/transactions/enrichment-status?ids=${ids.join(",")}`, {
          signal: controller.signal,
          cache: "no-store",
        });

        if (cancelled) return;

        if (res.status === 401) {
          return;
        }

        if (!res.ok) {
          delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
          schedule(delay);
          return;
        }

        delay = BASE_POLL_DELAY_MS;
        const data: { pendingIds: number[] } = await res.json();
        const stillPending = new Set(data.pendingIds);
        const anyResolved = ids.some((id) => !stillPending.has(Number(id)));

        if (anyResolved) {
          router.refresh();
          return;
        }

        schedule(delay);
      } catch {
        if (cancelled) return;
        delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
        schedule(delay);
      } finally {
        inFlight = false;
      }
    }

    function schedule(nextDelay: number) {
      if (cancelled || Date.now() + nextDelay > deadline) return;
      timeoutId = setTimeout(poll, nextDelay);
    }

    function handleVisibilityChange() {
      if (!document.hidden && !cancelled) {
        if (timeoutId) clearTimeout(timeoutId);
        poll();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    poll();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timeoutId) clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [pendingIdsKey, router]);

  return null;
}
