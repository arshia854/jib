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

// How long to stop attempting nerkh.io requests at all once a response has
// told us the quota is exhausted (QuotaExceededError, below) - covers the
// whole LivePriceCache row, not per-symbol, since all three symbols share
// one quota.
//
// UNVERIFIED, best-effort, same honesty caveat as extractCurrentPrice's own
// comment further down: nerkh.io's docs site couldn't be found to document
// a quota reset window anywhere, and no real 460 response has been
// inspected for a Retry-After-style header (this app has never held a live
// API key long enough to hit the quota itself - the observed 460 came from
// production logs only). A day is a common reset cadence for this class of
// metered API, so 24h is used here as a conservative guess to stop
// hammering an already-exhausted quota every CACHE_TTL_MS cycle - it is
// NOT a confirmed fact, and may need real-world tuning once nerkh.io's
// actual behavior (or support) confirms the real window.
const QUOTA_EXCEEDED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

// Thrown specifically when nerkh.io responds with its quota-exhausted
// shape (HTTP 460, body `{"code":460,"error":"QuotaExceeded",...}` - this
// exact shape was observed directly in production logs, unlike most of
// this file's other response-parsing, which is still UNVERIFIED/best-effort
// against a real payload). Kept distinct from the generic Error thrown for
// every other non-ok response so getLivePrices can react differently to
// it (start a cooldown, fire a distinct alert) without misclassifying an
// ordinary transient failure (timeout, 500, malformed body, ...) as quota
// exhaustion.
export class QuotaExceededError extends Error {}

// Best-effort match against the exact observed shape. Returns false (never
// throws) for a body that isn't valid JSON or doesn't have this shape -
// callers fall back to the existing generic-error path in that case, per
// this task's own instruction not to crash on an unparsable body.
function isQuotaExceededBody(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    const { code, error } = parsed as Record<string, unknown>;
    return code === 460 && error === "QuotaExceeded";
  } catch {
    return false;
  }
}

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
    if (response.status === 460 && isQuotaExceededBody(bodyText)) {
      throw new QuotaExceededError(`نرخ درخواست به nerkh.io (${kind}/${code}) تمام شده است (460): ${bodyText.slice(0, 300)}`);
    }
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
 *
 * If nerkh.io's quota is detected exhausted (QuotaExceededError), no
 * further fetches are attempted until QUOTA_EXCEEDED_COOLDOWN_MS has
 * passed - every call during that window is served from the cache (stale:
 * true) with zero nerkh.io requests, and only the call that first detects
 * the exhaustion reports it (ERROR_TYPES.QUOTA_EXCEEDED_ERROR).
 */
export async function getLivePrices(client: PrismaClient = prisma): Promise<LivePrices> {
  const cached = await client.livePriceCache.findUnique({ where: { id: 1 } });

  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return rowToLivePrices(cached, false);
  }

  // Quota-exhaustion cooldown (set below, in the QuotaExceededError branch,
  // and by prisma/migrations/*_add_live_price_quota_exceeded_until): while
  // it's still in the future, skip fetchNerkhPrices() entirely - zero
  // nerkh.io requests made - rather than re-attempting (and re-failing)
  // against an already-exhausted quota every CACHE_TTL_MS cycle. Checked
  // after (not merged into) the TTL check above, so a row that's still
  // fresh within TTL keeps returning stale: false exactly as today even if
  // it happens to also carry a (now-irrelevant) past cooldown timestamp.
  // `cached` is necessarily non-null whenever this condition is true
  // (quotaExceededUntil only ever lives on an existing row), so there is
  // no separate "throw LivePriceUnavailableError" branch to write here -
  // that contract is unreachable by construction, not omitted.
  if (cached?.quotaExceededUntil && cached.quotaExceededUntil.getTime() > Date.now()) {
    return rowToLivePrices(cached, true);
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
        // Also clears any past (already-expired, functionally inert)
        // cooldown timestamp left over from a prior QuotaExceededError, so
        // the row's stored state stays accurate for anything inspecting it
        // directly rather than only through this function's own
        // Date.now() comparison above.
        update: { ...parsed, fetchedAt, quotaExceededUntil: null },
      });

      return rowToLivePrices(saved, false);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        const quotaExceededUntil = new Date(Date.now() + QUOTA_EXCEEDED_COOLDOWN_MS);

        // Reaching this branch at all means the pre-fetch check above just
        // decided the cooldown was NOT active (null, never set, or already
        // expired) - so persisting it now is always a fresh transition
        // into cooldown, never a renewal of one already in effect. That's
        // what makes firing this alert unconditionally (once per branch
        // entry) correct per this task's "exactly one alert per
        // exhaustion event" requirement: a later call that finds the
        // cooldown still active takes the early-return branch above and
        // never reaches this catch, so it can never re-fire this alert -
        // only the next call made after the cooldown expires (and hits a
        // fresh QuotaExceededError again) can.
        if (cached) {
          await client.livePriceCache.update({ where: { id: 1 }, data: { quotaExceededUntil } });
        }
        // else: no row has ever been written (no fetch has ever
        // succeeded) - there's nowhere to persist a cooldown against, so
        // this falls through to the same LivePriceUnavailableError as any
        // other "never succeeded" failure below, and the next call will
        // simply retry (same as today) since no cooldown could be stored.

        reportError({
          errorType: ERROR_TYPES.QUOTA_EXCEEDED_ERROR,
          route: "lib/prices/get-live-prices",
          message: error.message,
          error,
          context: { operation: "getLivePrices", provider: "nerkh.io", quotaExceededUntil: quotaExceededUntil.toISOString() },
        });
      } else {
        reportError({
          errorType: ERROR_TYPES.API_ERROR,
          route: "lib/prices/get-live-prices",
          message: error instanceof Error ? error.message : "Unexpected error fetching live asset prices",
          error,
          context: { operation: "getLivePrices", provider: "nerkh.io" },
        });
      }

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
