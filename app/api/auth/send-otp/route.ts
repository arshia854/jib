import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { generateOtpCode, createOtpToken, sendOtpSms, OTP_COOKIE, OTP_TTL_SECONDS } from "@/lib/auth/otp";
import { isValidIranianPhone, normalizePhone } from "@/lib/auth/phone";
import { checkRateLimit, getClientIp, rateLimitResponse, OTP_REQUEST_PHONE_RULE, OTP_REQUEST_IP_RULE } from "@/lib/rate-limit";
import { logError } from "@/lib/error-log";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const phone = typeof body?.phoneNumber === "string" ? normalizePhone(body.phoneNumber) : "";

  if (!isValidIranianPhone(phone)) {
    return NextResponse.json({ error: "شماره موبایل نامعتبر است. مثال: 09123456789" }, { status: 400 });
  }

  const ip = getClientIp(request.headers);
  const ipLimit = checkRateLimit(`otp-request:ip:${ip}`, OTP_REQUEST_IP_RULE);
  if (!ipLimit.allowed) {
    return rateLimitResponse(ipLimit);
  }
  const phoneLimit = checkRateLimit(`otp-request:phone:${phone}`, OTP_REQUEST_PHONE_RULE);
  if (!phoneLimit.allowed) {
    return rateLimitResponse(phoneLimit);
  }

  const code = generateOtpCode();
  const smsResult = await sendOtpSms(phone, code);
  if (!smsResult.success) {
    const message = smsResult.error ?? "ارسال پیامک OTP ناموفق بود.";
    await logError({
      route: "auth/send-otp",
      message,
    });
    // New (Phase 12.5) - added alongside the existing logError() call
    // above, not replacing it (per the Phase 12 audit's decision).
    // Recipient is anonymized to its last 4 digits only - never the full
    // phone number. sendOtpSms()/sendOtpViaMelipayamak() (lib/auth/otp.ts,
    // lib/sms/melipayamak.ts) make a single fetch attempt with no retry
    // loop today, so retryCount is always 0 here - included to match the
    // spec's field list, not because retries actually happen yet.
    // SendOtpResult has no separate structured error-code field (Melipayamak's
    // RetStatus is already interpolated into `error` as text by
    // sendOtpViaMelipayamak) - `providerError` carries that raw text as the
    // closest available equivalent, rather than inventing a new field.
    // There's no thrown exception to pass to Sentry either (this is a soft
    // { success: false } result, not a caught exception), so a fresh Error
    // is constructed from the same message for a well-formed Sentry report.
    reportError({
      errorType: ERROR_TYPES.SMS_ERROR,
      route: "auth/send-otp",
      message,
      error: new Error(message),
      context: { provider: "melipayamak", recipientLast4: phone.slice(-4), providerError: smsResult.error, retryCount: 0 },
    });
    return NextResponse.json({ error: "ارسال پیامک با خطا مواجه شد. لطفاً دوباره تلاش کنید." }, { status: 502 });
  }
  const token = await createOtpToken(phone, code);

  const store = await cookies();
  store.set(OTP_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OTP_TTL_SECONDS,
  });

  return NextResponse.json({ ok: true, phoneNumber: phone, expiresIn: OTP_TTL_SECONDS });
}
