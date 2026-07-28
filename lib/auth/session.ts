import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const SESSION_COOKIE = "jeeb_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return new TextEncoder().encode(secret);
}

export interface Session {
  userId: number;
  onboarded: boolean;
}

export async function createSessionToken(userId: number, onboarded: boolean): Promise<string> {
  return new SignJWT({ onboarded })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (!payload.sub) return null;
    return { userId: Number(payload.sub), onboarded: Boolean(payload.onboarded) };
  } catch {
    return null;
  }
}

export async function setSessionCookie(userId: number, onboarded: boolean) {
  const token = await createSessionToken(userId, onboarded);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;
  return prisma.user.findUnique({ where: { id: session.userId } });
}
