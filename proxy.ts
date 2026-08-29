import { NextRequest, NextResponse } from "next/server";
import { getSession, LEGACY_SESSION_COOKIE, isNextAuthSessionCookieName } from "@/lib/auth/session";
import { checkRateLimit, getClientIp, rateLimitResponse, GENERAL_API_IP_RULE } from "@/lib/rate-limit";
import { REQUEST_ID_HEADER, runWithRequestContext } from "@/lib/observability/request-context";

export async function proxy(request: NextRequest) {
  // Reuse an upstream-supplied id (a CDN/load balancer, or - in practice
  // for this app - a previous hop that already generated one) if present,
  // otherwise mint a fresh one. Generated here rather than left to each
  // route handler individually, since every request passes through this
  // file first (config.matcher below already covers every API route) and
  // this is the one place that can guarantee every response - including
  // ones this file answers directly (redirects, 401/403, rate-limit) -
  // carries the same id its own logs would use.
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

  // Cloned, not mutated in place: `request.headers` on an incoming
  // NextRequest is meant to be read, and NextResponse.next()'s own
  // `request.headers` option is exactly how Proxy is documented to forward
  // *modified* request headers on to the eventual route handler/page (see
  // node_modules/next/dist/docs/.../proxy.md, "Setting Headers" - "You can
  // also set request headers in NextResponse.next"). This is also the only
  // real bridge for the id into a route handler: an AsyncLocalStorage scope
  // opened in this file does not extend into a route handler's own,
  // separately-invoked execution (see lib/observability/request-context.ts's
  // own doc comment) - only this forwarded request header does.
  const forwardedRequestHeaders = new Headers(request.headers);
  forwardedRequestHeaders.set(REQUEST_ID_HEADER, requestId);

  // Every return path below goes through one of these two, so the response
  // this file ultimately sends (whichever branch produces it) always
  // carries X-Request-Id, and every NextResponse.next() call forwards the
  // (possibly freshly-generated) id to the route/page that continues
  // handling the request.
  const withRequestId = (response: NextResponse): NextResponse => {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  };
  const next = () => withRequestId(NextResponse.next({ request: { headers: forwardedRequestHeaders } }));

  return runWithRequestContext({ requestId }, () => handleProxy(request, { next, withRequestId }));
}

interface ProxyHelpers {
  next: () => NextResponse;
  withRequestId: (response: NextResponse) => NextResponse;
}

// Unchanged routing/session/redirect logic from before the request-ID work
// (Phase 12.2) - split out purely so proxy() above can wrap it in one
// runWithRequestContext() call without touching any of the branches below.
async function handleProxy(request: NextRequest, { next, withRequestId }: ProxyHelpers) {
  const { pathname } = request.nextUrl;

  // Generous, coarse per-IP backstop against basic flooding across every API
  // route - separate from (and in addition to) the tighter, per-endpoint
  // rules applied inside the OTP and LLM route handlers themselves.
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(request.headers);
    const result = checkRateLimit(`general-api:ip:${ip}`, GENERAL_API_IP_RULE);
    if (!result.allowed) {
      return withRequestId(rateLimitResponse(result));
    }

    if (pathname.startsWith("/api/admin/")) {
      const session = await getSession();
      if (!session) {
        return withRequestId(NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 }));
      }
      if (session.role !== "admin") {
        return withRequestId(NextResponse.json({ error: "دسترسی غیرمجاز." }, { status: 403 }));
      }
    }

    return next();
  }

  const session = await getSession();

  const isAuthRoute = pathname === "/login" || pathname === "/verify";

  if (!session) {
    if (isAuthRoute) return next();
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
    return withRequestId(response);
  }

  if (isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = session.onboarded ? "/app" : "/onboarding";
    return withRequestId(NextResponse.redirect(url));
  }

  // Checked before the onboarding gate below: an admin promoted directly in
  // the DB (see README.md) may never have gone through onboarding, and
  // admin access doesn't depend on having set up personal finance data.
  const isAdminRoute = pathname === "/app/admin" || pathname.startsWith("/app/admin/");
  if (isAdminRoute) {
    if (session.role !== "admin") {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return withRequestId(NextResponse.redirect(url));
    }
    return next();
  }

  if (!session.onboarded && pathname !== "/onboarding") {
    const url = request.nextUrl.clone();
    url.pathname = "/onboarding";
    return withRequestId(NextResponse.redirect(url));
  }

  if (session.onboarded && pathname === "/onboarding") {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    return withRequestId(NextResponse.redirect(url));
  }

  return next();
}

export const config = {
  matcher: ["/app/:path*", "/onboarding", "/login", "/verify", "/api/:path*"],
};
