import { SignJWT, jwtVerify } from "jose";

export const OTP_COOKIE = "jeeb_otp";
export const OTP_TTL_SECONDS = 120;
export const MAX_ATTEMPTS = 5;

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return new TextEncoder().encode(secret);
}

export function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
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

/**
 * Mock SMS provider for local dev - logs the code instead of sending it.
 * Swap for Kavenegar/Ghasedak (via SMS_PROVIDER_API_KEY) when ready.
 */
export function sendOtpSms(phone: string, code: string) {
  console.log(`[mock SMS] OTP for ${phone}: ${code}`);
}
