import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logError } from "@/lib/error-log";
import {
  checkRateLimit,
  getClientIp,
  rateLimitResponse,
  CLIENT_ERROR_LOG_IP_RULE,
  CLIENT_ERROR_LOG_GLOBAL_RULE,
} from "@/lib/rate-limit";

// Lets client-side error boundaries (which can't reach Prisma directly)
// persist to ErrorLog. Unauthenticated-reachable by necessity (the root
// error boundary can fire before/without a session) - abuse is bounded by
// this route's own per-IP and global rate limits (CLIENT_ERROR_LOG_IP_RULE,
// CLIENT_ERROR_LOG_GLOBAL_RULE - see lib/rate-limit.ts for why both), on
// top of the general per-IP limit in proxy.ts (GENERAL_API_IP_RULE), plus
// the length caps in lib/error-log.ts.
export async function POST(request: NextRequest) {
  // Per-IP first, so a single IP that's already over its own limit can't
  // also keep draining the shared global budget.
  const ip = getClientIp(request.headers);
  const ipLimit = checkRateLimit(`log-error:ip:${ip}`, CLIENT_ERROR_LOG_IP_RULE);
  if (!ipLimit.allowed) return rateLimitResponse(ipLimit);
  const globalLimit = checkRateLimit("log-error:global", CLIENT_ERROR_LOG_GLOBAL_RULE);
  if (!globalLimit.allowed) return rateLimitResponse(globalLimit);

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "پیام خطا الزامی است." }, { status: 400 });
  }
  const stack = typeof body?.stack === "string" ? body.stack : null;

  const session = await getSession();
  await logError({ route: "client", message, stack, userId: session?.userId ?? null });

  return NextResponse.json({ ok: true });
}
