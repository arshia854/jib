import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { generateOtpCode, createOtpToken, sendOtpSms, OTP_COOKIE, OTP_TTL_SECONDS } from "@/lib/auth/otp";
import { isValidIranianPhone, normalizePhone } from "@/lib/auth/phone";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const phone = typeof body?.phoneNumber === "string" ? normalizePhone(body.phoneNumber) : "";

  if (!isValidIranianPhone(phone)) {
    return NextResponse.json({ error: "شماره موبایل نامعتبر است. مثال: 09123456789" }, { status: 400 });
  }

  const code = generateOtpCode();
  sendOtpSms(phone, code);
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
