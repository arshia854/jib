import "server-only";
import webpush from "web-push";
import { createNotificationLog, markNotificationSentViaPush } from "@/lib/data/notification-log";
import {
  listPushSubscriptionsForUser,
  deletePushSubscriptionById,
} from "@/lib/data/push-subscriptions";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Server-side send utility for the notifications feature (Phase 2 of
// docs/roadmap-status.md's notifications work). Deliberately not called
// from anywhere yet - no trigger wires into this in this phase. The two
// planned callers are separate, later, individually-approved phases: an
// income-transaction trigger (Phase 3, NOTIFICATION_TYPES.income_savings_suggestion)
// and a nightly schedule (Phase 4, NOTIFICATION_TYPES.nightly_reminder) -
// see lib/data/notification-log.ts's own NOTIFICATION_TYPES.

function getVapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

// web-push rejects/resolves with a plain Error augmented with these fields
// (see node_modules/web-push's own README) rather than a dedicated error
// class - this project has no `@types/web-push` (see types/web-push.d.ts's
// own comment on why), so the shape is checked structurally here, same
// spirit as lib/observability/classify-error.ts's isPrismaErrorCode.
function isWebPushError(error: unknown): error is { statusCode: number } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  );
}

/**
 * Writes a NotificationLog row (always - this is what backs the in-app
 * notification center regardless of push outcome), then best-effort pushes
 * it to every device the user has subscribed from. A subscription whose
 * push service confirms it's gone (404/410) is deleted so future calls stop
 * wasting a request on it; any other failure (timeout, 5xx, ...) is left in
 * place and just reported, since that doesn't mean the endpoint is
 * actually dead. `sentViaPush` is set true if at least one subscription's
 * push actually succeeded - a user with three devices where only one push
 * succeeds still "saw" the notification.
 */
export async function sendPushToUser(userId: number, data: { type: string; title: string; body: string }) {
  const log = await createNotificationLog(userId, data);

  const config = getVapidConfig();
  if (!config) return log;

  const subscriptions = await listPushSubscriptionsForUser(userId);
  if (subscriptions.length === 0) return log;

  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const payload = JSON.stringify({ title: data.title, body: data.body });

  let anySucceeded = false;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload
        );
        anySucceeded = true;
      } catch (error) {
        if (isWebPushError(error) && (error.statusCode === 404 || error.statusCode === 410)) {
          await deletePushSubscriptionById(subscription.id);
          return;
        }
        reportError({
          errorType: ERROR_TYPES.API_ERROR,
          route: "notifications/send-push",
          userId,
          message: error instanceof Error ? error.message : "Unexpected error sending push notification",
          error,
          context: { operation: "sendNotification", subscriptionId: subscription.id },
        });
      }
    })
  );

  if (anySucceeded) {
    await markNotificationSentViaPush(log.id);
    log.sentViaPush = true;
  }

  return log;
}
