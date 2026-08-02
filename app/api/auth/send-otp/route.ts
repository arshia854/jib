import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { generateOtpCode, createOtpToken, sendOtpSms, OTP_COOKIE, OTP_TTL_SECONDS } from "@/lib/auth/otp";
import { isValidIranianPhone, normalizePhone } from "@/lib/auth/phone";
import { checkRateLimit, getClientIp, rateLimitResponse, OTP_REQUEST_PHONE_RULE, OTP_REQUEST_IP_RULE } from "@/lib/rate-limit";
import { logError } from "@/lib/error-log";

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
    await logError({
      route: "auth/send-otp",
      message: smsResult.error ?? "ارسال پیامک OTP ناموفق بود.",
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
