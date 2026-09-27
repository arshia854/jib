import "server-only";
import { prisma } from "@/lib/prisma";

// Fixed vocabulary for NotificationLog.type (prisma/schema.prisma) -
// enforced here at the application level only, same convention as
// GOAL_CATEGORIES/SAVINGS_STRATEGY_FORMULA_TYPES elsewhere in lib/data.
// Both values are placeholders for now - no trigger writes a real one yet
// (income-trigger and nightly-schedule wiring are separate later phases,
// see lib/notifications/send-push.ts's own doc comment).
export const NOTIFICATION_TYPES = ["income_savings_suggestion", "nightly_reminder"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Writes the one NotificationLog row a notification always gets, regardless
 * of whether push delivery (lib/notifications/send-push.ts) ends up
 * succeeding, failing, or never being attempted (no subscriptions on file) -
 * this is what backs the in-app notification center's unread list on its
 * own, independent of push.
 */
export async function createNotificationLog(
  userId: number,
  data: { type: string; title: string; body: string }
) {
  return prisma.notificationLog.create({
    data: { userId, type: data.type, title: data.title, body: data.body },
  });
}

/**
 * Flips `sentViaPush` to true after at least one push actually succeeded -
 * called at most once per row, after every subscription for that user has
 * been attempted (see sendPushToUser). Left false (never called) if push
 * was attempted and every subscription failed, or if the user had none.
 */
export async function markNotificationSentViaPush(id: number) {
  await prisma.notificationLog.update({ where: { id }, data: { sentViaPush: true } });
}
