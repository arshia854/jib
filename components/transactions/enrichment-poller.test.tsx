// @vitest-environment jsdom
//
// Follows add-transaction-form.test.tsx's precedent as the second
// component test in the repo (jsdom scoped to this file only via the
// docblock above, same as there - see vitest.config.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { EnrichmentPoller } from "@/components/transactions/enrichment-poller";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function flush() {
  // vi.advanceTimersByTimeAsync(0) interleaves microtask flushing with fake
  // timers, which plain `await Promise.resolve()` chains don't reliably do
  // once fake timers are active - needed here so the fetch/json promise
  // chain inside the poller's effect actually settles before assertions.
  await vi.advanceTimersByTimeAsync(0);
}

describe("EnrichmentPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does nothing when there are no pending ids", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<EnrichmentPoller pendingIds={[]} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never overlaps requests: waits for a response before scheduling the next poll", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pendingIds: [1] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("calls router.refresh() exactly once when an id resolves, then stops", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pendingIds: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();

    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off (doubling, capped at 15s) on fetch failure and never refreshes", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First failure doubles the delay from 3000ms to 6000ms.
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second failure doubles again, to 12000ms.
    await vi.advanceTimersByTimeAsync(12000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops polling once the 90s total cap is reached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pendingIds: [1] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();

    for (let elapsed = 0; elapsed < 95000; elapsed += 3000) {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    }

    const callsAt95s = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(callsAt95s);
  });

  it("stops polling on a 401 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("aborts the in-flight fetch and clears timers on unmount", async () => {
    let abortedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      abortedSignal = init?.signal as AbortSignal;
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(abortedSignal?.aborted).toBe(false);

    unmount();
    expect(abortedSignal?.aborted).toBe(true);
  });

  it("skips scheduling while the tab is hidden, and checks immediately on becoming visible", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pendingIds: [1] }));
    vi.stubGlobal("fetch", fetchMock);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a second overlapping poll if visibilitychange fires while a fetch is already in flight", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<EnrichmentPoller pendingIds={[1]} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a quick visible -> hidden -> visible flicker while the first
    // fetch is still pending: handleVisibilityChange must not start a
    // second poll() chain on top of the one still in flight.
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
