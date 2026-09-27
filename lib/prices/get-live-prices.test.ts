import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn() }));

import { getLivePrices, LivePriceUnavailableError } from "@/lib/prices/get-live-prices";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

function stubEnv() {
  vi.stubEnv("NERKH_API_KEY", "test-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Three separate GET calls (one per symbol - see get-live-prices.ts's own
// "UNVERIFIED, best-effort" comment on why this fixture, not a real
// captured response, is what these tests assert against). This mock
// dispatches a flat `{ data: { current } }` body per URL, keyed by which
// nerkh.io category/symbol path was requested.
function mockNerkhFetch(prices: { gold: number; usd: number; btc: number }) {
  return vi.fn().mockImplementation((url: string) => {
    const body = url.includes("/gold/")
      ? { data: { current: prices.gold } }
      : url.includes("/currency/")
        ? { data: { current: prices.usd } }
        : { data: { current: prices.btc } };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

function fakeClient(overrides: { cached?: unknown; upsert?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> }) {
  return {
    livePriceCache: {
      findUnique: vi.fn().mockResolvedValue(overrides.cached ?? null),
      upsert: overrides.upsert ?? vi.fn(),
      update: overrides.update ?? vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// The exact shape observed in production logs (see get-live-prices.ts's
// QuotaExceededError comment) - all three per-symbol requests get the same
// 460 response since nerkh.io's quota is shared across symbols, not
// per-endpoint. A fresh Response per call, not one shared instance
// (`mockResolvedValue` would hand out the same object to all three
// concurrent fetchNerkhSymbol calls) - a Response body can only be read
// once, and getSinglePrice reads it via `.text()` on the non-ok path.
function mockQuotaExceededFetch() {
  return vi.fn().mockImplementation(
    () => Promise.resolve(new Response(JSON.stringify({ code: 460, error: "QuotaExceeded", message: "Daily quota exceeded" }), { status: 460 }))
  );
}

describe("getLivePrices", () => {
  it("fetches all three symbols, parses, and caches when there is no existing cache row", async () => {
    stubEnv();
    const fetchMock = mockNerkhFetch({ gold: 5_000_000, usd: 700_000, btc: 80_000_000_000 });
    vi.stubGlobal("fetch", fetchMock);

    const upsert = vi.fn().mockImplementation(({ create }) => ({ ...create }));
    const client = fakeClient({ cached: null, upsert });

    const result = await getLivePrices(client);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every call carries the Bearer token, per nerkh.io's documented auth.
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe("Bearer test-key");
    }
    expect(result).toMatchObject({
      goldGramPricePerUnit: 5_000_000,
      usdPricePerUnit: 700_000,
      bitcoinPricePerUnit: 80_000_000_000,
      stale: false,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("also parses the nested data.prices[CODE].current shape (bulk-style envelope)", async () => {
    stubEnv();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const body = url.includes("/gold/")
        ? { data: { prices: { GOLD18K: { current: 5_000_000 } } } }
        : url.includes("/currency/")
          ? { data: { prices: { USD: { current: 700_000 } } } }
          : { data: { prices: { BTC: { current: 80_000_000_000 } } } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const upsert = vi.fn().mockImplementation(({ create }) => ({ ...create }));
    const result = await getLivePrices(fakeClient({ cached: null, upsert }));

    expect(result).toMatchObject({ goldGramPricePerUnit: 5_000_000, usdPricePerUnit: 700_000, bitcoinPricePerUnit: 80_000_000_000 });
  });

  it("reuses a cache row younger than the TTL without calling fetch", async () => {
    stubEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = fakeClient({
      cached: {
        goldGramPricePerUnit: 1n,
        usdPricePerUnit: 2n,
        bitcoinPricePerUnit: 3n,
        fetchedAt: new Date(),
      },
    });

    const result = await getLivePrices(client);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ goldGramPricePerUnit: 1, usdPricePerUnit: 2, bitcoinPricePerUnit: 3, stale: false });
  });

  it("falls back to a stale cache row (stale: true) when a fresh fetch fails", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server error", { status: 500 })));

    const client = fakeClient({
      cached: {
        goldGramPricePerUnit: 10n,
        usdPricePerUnit: 20n,
        bitcoinPricePerUnit: 30n,
        // Older than CACHE_TTL_MS so a refresh is attempted.
        fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const result = await getLivePrices(client);
    expect(result).toMatchObject({ goldGramPricePerUnit: 10, usdPricePerUnit: 20, bitcoinPricePerUnit: 30, stale: true });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("throws LivePriceUnavailableError when there is no cache and the fetch fails", async () => {
    stubEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server error", { status: 500 })));

    const client = fakeClient({ cached: null });

    await expect(getLivePrices(client)).rejects.toBeInstanceOf(LivePriceUnavailableError);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("throws a clear Persian error when NERKH_API_KEY is unset and there is no cache to fall back to", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = fakeClient({ cached: null });

    await expect(getLivePrices(client)).rejects.toBeInstanceOf(LivePriceUnavailableError);
  });

  // Thundering-herd de-dup: concurrent callers that share the same `client`
  // and land in the same expired-cache window join one in-flight fetch
  // instead of each starting their own - see get-live-prices.ts's own
  // comment on the WeakMap this backs.
  describe("concurrent calls (single-flight de-dup)", () => {
    it("dedupes concurrent calls sharing the same client into one fetch+upsert", async () => {
      stubEnv();
      const fetchMock = mockNerkhFetch({ gold: 5_000_000, usd: 700_000, btc: 80_000_000_000 });
      vi.stubGlobal("fetch", fetchMock);

      const upsert = vi.fn().mockImplementation(({ create }) => ({ ...create }));
      const client = fakeClient({ cached: null, upsert });

      const [resultA, resultB] = await Promise.all([getLivePrices(client), getLivePrices(client)]);

      // 3 symbols (gold/currency/crypto) fetched once, not once per caller.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(resultA).toMatchObject({ goldGramPricePerUnit: 5_000_000, usdPricePerUnit: 700_000 });
      expect(resultB).toMatchObject({ goldGramPricePerUnit: 5_000_000, usdPricePerUnit: 700_000 });
    });

    it("does not dedupe concurrent calls that pass different client instances", async () => {
      stubEnv();
      const fetchMock = mockNerkhFetch({ gold: 5_000_000, usd: 700_000, btc: 80_000_000_000 });
      vi.stubGlobal("fetch", fetchMock);

      const upsertA = vi.fn().mockImplementation(({ create }) => ({ ...create }));
      const upsertB = vi.fn().mockImplementation(({ create }) => ({ ...create }));
      const clientA = fakeClient({ cached: null, upsert: upsertA });
      const clientB = fakeClient({ cached: null, upsert: upsertB });

      await Promise.all([getLivePrices(clientA), getLivePrices(clientB)]);

      // Each client is its own dedup key - 3 symbols fetched per client, 6 total.
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(upsertA).toHaveBeenCalledTimes(1);
      expect(upsertB).toHaveBeenCalledTimes(1);
    });

    it("starts a fresh fetch for a later call after the in-flight one has settled", async () => {
      stubEnv();
      const fetchMock = mockNerkhFetch({ gold: 5_000_000, usd: 700_000, btc: 80_000_000_000 });
      vi.stubGlobal("fetch", fetchMock);

      const upsert = vi.fn().mockImplementation(({ create }) => ({ ...create }));
      const client = fakeClient({ cached: null, upsert });

      await getLivePrices(client);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Cache row is still reported as null by this fakeClient (findUnique
      // is stubbed to always resolve `overrides.cached`, unaffected by the
      // previous call's upsert), so a second, later call is expected to
      // fetch again - proving the in-flight entry was cleared, not stuck
      // replaying the first (already-settled) promise forever.
      await getLivePrices(client);
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(upsert).toHaveBeenCalledTimes(2);
    });
  });

  // Quota-exhaustion cooldown: once nerkh.io's specific 460/QuotaExceeded
  // shape is seen, no further nerkh.io requests are made until the
  // cooldown expires, and only the call that first detects it alerts.
  describe("quota-exceeded cooldown", () => {
    it("detects a quota-exceeded (460) response, sets quotaExceededUntil on the cache row, and fires exactly one alert", async () => {
      stubEnv();
      const fetchMock = mockQuotaExceededFetch();
      vi.stubGlobal("fetch", fetchMock);

      const update = vi.fn().mockResolvedValue(undefined);
      const client = fakeClient({
        cached: {
          goldGramPricePerUnit: 10n,
          usdPricePerUnit: 20n,
          bitcoinPricePerUnit: 30n,
          // Older than CACHE_TTL_MS so a refresh is attempted.
          fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
          quotaExceededUntil: null,
        },
        update,
      });

      const result = await getLivePrices(client);

      // All three symbols were attempted (quota exhaustion is only detected
      // once a request is actually made and 460 comes back).
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ goldGramPricePerUnit: 10, usdPricePerUnit: 20, bitcoinPricePerUnit: 30, stale: true });

      expect(update).toHaveBeenCalledTimes(1);
      const updateCall = update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 1 });
      expect(updateCall.data.quotaExceededUntil).toBeInstanceOf(Date);
      expect(updateCall.data.quotaExceededUntil.getTime()).toBeGreaterThan(Date.now());

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ errorType: ERROR_TYPES.QUOTA_EXCEEDED_ERROR }));
    });

    it("makes zero HTTP requests and fires zero additional alerts on a later call while still in cooldown", async () => {
      stubEnv();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const client = fakeClient({
        cached: {
          goldGramPricePerUnit: 10n,
          usdPricePerUnit: 20n,
          bitcoinPricePerUnit: 30n,
          fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
          // Cooldown already active from an earlier exhaustion.
          quotaExceededUntil: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const result = await getLivePrices(client);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ goldGramPricePerUnit: 10, usdPricePerUnit: 20, bitcoinPricePerUnit: 30, stale: true });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("attempts a fresh fetch normally once the cooldown has expired", async () => {
      stubEnv();
      const fetchMock = mockNerkhFetch({ gold: 5_000_000, usd: 700_000, btc: 80_000_000_000 });
      vi.stubGlobal("fetch", fetchMock);

      const upsert = vi.fn().mockImplementation(({ create }) => ({ ...create }));
      const client = fakeClient({
        cached: {
          goldGramPricePerUnit: 10n,
          usdPricePerUnit: 20n,
          bitcoinPricePerUnit: 30n,
          fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
          // Cooldown from an earlier exhaustion has already expired.
          quotaExceededUntil: new Date(Date.now() - 60 * 1000),
        },
        upsert,
      });

      const result = await getLivePrices(client);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ goldGramPricePerUnit: 5_000_000, usdPricePerUnit: 700_000, bitcoinPricePerUnit: 80_000_000_000, stale: false });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("leaves a non-460 failure unaffected: reports the generic API_ERROR and retries on every subsequent call", async () => {
      stubEnv();
      const fetchMock = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      const client = fakeClient({
        cached: {
          goldGramPricePerUnit: 10n,
          usdPricePerUnit: 20n,
          bitcoinPricePerUnit: 30n,
          fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
          quotaExceededUntil: null,
        },
      });

      const first = await getLivePrices(client);
      expect(first).toMatchObject({ stale: true });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ errorType: ERROR_TYPES.API_ERROR }));

      // No cooldown was recorded (this isn't a QuotaExceededError), so a
      // second call retries the fetch again exactly as today - the whole
      // point of this task being scoped to the 460/QuotaExceeded case only.
      const second = await getLivePrices(client);
      expect(second).toMatchObject({ stale: true });
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(reportError).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenNthCalledWith(2, expect.objectContaining({ errorType: ERROR_TYPES.API_ERROR }));
    });
  });
});
