import "server-only";
import { randomInt } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { isMelipayamakConfigured, sendOtpViaMelipayamak, type SendOtpResult } from "@/lib/sms/melipayamak";

export const OTP_COOKIE = "jeeb_otp";
export const OTP_TTL_SECONDS = 120;
export const MAX_ATTEMPTS = 5;

// Deliberately its own env var, independent of AUTH_SECRET (NextAuth's own
// session secret - see auth.ts) and LEGACY_SESSION_SECRET (see
// lib/auth/session.ts) - previously all three read AUTH_SECRET, so a single
// leaked value could forge OTP challenges, legacy session cookies, and full
// 90-day NextAuth sessions alike. Set independently (not derived from
// AUTH_SECRET via any transform) so a leak of one never implies the others.
function getSecretKey(): Uint8Array {
  const secret = process.env.OTP_SECRET;
  if (!secret) {
    throw new Error("OTP_SECRET تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return new TextEncoder().encode(secret);
}

// Uses the CSPRNG (node:crypto.randomInt), not Math.random() - OTP codes
// are a security boundary (auth bypass if guessable/predictable), so they
// need a cryptographically secure source of randomness, not just a
// uniformly-distributed one. Range/format (6 digits, 100000-999999)
// unchanged from before.
export function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

export interface OtpPayload {
  phone: string;
  code: string;
  attempts: number;
}

export async function createOtpToken(phone: string, code: string, attempts = 0): Promise<string> {
  return new SignJWT({ phone, code, attempts })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OTP_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyOtpToken(token: string): Promise<OtpPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.phone !== "string" || typeof payload.code !== "string") return null;
    return {
      phone: payload.phone,
      code: payload.code,
      attempts: typeof payload.attempts === "number" ? payload.attempts : 0,
    };
  } catch {
    return null;
  }
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
      console.error(`[melipayamak] OTP requested for ${phone} but Melipayamak credentials are not configured`);
      return { success: false, error: "SMS provider is not configured" };
    }
    console.log(`[mock SMS] OTP for ${phone}: ${code}`);
    return { success: true };
  }

  const result = await sendOtpViaMelipayamak(phone, code);
  if (!result.success) {
    console.error(`[melipayamak] failed to send OTP to ${phone}: ${result.error}`);
  }
  return result;
}
