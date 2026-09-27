import "server-only";
import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { isMelipayamakConfigured, sendOtpViaMelipayamak, type SendOtpResult } from "@/lib/sms/melipayamak";

export const OTP_COOKIE = "jeeb_otp";
export const OTP_TTL_SECONDS = 120;
export const MAX_ATTEMPTS = 5;

// Uses the CSPRNG (node:crypto.randomInt), not Math.random() - OTP codes
// are a security boundary (auth bypass if guessable/predictable), so they
// need a cryptographically secure source of randomness, not just a
// uniformly-distributed one. Range/format (6 digits, 100000-999999)
// unchanged from before.
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Server-side OTP challenge store.
 *
 * The code and attempt count live only here, in process memory - the
 * client's `jeeb_otp` cookie holds nothing but an opaque random challenge
 * id. (Previously the cookie was a signed-but-not-encrypted JWT carrying
 * `{ phone, code, attempts }`, so anyone could base64-decode their own
 * cookie and read the code, and replaying an older cookie reset the
 * attempt counter.) The id is a CSPRNG v4 UUID (122 random bits) and
 * carries no claims, so it isn't signed: a forged/altered id is just a
 * lookup miss, same as an expired one.
 *
 * Same tradeoff as lib/rate-limit.ts: NOT distributed-safe - challenges
 * live in this process only, so they're lost on restart/redeploy (users
 * just request a new code) and are NOT shared across multiple instances.
 * Fine for the current single-instance deployment; must move to a shared
 * store before scaling out, or phone login will fail whenever send-otp
 * and verify land on different instances. Kept on globalThis (same idea
 * as lib/prisma.ts) so the send-otp route and the NextAuth route always
 * see the same Map even if they end up with separate module instances.
 */
interface OtpChallenge {
  phone: string;
  code: string;
  attempts: number;
  expiresAt: number;
}

const globalForOtp = globalThis as unknown as { otpChallenges?: Map<string, OtpChallenge> };
const challenges = (globalForOtp.otpChallenges ??= new Map<string, OtpChallenge>());

const SWEEP_INTERVAL_MS = 60 * 1000;
let lastSweepAt = 0;

// Hard cap, same reasoning as lib/rate-limit.ts's MAX_STORE_SIZE: send-otp
// is IP-rate-limited, but IPs are spoofable until the reverse proxy is
// configured (see getClientIp()), so bound memory regardless.
export const MAX_CHALLENGES = 20_000;

function sweepExpired(now: number, force = false) {
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(id);
  }
}

// Returns the opaque challenge id to set as the OTP cookie's value.
export function createOtpChallenge(phone: string, code: string, now: number = Date.now()): string {
  sweepExpired(now);
  if (challenges.size >= MAX_CHALLENGES) {
    sweepExpired(now, true);
    if (challenges.size >= MAX_CHALLENGES) {
      // Map iteration order is insertion order - evict the oldest.
      const oldestId = challenges.keys().next().value;
      if (oldestId !== undefined) challenges.delete(oldestId);
    }
  }
  const id = randomUUID();
  challenges.set(id, { phone, code, attempts: 0, expiresAt: now + OTP_TTL_SECONDS * 1000 });
  return id;
}

function getLiveChallenge(id: string, now: number): OtpChallenge | null {
  const challenge = challenges.get(id);
  if (!challenge) return null;
  if (challenge.expiresAt <= now) {
    challenges.delete(id);
    return null;
  }
  return challenge;
}

// The phone a live challenge was issued for, or null if the id is
// unknown/expired/already consumed. Never exposes the code.
export function getOtpChallengePhone(id: string, now: number = Date.now()): string | null {
  return getLiveChallenge(id, now)?.phone ?? null;
}

export type OtpVerifyResult =
  | { status: "ok"; phone: string }
  | { status: "wrong_code"; remainingAttempts: number }
  | { status: "max_attempts" }
  | { status: "expired" };

function codesMatch(expected: string, submitted: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(submitted, "utf8");
  // timingSafeEqual throws on unequal lengths; the length itself isn't
  // secret (always 6 digits).
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fully synchronous, so two concurrent verifies of the same challenge can't
// interleave: a challenge is deleted (single-use) on success and on hitting
// MAX_ATTEMPTS. Same state machine the old signed cookie implemented:
// MAX_ATTEMPTS wrong codes are each answered with the remaining count, the
// next submission after that is rejected as max_attempts, and each wrong
// code restarts the TTL (the old code re-signed a fresh 120s token on every
// wrong attempt - the caller refreshes the cookie's maxAge to match).
export function verifyOtpChallenge(id: string, code: string, now: number = Date.now()): OtpVerifyResult {
  const challenge = getLiveChallenge(id, now);
  if (!challenge) return { status: "expired" };

  if (challenge.attempts >= MAX_ATTEMPTS) {
    challenges.delete(id);
    return { status: "max_attempts" };
  }

  if (!codesMatch(challenge.code, code)) {
    challenge.attempts += 1;
    challenge.expiresAt = now + OTP_TTL_SECONDS * 1000;
    return { status: "wrong_code", remainingAttempts: MAX_ATTEMPTS - challenge.attempts };
  }

  challenges.delete(id);
  return { status: "ok", phone: challenge.phone };
}

// Falls back to logging the code to the console when Melipayamak isn't
// configured yet (local dev, or before Melipayamak approval goes through).
// That fallback is only allowed outside production: in production, missing
// credentials must fail closed rather than print a real login code to the
// server logs. The caller (app/api/auth/send-otp/route.ts) already treats
// { success: false } as a hard failure and returns a 502 without ever
// creating an OTP token, so failing closed here is enough to block the
// whole flow.
export async function sendOtpSms(phone: string, code: string): Promise<SendOtpResult> {
  if (!isMelipayamakConfigured()) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        `[melipayamak] OTP requested for number ending ${phone.slice(-4)} but Melipayamak credentials are not configured`
      );
      return { success: false, error: "SMS provider is not configured" };
    }
    console.log(`[mock SMS] OTP for ${phone}: ${code}`);
    return { success: true };
  }

  const result = await sendOtpViaMelipayamak(phone, code);
  if (!result.success) {
    console.error(`[melipayamak] failed to send OTP to number ending ${phone.slice(-4)}: ${result.error}`);
  }
  return result;
}
