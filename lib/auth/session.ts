import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { auth, unstable_update } from "@/auth";
import { prisma } from "@/lib/prisma";

// Legacy cookie from the pre-NextAuth custom session system. Kept
// read-only (get) plus one narrow re-sign path (setOnboarded below) so
// users already logged in at migration time stay logged in - rather than
// being forced to re-authenticate - until this cookie expires naturally or
// they sign out. All new sign-ins go through NextAuth (see ../../auth.ts)
// and never create this cookie.
export const LEGACY_SESSION_COOKIE = "jeeb_session";
const LEGACY_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

// Auth.js names its JWT session cookie `authjs.session-token`, prefixed with
// `__Secure-` when served over https (see @auth/core's defaultCookies), and
// suffixed `.0`, `.1`, ... if the JWT is ever large enough to be chunked
// across multiple cookies. Matched by pattern (rather than hardcoded) so
// proxy.ts can clear a stale cookie without reimplementing that secure/
// chunking logic itself.
const NEXTAUTH_SESSION_COOKIE_PATTERN = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function isNextAuthSessionCookieName(name: string): boolean {
  return NEXTAUTH_SESSION_COOKIE_PATTERN.test(name);
}

function getLegacySecretKey(): Uint8Array | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

async function getLegacySessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(LEGACY_SESSION_COOKIE)?.value;
}

// Shape of the legacy JWT payload - no `role`, since that field didn't
// exist yet when this signing path was still active (see LEGACY_SESSION_COOKIE
// above). getSession() below fills in `role` from a fresh DB read before
// handing back a full Session.
interface LegacyPayload {
  userId: number;
  onboarded: boolean;
}

async function decodeLegacySession(token: string): Promise<LegacyPayload | null> {
  const secretKey = getLegacySecretKey();
  if (!secretKey) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (!payload.sub) return null;
    return { userId: Number(payload.sub), onboarded: Boolean(payload.onboarded) };
  } catch {
    return null;
  }
}

async function getLegacySession(): Promise<LegacyPayload | null> {
  const token = await getLegacySessionToken();
  if (!token) return null;
  return decodeLegacySession(token);
}

export type UserRole = "user" | "admin";

export interface Session {
  userId: number;
  onboarded: boolean;
  role: UserRole;
}

// Both the NextAuth JWT strategy (no adapter/DB round-trip once the token is
// signed - see auth.ts's jwt/session callbacks) and the legacy cookie (only
// ever cryptographically verified) can produce a session for a userId that
// no longer has a matching User row (stale cookie surviving a DB reset, or
// an account that was deleted) - or that belongs to a user blocked by an
// admin (see app/app/admin/users) since the token/cookie was issued. Checked
// centrally here, for both paths, so every caller of getSession() -
// proxy.ts included - sees a blocked or deleted user the same way it sees
// "no session" at all, instead of only finding out when some later write
// trips a foreign key constraint (deleted) or an admin-only check (blocked).
async function getActiveUser(userId: number): Promise<{ id: number; role: UserRole } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, blockedAt: true },
  });
  if (!user || user.blockedAt) return null;
  return { id: user.id, role: user.role as UserRole };
}

export async function getSession(): Promise<Session | null> {
  const nextAuthSession = await auth();
  if (nextAuthSession?.userId) {
    const userId = Number(nextAuthSession.userId);
    const activeUser = await getActiveUser(userId);
    if (!activeUser) return null;
    return { userId, onboarded: nextAuthSession.onboarded, role: activeUser.role };
  }

  const legacySession = await getLegacySession();
  if (!legacySession) return null;
  const activeUser = await getActiveUser(legacySession.userId);
  if (!activeUser) return null;
  return { ...legacySession, role: activeUser.role };
}

// Defense-in-depth admin gate for the data layer itself (see
// lib/data/admin-*.ts) - proxy.ts already redirects non-admins away from
// /app/admin and /api/admin/*, but per-function checks here mean an admin
// route is never trusted on proxy.ts alone (e.g. a future route added
// without updating proxy's matcher/logic still fails closed).
export class NotAdminError extends Error {}

export async function requireAdminSession(): Promise<Session> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    throw new NotAdminError("دسترسی غیرمجاز.");
  }
  return session;
}

// Marks the current session as onboarded. Almost always a NextAuth
// session, refreshed via its `update` trigger - but a user still riding a
// pre-migration legacy cookie who hadn't finished onboarding yet needs that
// cookie re-signed directly instead, since NextAuth has no session of
// theirs to update.
export async function setOnboarded(): Promise<void> {
  const nextAuthSession = await auth();
  if (nextAuthSession?.userId) {
    await unstable_update({ onboarded: true });
    return;
  }

  const legacyToken = await getLegacySessionToken();
  const legacySession = legacyToken ? await decodeLegacySession(legacyToken) : null;
  if (!legacySession) return;

  const secretKey = getLegacySecretKey();
  if (!secretKey) return;

  const token = await new SignJWT({ onboarded: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(legacySession.userId))
    .setIssuedAt()
    .setExpirationTime(`${LEGACY_SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey);

  const store = await cookies();
  store.set(LEGACY_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: LEGACY_SESSION_MAX_AGE_SECONDS,
  });
}

export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;
  return prisma.user.findUnique({ where: { id: session.userId } });
}
