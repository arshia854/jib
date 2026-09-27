import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { checkRateLimit, getClientIp, rateLimitResponse, EMAIL_REGISTER_IP_RULE } from "@/lib/rate-limit";
import { MAX_EMAIL_LENGTH, MAX_PASSWORD_BYTES } from "@/lib/limits";

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

  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) {
    return NextResponse.json({ error: "ایمیل نامعتبر است." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "رمز عبور باید حداقل ۸ کاراکتر باشد." }, { status: 400 });
  }
  // bcrypt silently truncates at 72 bytes (see lib/limits.ts) - reject
  // before hashing rather than let two different passwords past that
  // length collide onto the same hash.
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return NextResponse.json({ error: "رمز عبور بیش از حد طولانی است." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  // One identical message regardless of how the existing account signed up
  // (password vs. Google) - a differing message would let anyone probe not
  // just whether an email is registered but which sign-in method it uses.
  if (existing) {
    return NextResponse.json({ error: "این ایمیل قبلاً ثبت‌نام شده است." }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.create({ data: { email, passwordHash } });

  return NextResponse.json({ ok: true });
}
