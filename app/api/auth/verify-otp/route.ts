import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { verifyOtpToken, createOtpToken, OTP_COOKIE, OTP_TTL_SECONDS, MAX_ATTEMPTS } from "@/lib/auth/otp";
import { setSessionCookie } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";

  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "کد باید ۶ رقم باشد." }, { status: 400 });
  }

  const store = await cookies();
  const token = store.get(OTP_COOKIE)?.value;
  const payload = token ? await verifyOtpToken(token) : null;

  if (!payload) {
    return NextResponse.json({ error: "کد منقضی شده است. دوباره درخواست کد بدهید." }, { status: 400 });
  }

  if (payload.attempts >= MAX_ATTEMPTS) {
    store.delete(OTP_COOKIE);
    return NextResponse.json(
      { error: "تعداد تلاش‌ها بیش از حد مجاز است. دوباره درخواست کد بدهید." },
      { status: 429 }
    );
  }

  if (payload.code !== code) {
    const retryToken = await createOtpToken(payload.phone, payload.code, payload.attempts + 1);
    store.set(OTP_COOKIE, retryToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OTP_TTL_SECONDS,
    });
    return NextResponse.json(
      { error: `کد وارد شده اشتباه است. (${MAX_ATTEMPTS - payload.attempts - 1} تلاش باقی‌مانده)` },
      { status: 400 }
    );
  }

  store.delete(OTP_COOKIE);

  let user = await prisma.user.findUnique({ where: { phoneNumber: payload.phone } });
  const isNewUser = !user;
  if (!user) {
    user = await prisma.user.create({ data: { phoneNumber: payload.phone } });
  }

  const onboarded = Boolean(user.name);
  await setSessionCookie(user.id, onboarded);

  return NextResponse.json({ ok: true, onboarded, isNewUser });
}
