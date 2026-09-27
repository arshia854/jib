import "server-only";
import { listUserIdsWithPushSubscriptions } from "@/lib/data/push-subscriptions";
import { sendPushToUser } from "@/lib/notifications/send-push";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { logger } from "@/lib/observability/logger";

// How many sendPushToUser calls run at once - bounded so a large user base
// doesn't fire thousands of concurrent webpush/DB calls in one tick.
// Plain chunked batches, not a dependency: this project has no existing
// concurrency-limiting helper to reuse (checked lib/nvidia-ai.ts,
// lib/reports/trend-insights.ts, lib/reports/generate-highlights.ts), and
// this job's own volume doesn't justify adding one.
const BATCH_SIZE = 20;

const NIGHTLY_REMINDER_TITLE = "یادآوری";

// Deliberately plain, not idiomatic - per docs/jib-persona.md's tone matrix,
// a scheduled reminder with no underlying data (no spending fact, no goal
// progress) is a "routine/neutral" surface, not an "overspending" or
// "good month" moment, so the v1.1 expression bank doesn't apply here; it's
// reserved for insight-shaped messages, not passive ones. Rotated
// (Math.random(), same precedent as lib/notifications/savings-suggestion.ts)
// so the same line doesn't repeat every night.
const NIGHTLY_REMINDER_BODY_TEMPLATES = [
  "یادت رفت امروز تراکنش‌هات رو ثبت کنی؟ الان وقتشه.",
  "قبل از اینکه بخوابی، خرج‌های امروزت رو ثبت کن.",
  "یه نگاه به امروزت بینداز و هر چی خرج کردی رو ثبت کن.",
  "وقتشه امروز رو جمع‌بندی کنی؛ تراکنش‌های ثبت‌نشده رو اضافه کن.",
];

function buildNightlyReminderCopy(): { title: string; body: string } {
  const body = NIGHTLY_REMINDER_BODY_TEMPLATES[Math.floor(Math.random() * NIGHTLY_REMINDER_BODY_TEMPLATES.length)];
  return { title: NIGHTLY_REMINDER_TITLE, body };
}

/**
 * Sends one nightly reminder push to a single user. Never throws - a
 * failure here (DB write, web-push call) is reported via reportError and
 * counted as unsuccessful, since one user's failure must never stop the
 * rest of the nightly batch.
 */
async function sendReminderToUser(userId: number): Promise<boolean> {
  try {
    const { title, body } = buildNightlyReminderCopy();
    await sendPushToUser(userId, { type: "nightly_reminder", title, body });
    return true;
  } catch (error) {
    reportError({
      errorType: ERROR_TYPES.API_ERROR,
      route: "notifications/nightly-reminder",
      userId,
      message: error instanceof Error ? error.message : "Failed to send nightly reminder push notification",
      error,
      context: { operation: "sendReminderToUser" },
    });
    return false;
  }
}

/**
 * Cron-triggered batch job (Phase 4, node-cron via instrumentation.ts's
 * register() - see that file for the 23:00 Asia/Tehran schedule) - sends
 * the "nightly_reminder" push to every user who has at least one Web Push
 * subscription on file. Has no HTTP caller, so nothing is thrown back to
 * one - every failure (listing users, sending to one user) is caught,
 * reported, and reflected only in the returned/logged summary counts.
 */
export async function runNightlyReminderJob(): Promise<{ attempted: number; succeeded: number }> {
  let userIds: number[];
  try {
    userIds = await listUserIdsWithPushSubscriptions();
  } catch (error) {
    reportError({
      errorType: ERROR_TYPES.DB_ERROR,
      route: "notifications/nightly-reminder",
      message: error instanceof Error ? error.message : "Failed to list users with push subscriptions",
      error,
      context: { operation: "runNightlyReminderJob" },
    });
    return { attempted: 0, succeeded: 0 };
  }

  let succeeded = 0;
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((userId) => sendReminderToUser(userId)));
    succeeded += results.filter(Boolean).length;
  }

  const summary = { attempted: userIds.length, succeeded };
  logger.info(
    { route: "notifications/nightly-reminder", ...summary, failed: summary.attempted - summary.succeeded },
    "nightly reminder job completed"
  );

  return summary;
}
