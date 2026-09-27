import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Registers (or re-registers) one Web Push subscription for a user.
 * Matched on `endpoint` alone (globally unique, see PushSubscription's own
 * doc comment in prisma/schema.prisma) rather than `userId_endpoint` -
 * re-subscribing the same browser/device endpoint under a different logged
 * in user (e.g. a shared device, a fresh login after signing out) reassigns
 * it to the new caller instead of erroring, since a stale endpoint tied to
 * whoever previously used that browser is never useful to keep pushing to.
 */
export async function upsertPushSubscription(
  userId: number,
  data: { endpoint: string; p256dh: string; auth: string }
) {
  return prisma.pushSubscription.upsert({
    where: { endpoint: data.endpoint },
    create: { userId, endpoint: data.endpoint, p256dh: data.p256dh, auth: data.auth },
    update: { userId, p256dh: data.p256dh, auth: data.auth },
  });
}

/**
 * Removes a subscription by endpoint, scoped to the calling user - a
 * `deleteMany` (not `delete`) since the row might already be gone (a
 * second unsubscribe call, or lib/notifications/send-push.ts already
 * cleaned it up after a dead-endpoint push failure) and this is meant to
 * be a no-op in that case, not a 404. Scoping the `where` by userId (rather
 * than deleting by endpoint alone and separately checking ownership) means
 * another user's subscription sharing the same endpoint can never be
 * deleted by this call, even though that shouldn't happen in practice per
 * upsertPushSubscription's own reassign-on-conflict behavior above.
 */
export async function deletePushSubscriptionByEndpoint(userId: number, endpoint: string) {
  const { count } = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  return count > 0;
}

/**
 * Every subscription on file for a user - lib/notifications/send-push.ts's
 * fan-out target list.
 */
export async function listPushSubscriptionsForUser(userId: number) {
  return prisma.pushSubscription.findMany({ where: { userId } });
}

/**
 * Removes one dead subscription by its own id - lib/notifications/
 * send-push.ts calls this after a 404/410 response confirms the browser's
 * push service considers the endpoint gone, not on any other failure
 * (a timeout/5xx doesn't mean the endpoint is actually dead).
 */
export async function deletePushSubscriptionById(id: number) {
  await prisma.pushSubscription.delete({ where: { id } });
}

/**
 * Distinct userIds with at least one Web Push subscription on file -
 * lib/notifications/nightly-reminder.ts's send target list. Sending only to
 * these avoids writing a NotificationLog row nightly for every user who
 * could never actually receive a push (see sendPushToUser's own
 * no-op-without-subscriptions behavior - this just avoids calling it
 * pointlessly, it doesn't change that behavior).
 */
export async function listUserIdsWithPushSubscriptions(): Promise<number[]> {
  const rows = await prisma.pushSubscription.findMany({
    distinct: ["userId"],
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}
