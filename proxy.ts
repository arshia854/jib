import { NextRequest, NextResponse } from "next/server";
import { getSession, LEGACY_SESSION_COOKIE, isNextAuthSessionCookieName } from "@/lib/auth/session";
import { checkRateLimit, getClientIp, rateLimitResponse, GENERAL_API_IP_RULE } from "@/lib/rate-limit";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Generous, coarse per-IP backstop against basic flooding across every API
  // route - separate from (and in addition to) the tighter, per-endpoint
  // rules applied inside the OTP and LLM route handlers themselves.
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(request.headers);
    const result = checkRateLimit(`general-api:ip:${ip}`, GENERAL_API_IP_RULE);
    if (!result.allowed) {
      return rateLimitResponse(result);
    }

    if (pathname.startsWith("/api/admin/")) {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
      }
      if (session.role !== "admin") {
        return NextResponse.json({ error: "دسترسی غیرمجاز." }, { status: 403 });
      }
    }

    return NextResponse.next();
  }

  const session = await getSession();

  const isAuthRoute = pathname === "/login" || pathname === "/verify";

  if (!session) {
    if (isAuthRoute) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    const response = NextResponse.redirect(url);
    // getSession() also returns null for a cryptographically-valid cookie
    // whose userId no longer exists in the DB, or belongs to a blocked user
    // (see lib/auth/session.ts) - clear both possible session cookies here
    // so a stale one doesn't keep getting silently rejected on every
    // request instead of actually signing the browser out.
    response.cookies.delete(LEGACY_SESSION_COOKIE);
    for (const cookie of request.cookies.getAll()) {
      if (isNextAuthSessionCookieName(cookie.name)) {
        response.cookies.delete(cookie.name);
      }
    }
    return response;
  }

  if (isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = session.onboarded ? "/app" : "/onboarding";
    return NextResponse.redirect(url);
  }

  // Checked before the onboarding gate below: an admin promoted directly in
  // the DB (see README.md) may never have gone through onboarding, and
  // admin access doesn't depend on having set up personal finance data.
  const isAdminRoute = pathname === "/app/admin" || pathname.startsWith("/app/admin/");
  if (isAdminRoute) {
    if (session.role !== "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (!session.onboarded && pathname !== "/onboarding") {
    const url = request.nextUrl.clone();
    url.pathname = "/onboarding";
    return NextResponse.redirect(url);
  }

  if (session.onboarded && pathname === "/onboarding") {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/onboarding", "/login", "/verify", "/api/:path*"],
};
