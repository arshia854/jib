import { NextResponse } from "next/server";

/**
 * In-memory, fixed-window rate limiter.
 *
 * NOT distributed-safe: counters live in this process's memory only, so
 * they reset on every restart/redeploy and are NOT shared across multiple
 * server instances or serverless cold starts. This is an interim app-layer
 * backstop until Phase 6 picks a hosting provider and (if still needed)
 * wires up a shared store like Upstash/Redis.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

// Hard cap on distinct keys tracked at once. Without this, a flood of
// requests using many distinct keys (e.g. many spoofed IPs hitting
// GENERAL_API_IP_RULE - see the getClientIp() caveat below) could grow
// this Map without bound between scheduled sweeps, exhausting process
// memory. Exported so tests can reference it instead of duplicating the
// number.
export const MAX_STORE_SIZE = 20_000;

// Test-only introspection - not used by any production code path.
export function __getStoreSizeForTests(): number {
  return store.size;
}

function sweepExpired(now: number, force = false) {
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
  sweepExpired(now);

  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    if (store.size >= MAX_STORE_SIZE) {
      // Reclaim anything actually expired first, out of the normal
      // 5-minute schedule.
      sweepExpired(now, true);
      if (store.size >= MAX_STORE_SIZE) {
        // Still full after reclaiming expired entries - evict the
        // oldest-inserted key rather than let the store grow unbounded.
        // Map iteration order is insertion order, so the first key
        // yielded is the oldest.
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) store.delete(oldestKey);
      }
    }
    store.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  if (entry.count >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true, remaining: rule.limit - entry.count, retryAfterSeconds: 0 };
}

// Every IP-keyed rate limit in the app (OTP send/verify cost control,
// email-login brute force protection, the general per-IP API backstop)
// depends on this function returning the real client IP rather than one
// an attacker can freely set. Both `X-Forwarded-For` and `X-Real-IP` are
// request headers set by *whoever connects to us* - they are ONLY
// trustworthy if a reverse proxy in front of this app overwrites them
// with the real TCP peer address on every request, stripping/discarding
// whatever the client itself sent. That proxy config is infrastructure
// outside this repo and, as of this writing, is NOT yet in place for
// Jib's deployment - so this function alone does not make rate limiting
// spoof-proof; it becomes effective only once the reverse proxy is
// configured to match. Required config once a proxy is added:
//   nginx:  proxy_set_header X-Real-IP $remote_addr;
//   Caddy:  reverse_proxy already sets X-Real-IP to the immediate peer by
//           default; just don't pass through an upstream client's header.
//
// Trust order once that's in place:
// 1. X-Real-IP - a single scalar value the proxy overwrites outright, no
//    list-parsing ambiguity.
// 2. The LAST entry of X-Forwarded-For - each hop *appends* to this list
//    (nginx's $proxy_add_x_forwarded_for, Caddy's default), so the last
//    entry is the one added by our own proxy; the first entry is
//    whatever the client itself sent and is fully attacker-controlled.
export function getClientIp(headers: Headers): string {
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return "unknown";
}

export function rateLimitResponse(
  result: RateLimitResult,
  message = "تعداد درخواست‌های شما بیش از حد مجاز است، لطفاً چند دقیقه دیگر تلاش کنید."
): NextResponse {
  return NextResponse.json(
    { error: message, retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

// Named rules - kept together so every limit in the app can be seen and
// tuned in one place.

// A legitimate user might retry a couple of times if an SMS is delayed;
// 4 per 15 minutes covers that while bounding SMS cost per number.
export const OTP_REQUEST_PHONE_RULE: RateLimitRule = { limit: 4, windowSeconds: 15 * 60 };
// Coarser per-IP net so one attacker can't cycle through many phone numbers.
export const OTP_REQUEST_IP_RULE: RateLimitRule = { limit: 15, windowSeconds: 60 * 60 };

// Additional defense-in-depth on top of the per-code attempt cap already
// enforced via the signed OTP cookie (see lib/auth/otp.ts MAX_ATTEMPTS) -
// bounds total verify volume per phone across multiple requested codes.
export const OTP_VERIFY_PHONE_RULE: RateLimitRule = { limit: 8, windowSeconds: 15 * 60 };

// LLM-calling endpoints cost real money per call (NVIDIA NIM). These caps
// are generous for normal manual use but stop a runaway/compromised client.
//
// TRANSACTION_PARSE_USER_RULE covers the add-transaction textarea's
// auto-parse-as-you-type preview (700ms debounce, fires on every typing
// pause), not a single button press - one finalized transaction can easily
// cost several calls as the user edits their sentence. 60/5min (~12/min)
// gives headroom for a multi-transaction logging session while still
// bounding a runaway client to a few calls per debounce interval.
export const TRANSACTION_PARSE_USER_RULE: RateLimitRule = { limit: 60, windowSeconds: 5 * 60 };
export const CHAT_USER_RULE: RateLimitRule = { limit: 15, windowSeconds: 5 * 60 };

// GOAL_STRATEGY_USER_RULE covers POST /api/goals/[id]/strategy - one
// explicit "دریافت استراتژی" button press per call, not a debounced/
// typing-triggered flow like TRANSACTION_PARSE_USER_RULE. Modeled closer to
// CHAT_USER_RULE's cadence (a deliberate, occasional user action) than
// reused outright, since a legitimate session could reasonably regenerate a
// strategy a few times across several goals in one sitting (comparing
// goals, retrying after a transient AI hiccup) - 10 per 10 minutes covers
// that comfortably while still bounding a runaway/compromised client to a
// small, cheap number of NVIDIA NIM calls.
export const GOAL_STRATEGY_USER_RULE: RateLimitRule = { limit: 10, windowSeconds: 10 * 60 };

// Generous coarse backstop applied per-IP across all API routes.
export const GENERAL_API_IP_RULE: RateLimitRule = { limit: 200, windowSeconds: 5 * 60 };

// Email/password auth - bounds brute-force guessing per account and per IP.
export const EMAIL_LOGIN_EMAIL_RULE: RateLimitRule = { limit: 8, windowSeconds: 15 * 60 };
export const EMAIL_LOGIN_IP_RULE: RateLimitRule = { limit: 20, windowSeconds: 15 * 60 };
export const EMAIL_REGISTER_IP_RULE: RateLimitRule = { limit: 8, windowSeconds: 60 * 60 };
