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

function sweepExpired(now: number) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
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
    store.set(key, { count: 1, resetAt: now + rule.windowSeconds * 1000 });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  if (entry.count >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true, remaining: rule.limit - entry.count, retryAfterSeconds: 0 };
}

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
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

// LLM-calling endpoints cost real money per call (OpenRouter). These caps
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

// Generous coarse backstop applied per-IP across all API routes.
export const GENERAL_API_IP_RULE: RateLimitRule = { limit: 200, windowSeconds: 5 * 60 };

// Email/password auth - bounds brute-force guessing per account and per IP.
export const EMAIL_LOGIN_EMAIL_RULE: RateLimitRule = { limit: 8, windowSeconds: 15 * 60 };
export const EMAIL_LOGIN_IP_RULE: RateLimitRule = { limit: 20, windowSeconds: 15 * 60 };
export const EMAIL_REGISTER_IP_RULE: RateLimitRule = { limit: 8, windowSeconds: 60 * 60 };
