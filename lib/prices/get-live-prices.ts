import "server-only";
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// How long a cached row (LivePriceCache, prisma/schema.prisma) is trusted
// before a fresh external fetch is attempted. Shared across every user (see
// that model's own comment) - 5 minutes keeps the Assets/dashboard "live"
// price genuinely close to real-time while keeping the three-request
// refresh (one per symbol, see fetchNerkhPrices below) infrequent.
const CACHE_TTL_MS = 5 * 60 * 1000;

// Phase parity with lib/nvidia-ai.ts's NVIDIA_REQUEST_TIMEOUT_MS/
// CONNECTION_RETRY_ATTEMPTS - this is the only other place in the codebase
// that calls a third-party HTTP API defensively, so the same timeout+retry
// shape is reused rather than inventing a second convention.
const REQUEST_TIMEOUT_MS = 10_000;
const CONNECTION_RETRY_ATTEMPTS = 1;

function getApiKey(): string {
  // Nerkh.io tokens are only valid for 60 days from issue (per their own
  // signup flow) - if this suddenly starts throwing LivePriceUnavailableError
  // in production after previously working, an expired token is the first
  // thing to check, not necessarily a code regression.
  const key = process.env.NERKH_API_KEY;
  if (!key) {
    throw new Error("NERKH_API_KEY تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return key;
}

const NERKH_BASE_URL = "https://api.nerkh.io/v1/prices/json";

export interface LivePrices {
  goldGramPricePerUnit: number;
  usdPricePerUnit: number;
  bitcoinPricePerUnit: number;
  fetchedAt: Date;
  // True when these prices came from a cached row older than CACHE_TTL_MS
  // because a fresh fetch was attempted and failed (not merely because the
  // cache was reused within its normal TTL window - that case is `false`).
  // Callers (lib/data/assets.ts, lib/data/dashboard.ts) surface this so the
  // UI can show a subtle "ممکنه قیمت‌ها به‌روز نباشن" note instead of
  // silently presenting a stale number as current.
  stale: boolean;
}

// Thrown only when no fetch has ever succeeded (no cache row exists at all)
// and a fresh fetch also just failed - i.e. there is truly nothing to show.
// Callers must catch this and degrade gracefully (cost-basis-only asset
// list, no gold/dollar dashboard line) rather than letting it 500 the page.
export class LivePriceUnavailableError extends Error {}

function isConnectionLevelFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// One symbol per call (nerkh.io's REST shape is path-based per symbol -
// e.g. GET /v1/prices/json/currency/USD - rather than one bulk payload
// covering everything, unlike the provider originally evaluated for this
// feature). `kind` is the API's own category segment (currency/gold/crypto),
// `code` its symbol within that category (USD/GOLD18K/BTC).
async function fetchNerkhSymbol(kind: string, code: string): Promise<unknown> {
  const url = `${NERKH_BASE_URL}/${kind}/${code}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (firstError) {
    if (!isConnectionLevelFailure(firstError) || CONNECTION_RETRY_ATTEMPTS < 1) throw firstError;
    response = await fetchWithTimeout(url);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`درخواست به nerkh.io (${kind}/${code}) ناموفق بود (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  return response.json();
}

// UNVERIFIED, best-effort - nerkh.io's exact response envelope couldn't be
// confirmed without a live API key (their docs site renders client-side and
// showed no example body; this shape - {data:{prices:{CODE:{current,...}}}}
// - comes from a third-party open-source client's parsing code, not an
// official spec, and only for the *bulk* (no-symbol) endpoint - the
// single-symbol endpoints this module actually calls might return a flatter
// body). Handles both a nested `data.prices[code].current` (bulk shape) and
// a flatter `data.current`/`current`/`price` (plausible single-symbol
// shapes) defensively. Once NERKH_API_KEY is set, make one real call per
// endpoint and adjust this to match the real payload.
function extractCurrentPrice(payload: unknown, code: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;

  const prices = data.prices as Record<string, unknown> | undefined;
  const entry = (prices?.[code] ?? data[code] ?? data) as Record<string, unknown> | undefined;

  const current = entry?.current ?? entry?.price ?? data.current ?? data.price;
  return typeof current === "number" ? current : typeof current === "string" ? Number(current) : undefined;
}

// Toman is the unit this whole app stores/displays money in (see
// lib/format.ts's formatToman). Assumed here by default - unlike the
// previously-evaluated provider, nerkh.io's own docs/example client code
// never surfaced an explicit per-item `unit`/Rial-vs-Toman field to check,
// and Iranian consumer-facing rate sites (this app's own target audience)
// conventionally quote Toman - but this is an assumption, not a confirmed
// fact, and needs the same live-call verification as extractCurrentPrice
// above before this is fully trusted.
async function getSinglePrice(kind: string, code: string): Promise<number> {
  const payload = await fetchNerkhSymbol(kind, code);
  const price = extractCurrentPrice(payload, code);
  if (price === undefined || !Number.isFinite(price)) {
    throw new Error(`پاسخ nerkh.io برای ${kind}/${code} شامل قیمت معتبر نبود.`);
  }
  return price;
}

async function fetchNerkhPrices(): Promise<{ goldGramPricePerUnit: number; usdPricePerUnit: number; bitcoinPricePerUnit: number }> {
  const [goldGramPricePerUnit, usdPricePerUnit, bitcoinPricePerUnit] = await Promise.all([
    getSinglePrice("gold", "GOLD18K"),
    getSinglePrice("currency", "USD"),
    getSinglePrice("crypto", "BTC"),
  ]);
  return { goldGramPricePerUnit, usdPricePerUnit, bitcoinPricePerUnit };
}

function rowToLivePrices(row: { goldGramPricePerUnit: bigint; usdPricePerUnit: bigint; bitcoinPricePerUnit: bigint; fetchedAt: Date }, stale: boolean): LivePrices {
  return {
    goldGramPricePerUnit: Number(row.goldGramPricePerUnit),
    usdPricePerUnit: Number(row.usdPricePerUnit),
    bitcoinPricePerUnit: Number(row.bitcoinPricePerUnit),
    fetchedAt: row.fetchedAt,
    stale,
  };
}

type PrismaClient = typeof prisma;

// Single-flight de-dup for concurrent callers sharing the same `client`
// (in production that's always the one `prisma` singleton every call site's
// default param resolves to - lib/data/dashboard.ts, lib/data/assets.ts,
// lib/ai/parse-transaction.ts, app/api/assets/live-prices/route.ts all call
// this with no explicit client) that land in the gap between "the cached row
// just expired" and "a fresh fetch+upsert finishes" - a real network
// round-trip to nerkh.io, not instant. At meaningful concurrent traffic
// (many requests hitting this exact TTL-expiry window at once - the
// "thundering herd" pattern), without this every one of those callers would
// independently re-fetch and re-upsert the same three symbols: wasted
// nerkh.io quota (an externally-rate-limited/billed resource, the same class
// of concern lib/nvidia-ai.ts's max_tokens caps and timeout/retry policy
// address for the other third-party API this codebase calls defensively)
// and redundant DB writes, all computing the identical result.
//
// Keyed by the `client` object reference itself (not a hardcoded check for
// the real `prisma` singleton) via a WeakMap, so this needs no special-casing
// and can't leak state between callers that intentionally use different
// clients - which is exactly how every existing test in this file already
// calls getLivePrices() (each with its own fakeClient(...) instance, per the
// DI convention this whole codebase's data layer already follows, e.g.
// lib/data/assets.ts's own `client: PrismaClient = prisma` param). Two
// concurrent test calls sharing one fakeClient() instance are deduped the
// same way two concurrent production requests sharing the real `prisma`
// singleton are; two calls with distinct client objects (the common case in
// this file's existing tests) never share an entry and behave exactly as
// before this change.
const inFlightFetches = new WeakMap<object, Promise<LivePrices>>();

/**
 * Returns the latest gold(18k gram)/usd/bitcoin Toman prices, backed by a
 * shared DB cache (LivePriceCache) refreshed at most once per CACHE_TTL_MS.
 * Falls back to a stale cached row (stale: true) if a fresh fetch fails but
 * a previous one succeeded; throws LivePriceUnavailableError only if no
 * fetch has ever succeeded and the current attempt also fails.
 */
export async function getLivePrices(client: PrismaClient = prisma): Promise<LivePrices> {
  const cached = await client.livePriceCache.findUnique({ where: { id: 1 } });

  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return rowToLivePrices(cached, false);
  }

  const inFlight = inFlightFetches.get(client);
  if (inFlight) return inFlight;

  // Everything below runs at most once per (client, cache-expiry window) at
  // a time - the `inFlightFetches.set` a few lines down happens synchronously
  // (no `await` between entering this function body and that line), so any
  // concurrent caller that resumes its own `cached` read after this point
  // sees the in-flight entry above and joins it instead of starting a second
  // fetch. See the WeakMap's own comment for why `client` (not a hardcoded
  // `prisma` reference) is the right dedup key.
  const run = (async (): Promise<LivePrices> => {
    try {
      const parsed = await fetchNerkhPrices();
      const fetchedAt = new Date();

      const saved = await client.livePriceCache.upsert({
        where: { id: 1 },
        create: { id: 1, ...parsed, fetchedAt },
        update: { ...parsed, fetchedAt },
      });

      return rowToLivePrices(saved, false);
    } catch (error) {
      reportError({
        errorType: ERROR_TYPES.API_ERROR,
        route: "lib/prices/get-live-prices",
        message: error instanceof Error ? error.message : "Unexpected error fetching live asset prices",
        error,
        context: { operation: "getLivePrices", provider: "nerkh.io" },
      });

      if (cached) return rowToLivePrices(cached, true);
      throw new LivePriceUnavailableError("قیمت لحظه‌ای طلا/دلار/بیت‌کوین در دسترس نیست.");
    } finally {
      // Cleared once this attempt settles (success OR failure) so the next
      // call after this window - whether that's the next cache-TTL cycle or
      // a fresh attempt following a failure - starts its own fetch rather
      // than replaying a stale settled promise.
      inFlightFetches.delete(client);
    }
  })();

  inFlightFetches.set(client, run);
  return run;
}
