import "server-only";
import { prisma } from "@/lib/prisma";

// 53 weeks, matching GitHub's own activity-heatmap window.
const HEATMAP_WINDOW_DAYS = 371;

export interface ActivityHeatmapResult {
  // Distinct calendar days (Gregorian "YYYY-MM-DD", since that's what
  // Transaction.date stores) in the window with at least one transaction,
  // mapped to how many were logged that day.
  days: Map<string, number>;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
}

/** Local midnight for `date` (defaults to now) - same day-boundary convention as lib/reports/today-spending.ts's own startOfDay. */
function startOfDay(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const DAY_KEY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Inverse of toDayKey - constructed from local calendar fields (not parsed as a Date string), so it round-trips exactly, DST included. */
function parseDayKey(key: string): Date {
  const match = DAY_KEY_FORMAT.exec(key);
  if (!match) throw new Error(`کلید روز نامعتبر است: "${key}"`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Consecutive active days walking backward from `today` (defaults to now).
 * If today itself has no transaction yet, the streak is checked starting
 * from yesterday instead - a still-open "log something today" streak isn't
 * broken just because it's, say, 9am and nothing's been logged yet. Only
 * falls to 0 once yesterday is empty too.
 */
export function computeCurrentStreak(days: Map<string, number>, today: Date = new Date()): number {
  let cursor = startOfDay(today);
  if (!days.has(toDayKey(cursor))) {
    cursor = addDays(cursor, -1);
    if (!days.has(toDayKey(cursor))) return 0;
  }

  let streak = 0;
  while (days.has(toDayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Longest run of consecutive active days anywhere in `days`, independent of
 * where "today" falls - unlike computeCurrentStreak, a streak that already
 * ended (e.g. last month) still counts here.
 */
export function computeLongestStreak(days: Map<string, number>): number {
  if (days.size === 0) return 0;

  const sortedKeys = [...days.keys()].sort();
  let longest = 1;
  let current = 1;
  let previous = parseDayKey(sortedKeys[0]);

  for (let i = 1; i < sortedKeys.length; i++) {
    current = toDayKey(addDays(previous, 1)) === sortedKeys[i] ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = parseDayKey(sortedKeys[i]);
  }

  return longest;
}

/**
 * Which calendar days (Gregorian, local time) in the last
 * HEATMAP_WINDOW_DAYS (371 = 53 weeks, matching GitHub's own window) the
 * user logged at least one transaction on, plus the streak stats derived
 * from that.
 *
 * One query (findMany + JS-side bucketing), not a Prisma `groupBy`:
 * Transaction.date is a DateTime with time-of-day, so grouping by it
 * directly would split one calendar day across however many distinct
 * timestamps it has instead of bucketing by day - the same reason
 * lib/reports/today-spending.ts and lib/analytics/spending-summary.ts
 * bucket transactions in JS off an already-fetched list rather than asking
 * the DB to group by a raw DateTime column. Served by Transaction's
 * existing @@index([userId, date]) - no schema change needed.
 */
export async function getActivityHeatmap(userId: number): Promise<ActivityHeatmapResult> {
  const todayStart = startOfDay();
  const windowStart = addDays(todayStart, -(HEATMAP_WINDOW_DAYS - 1));
  const windowEnd = addDays(todayStart, 1);

  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: windowStart, lt: windowEnd } },
    select: { date: true },
  });

  const days = new Map<string, number>();
  for (const t of transactions) {
    const key = toDayKey(t.date);
    days.set(key, (days.get(key) ?? 0) + 1);
  }

  return {
    days,
    currentStreak: computeCurrentStreak(days, todayStart),
    longestStreak: computeLongestStreak(days),
    activeDays: days.size,
  };
}
