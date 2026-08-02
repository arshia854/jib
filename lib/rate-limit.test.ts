import { describe, it, expect } from "vitest";
import { checkRateLimit, getClientIp, rateLimitResponse, type RateLimitRule } from "@/lib/rate-limit";

const RULE: RateLimitRule = { limit: 3, windowSeconds: 60 };

describe("checkRateLimit", () => {
  it("allows requests up to the limit within the window", () => {
    const key = "test:limit-enforcement";
    const now = 1_000_000;

    expect(checkRateLimit(key, RULE, now).allowed).toBe(true);
    expect(checkRateLimit(key, RULE, now + 1_000).allowed).toBe(true);
    expect(checkRateLimit(key, RULE, now + 2_000).allowed).toBe(true);
  });

  it("blocks once the limit is exceeded within the window", () => {
    const key = "test:limit-exceeded";
    const now = 1_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 1_000);
    checkRateLimit(key, RULE, now + 2_000);

    const result = checkRateLimit(key, RULE, now + 3_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("reports decreasing remaining count as requests are consumed", () => {
    const key = "test:remaining-count";
    const now = 1_000_000;

    expect(checkRateLimit(key, RULE, now).remaining).toBe(2);
    expect(checkRateLimit(key, RULE, now + 1_000).remaining).toBe(1);
    expect(checkRateLimit(key, RULE, now + 2_000).remaining).toBe(0);
  });

  it("reports a positive retryAfterSeconds once blocked", () => {
    const key = "test:retry-after";
    const now = 1_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 1_000);
    checkRateLimit(key, RULE, now + 2_000);

    const blocked = checkRateLimit(key, RULE, now + 10_000);
    expect(blocked.allowed).toBe(false);
    // Window resets 60s after the first request in it (now), so ~50s left.
    expect(blocked.retryAfterSeconds).toBe(50);
  });

  it("resets the count once the window has fully elapsed", () => {
    const key = "test:window-reset";
    const now = 1_000_000;

    checkRateLimit(key, RULE, now);
    checkRateLimit(key, RULE, now + 1_000);
    checkRateLimit(key, RULE, now + 2_000);
    expect(checkRateLimit(key, RULE, now + 3_000).allowed).toBe(false);

    const afterWindow = checkRateLimit(key, RULE, now + RULE.windowSeconds * 1000 + 1);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(RULE.limit - 1);
  });

  it("tracks separate keys independently", () => {
    const now = 1_000_000;
    const keyA = "test:isolation-a";
    const keyB = "test:isolation-b";

    checkRateLimit(keyA, RULE, now);
    checkRateLimit(keyA, RULE, now + 1_000);
    checkRateLimit(keyA, RULE, now + 2_000);
    expect(checkRateLimit(keyA, RULE, now + 3_000).allowed).toBe(false);

    // keyB has its own budget, unaffected by keyA's usage.
    expect(checkRateLimit(keyB, RULE, now + 3_000).allowed).toBe(true);
  });
});

describe("getClientIp", () => {
  it("prefers the first address in X-Forwarded-For", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(getClientIp(headers)).toBe("203.0.113.5");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.7" });
    expect(getClientIp(headers)).toBe("198.51.100.7");
  });

  it("falls back to 'unknown' when no IP header is present", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with a Retry-After header matching the result", async () => {
    const response = rateLimitResponse({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");

    const body = await response.json();
    expect(body.retryAfterSeconds).toBe(42);
    expect(typeof body.error).toBe("string");
  });
});
