import { SignJWT, jwtVerify } from "jose";
import { isMelipayamakConfigured, sendOtpViaMelipayamak, type SendOtpResult } from "@/lib/sms/melipayamak";

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

// Falls back to logging the code to the console when Melipayamak isn't
// configured yet (local dev, or before Melipayamak approval goes through).
export async function sendOtpSms(phone: string, code: string): Promise<SendOtpResult> {
  if (!isMelipayamakConfigured()) {
    console.log(`[mock SMS] OTP for ${phone}: ${code}`);
    return { success: true };
  }

  const result = await sendOtpViaMelipayamak(phone, code);
  if (!result.success) {
    console.error(`[melipayamak] failed to send OTP to ${phone}: ${result.error}`);
  }
  return result;
}
