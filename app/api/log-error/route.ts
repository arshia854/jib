import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logError } from "@/lib/error-log";

// Lets client-side error boundaries (which can't reach Prisma directly)
// persist to ErrorLog. Unauthenticated-reachable by necessity (the root
// error boundary can fire before/without a session) - the general per-IP
// rate limit in proxy.ts (GENERAL_API_IP_RULE) is the abuse backstop here,
// plus the length caps in lib/error-log.ts.
export async function POST(request: NextRequest) {
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
