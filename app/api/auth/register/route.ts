import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { checkRateLimit, getClientIp, rateLimitResponse, EMAIL_REGISTER_IP_RULE } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Creates the user + password hash only. The client signs in immediately
// after via next-auth/react's signIn("email-password", ...) - Credentials
// providers have no built-in "register" step, so this is a plain REST
// endpoint that just prepares the account.
export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  const ipLimit = checkRateLimit(`email-register:ip:${ip}`, EMAIL_REGISTER_IP_RULE);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "ایمیل نامعتبر است." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "رمز عبور باید حداقل ۸ کاراکتر باشد." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const message = existing.passwordHash
      ? "این ایمیل قبلاً ثبت‌نام کرده است."
      : "این ایمیل قبلاً با روش دیگری (مثلاً گوگل) ثبت‌نام کرده است.";
    return NextResponse.json({ error: message }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({ data: { email, passwordHash } });

  return NextResponse.json({ ok: true });
}
