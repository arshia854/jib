import "server-only";
import { cache } from "react";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { auth, unstable_update } from "@/auth";
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { logger } from "@/lib/observability/logger"; // TEMP-LATENCY
import { getRequestId } from "@/lib/observability/request-context"; // TEMP-LATENCY

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

// Deliberately its own env var, independent of AUTH_SECRET (NextAuth's own
// session secret - see auth.ts) and OTP_SECRET (see lib/auth/otp.ts) -
// previously all three read AUTH_SECRET, so a single leaked value could
// forge legacy session cookies, OTP challenges, and full 90-day NextAuth
// sessions alike. Set independently (not derived from AUTH_SECRET via any
// transform) so a leak of one never implies the others. Returns null
// (rather than throwing) when unset, same as before this split - this
// legacy path is expected to eventually stop mattering entirely (see
// LEGACY_SESSION_COOKIE above) once every pre-migration cookie has expired
// or its owner has signed out, unlike OTP_SECRET/AUTH_SECRET which gate
// active, ongoing auth flows.
function getLegacySecretKey(): Uint8Array | null {
  const secret = process.env.LEGACY_SESSION_SECRET;
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

const VALID_ROLES: readonly UserRole[] = ["user", "admin"];

// `User.role` is a plain, non-enum DB column (see prisma/schema.prisma's
// own comment on the field) - restricted to these two values at the DB
// level too, by a hand-written CHECK constraint (Phase 15, see
// prisma/migrations/20260822213426_add_user_role_check_constraint), since
// Prisma's schema DSL has no way to express one for this installed
// version. This is the one place that actually narrows an untyped DB read
// down to UserRole - replaces the unchecked `user.role as UserRole` cast
// this file and lib/data/admin-users.ts both used to do, and is exported
// so admin-users.ts's own two read sites use the exact same check instead
// of drifting.
export function isValidRole(value: unknown): value is UserRole {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

export interface Session {
  userId: number;
  onboarded: boolean;
  role: UserRole;
}

// Turso latency fix (docs/roadmap-status.md): a single /app render used to
// run three independent `prisma.user.findUnique({ where: { id } })` reads
// for the same userId - one inside getActiveUser below (via getSession),
// one in getCurrentUser, one in getDashboardData - up to 3 round-trips for
// data that can't have changed between them within one render. React's
// cache() (see node_modules/next/dist/docs/01-app/02-guides/
// caching-without-cache-components.md's "Deduplicating requests" section)
// memoizes a function's result per set of arguments, but ONLY within a
// single request/render pass in Next's own server runtime - confirmed
// against this installed React (19.2.4): outside that runtime (e.g. this
// file's own test suite, under plain Vitest/Node resolution - see
// vitest.config.ts's own comment on the "react-server" export condition
// not being set there), `cache()` resolves to a plain passthrough with no
// memoization at all, so every test call still hits the DB fresh. In
// production it does NOT span requests, and does NOT span proxy.ts's own
// getSession() call and the later page render as one pass - Proxy "is
// meant to be invoked separately of your render code" (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// proxy.md) and runs before any React rendering happens, so proxy.ts's own
// getActiveUser (via its own getSession() call) always gets a fresh cache
// scope, never one shared with a subsequent page render. A blocked or
// deleted user is therefore still caught on their very next request exactly
// as before this change - nothing here weakens that freshness guarantee.
export const getCachedUser = cache((id: number) => prisma.user.findUnique({ where: { id } }));

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
  const user = await getCachedUser(userId);
  if (!user || user.blockedAt) return null;
  if (!isValidRole(user.role)) {
    // The DB-level CHECK constraint (see isValidRole's doc comment) should
    // make this unreachable for any row written after it was applied -
    // this branch exists for a row that predates the constraint, or one
    // that somehow bypassed it. Treated as a data-integrity error to log,
    // not silently coerced to "user" or "admin" - either guess could be
    // wrong in either direction, and this is exactly the kind of silent
    // bad-write the roadmap wants surfaced, not hidden by a fallback.
    // Failing closed (no active session) is the one outcome that's never a
    // privilege escalation, matching how a blocked/deleted user is already
    // handled just above.
    reportError({
      errorType: ERROR_TYPES.AUTH_ERROR,
      route: "auth/session",
      userId: user.id,
      message: `User.role held an invalid value: ${JSON.stringify(user.role)}`,
      error: new Error("Invalid User.role value read from database"),
      context: { operation: "getActiveUser", model: "User" },
    });
    return null;
  }
  return { id: user.id, role: user.role };
}

export async function getSession(): Promise<Session | null> {
  const authStartedAt = Date.now(); // TEMP-LATENCY
  const nextAuthSession = await auth();
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "auth/session", // TEMP-LATENCY
      step: "auth", // TEMP-LATENCY
      duration: Date.now() - authStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "getSession step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
  if (nextAuthSession?.userId) {
    const userId = Number(nextAuthSession.userId);
    const getActiveUserStartedAt = Date.now(); // TEMP-LATENCY
    const activeUser = await getActiveUser(userId);
    logger.info( // TEMP-LATENCY
      { // TEMP-LATENCY
        requestId: getRequestId(), // TEMP-LATENCY
        route: "auth/session", // TEMP-LATENCY
        userId, // TEMP-LATENCY
        step: "getActiveUser", // TEMP-LATENCY
        duration: Date.now() - getActiveUserStartedAt, // TEMP-LATENCY
      }, // TEMP-LATENCY
      "getSession step timing" // TEMP-LATENCY
    ); // TEMP-LATENCY
    if (!activeUser) return null;
    return { userId, onboarded: nextAuthSession.onboarded, role: activeUser.role };
  }

  const legacySession = await getLegacySession();
  if (!legacySession) return null;
  const legacyGetActiveUserStartedAt = Date.now(); // TEMP-LATENCY
  const activeUser = await getActiveUser(legacySession.userId);
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "auth/session", // TEMP-LATENCY
      userId: legacySession.userId, // TEMP-LATENCY
      step: "getActiveUser", // TEMP-LATENCY
      duration: Date.now() - legacyGetActiveUserStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "getSession step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
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
  const getCachedUserStartedAt = Date.now(); // TEMP-LATENCY
  const user = await getCachedUser(session.userId); // TEMP-LATENCY
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "auth/session", // TEMP-LATENCY
      userId: session.userId, // TEMP-LATENCY
      step: "getCurrentUser.getCachedUser", // TEMP-LATENCY
      duration: Date.now() - getCachedUserStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "getSession step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
  return user; // TEMP-LATENCY
}
