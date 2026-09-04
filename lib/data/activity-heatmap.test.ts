import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getActivityHeatmap, computeCurrentStreak, computeLongestStreak } from "@/lib/data/activity-heatmap";

// Independent re-implementation of the module's private toDayKey() -
// deliberately not imported, so the DB-backed tests below prove
// getActivityHeatmap() actually buckets by the same calendar day a caller
// would compute independently, rather than just trusting the helper the
// production code uses internally (same precedent as lib/data/
// transactions.test.ts's own standalone jalaaliMonthKey()).
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Local noon, n days before real "now" - noon (not midnight) keeps every
// constructed date safely clear of its own day's boundary regardless of the
// runner's timezone, matching lib/reports/today-spending.test.ts's own
// yesterday-at-noon fixture style.
function daysAgo(n: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12, 0, 0);
}

describe("computeCurrentStreak", () => {
  const today = new Date(2026, 0, 10); // arbitrary fixed "today", not the real clock - keeps these tests deterministic

  it("returns 0 for an empty map", () => {
    expect(computeCurrentStreak(new Map(), today)).toBe(0);
  });

  it("counts a run of consecutive days ending today", () => {
    const days = new Map([
      ["2026-01-08", 1],
      ["2026-01-09", 1],
      ["2026-01-10", 1],
    ]);
    expect(computeCurrentStreak(days, today)).toBe(3);
  });

  it("still counts the streak when today has no transaction yet but yesterday does", () => {
    const days = new Map([
      ["2026-01-08", 1],
      ["2026-01-09", 1],
    ]);
    expect(computeCurrentStreak(days, today)).toBe(2);
  });

  it("returns 0 when neither today nor yesterday has a transaction", () => {
    const days = new Map([["2026-01-05", 1]]);
    expect(computeCurrentStreak(days, today)).toBe(0);
  });

  it("stops counting at the first gap", () => {
    const days = new Map([
      ["2026-01-10", 1],
      ["2026-01-09", 1],
      // gap: 2026-01-08 missing
      ["2026-01-06", 1],
    ]);
    expect(computeCurrentStreak(days, today)).toBe(2);
  });
});

describe("computeLongestStreak", () => {
  it("returns 0 for an empty map", () => {
    expect(computeLongestStreak(new Map())).toBe(0);
  });

  it("returns 1 for a single active day", () => {
    expect(computeLongestStreak(new Map([["2026-01-05", 1]]))).toBe(1);
  });

  it("finds the longest run across a gap", () => {
    const days = new Map([
      ["2026-01-01", 1],
      ["2026-01-02", 1],
      ["2026-01-03", 1],
      // gap
      ["2026-01-10", 1],
      ["2026-01-11", 1],
    ]);
    expect(computeLongestStreak(days)).toBe(3);
  });

  it("differs from computeCurrentStreak when the longest run already ended", () => {
    const today = new Date(2026, 0, 10);
    // A 5-day run early in the month (already over), then a gap, then a
    // shorter 2-day run ending today.
    const days = new Map([
      ["2026-01-01", 1],
      ["2026-01-02", 1],
      ["2026-01-03", 1],
      ["2026-01-04", 1],
      ["2026-01-05", 1],
      ["2026-01-09", 1],
      ["2026-01-10", 1],
    ]);

    expect(computeLongestStreak(days)).toBe(5);
    expect(computeCurrentStreak(days, today)).toBe(2);
  });
});

// DB-backed: proves getActivityHeatmap()'s own query + bucketing (not just
// the pure compute* functions above) against this project's real Prisma
// test-DB setup, same fixture pattern as lib/data/dashboard.test.ts.
describe("getActivityHeatmap", () => {
  let userId: number;
  let accountId: number;
  let categoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ACTIVITY-HEATMAP-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "دسته تست فعالیت", icon: "🧪", color: "#050505", type: "expense" },
    });
    categoryId = category.id;

    const makeTxn = (date: Date) =>
      prisma.transaction.create({
        data: { userId, accountId, categoryId, amount: 10000, type: "expense", rawInput: "تست", date },
      });

    await Promise.all([
      // Today: two transactions -> should bucket into one day, count 2.
      makeTxn(daysAgo(0)),
      makeTxn(daysAgo(0)),
      // Yesterday: continues the current streak.
      makeTxn(daysAgo(1)),
      // Gap at daysAgo(2)-(4), then a 3-day run further back - the longest
      // streak in the window, longer than the 2-day current one above.
      makeTxn(daysAgo(5)),
      makeTxn(daysAgo(6)),
      makeTxn(daysAgo(7)),
      // Well outside the 371-day window - must be excluded entirely.
      makeTxn(daysAgo(400)),
    ]);
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("buckets same-day transactions together and excludes anything outside the window", async () => {
    const result = await getActivityHeatmap(userId);

    expect(result.days.get(dayKey(daysAgo(0)))).toBe(2);
    expect(result.days.get(dayKey(daysAgo(1)))).toBe(1);
    expect(result.days.has(dayKey(daysAgo(400)))).toBe(false);
    expect(result.activeDays).toBe(5); // daysAgo(0), (1), (5), (6), (7)
  });

  it("computes currentStreak and longestStreak from the real data, and they differ", async () => {
    const result = await getActivityHeatmap(userId);

    expect(result.currentStreak).toBe(2); // today + yesterday, stops at the gap
    expect(result.longestStreak).toBe(3); // the daysAgo(5..7) run
  });
});

describe("getActivityHeatmap - empty state", () => {
  it("returns an empty map and zero streaks for a user with no transactions", async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ACTIVITY-HEATMAP-EMPTY-${Date.now()}` },
    });

    try {
      const result = await getActivityHeatmap(user.id);

      expect(result.days.size).toBe(0);
      expect(result.activeDays).toBe(0);
      expect(result.currentStreak).toBe(0);
      expect(result.longestStreak).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    }
  });
});
