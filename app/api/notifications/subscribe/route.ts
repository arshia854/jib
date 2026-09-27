import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { upsertPushSubscription, deletePushSubscriptionByEndpoint } from "@/lib/data/push-subscriptions";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

// POST body is a PushSubscription.toJSON() shape from the client (see
// lib/notifications/subscribe-push.ts): { endpoint, keys: { p256dh, auth } }.
// expirationTime (also present on toJSON()'s output) isn't persisted -
// PushSubscription (prisma/schema.prisma) has no column for it and nothing
// reads it yet.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "اطلاعات اشتراک اعلان ناقص است." }, { status: 400 });
  }

  try {
    await upsertPushSubscription(session.userId, { endpoint, p256dh, auth });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "notifications/subscribe",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error saving push subscription",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "upsertPushSubscription", model: "PushSubscription", code: error.code }
        : { operation: "upsertPushSubscription", model: "PushSubscription" },
    });
    throw error;
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) {
    return NextResponse.json({ error: "اطلاعات اشتراک اعلان ناقص است." }, { status: 400 });
  }

  try {
    await deletePushSubscriptionByEndpoint(session.userId, endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "notifications/subscribe",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error removing push subscription",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deletePushSubscriptionByEndpoint", model: "PushSubscription", code: error.code }
        : { operation: "deletePushSubscriptionByEndpoint", model: "PushSubscription" },
    });
    throw error;
  }
}
