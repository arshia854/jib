import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { listGoalsWithFeasibility, GoalNotFoundError, updateGoal, deleteGoal } from "@/lib/data/goals";

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

describe("listGoalsWithFeasibility", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-DATA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    // Deliberately created out of both target orders (deadline descending,
    // status interleaved) so the assertions below actually exercise the
    // sort rather than happening to match creation order.
    await prisma.goal.create({
      data: { userId, name: "بایگانی‌شده", category: "other", targetAmount: 1000, deadline: daysFromNow(10), status: "abandoned" },
    });
    await prisma.goal.create({
      data: { userId, name: "فعال - دورتر", category: "other", targetAmount: 1000, deadline: daysFromNow(200) },
    });
    await prisma.goal.create({
      data: { userId, name: "فعال - نزدیک‌تر", category: "other", targetAmount: 1000, deadline: daysFromNow(50) },
    });
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("sorts active goals first, then by deadline ascending, with each goal's feasibility attached", async () => {
    const goals = await listGoalsWithFeasibility(userId);

    expect(goals.map((g) => g.name)).toEqual(["فعال - نزدیک‌تر", "فعال - دورتر", "بایگانی‌شده"]);
    for (const goal of goals) {
      expect(goal.feasibility).toBeDefined();
      expect(typeof goal.feasibility.feasibilityStatus).toBe("string");
      expect(goal.feasibility.monthsRemaining).toBeGreaterThanOrEqual(1);
    }
  });
});

// getGoalFeasibilityContext's own describe block (lib/goals/
// feasibility.test.ts) already covers the availableBalancePerActiveGoal
// arithmetic itself in isolation; this confirms listGoalsWithFeasibility
// actually reads that shared value (rather than re-deriving its own,
// possibly-drifting version of it - the bug app/api/goals/[id]/strategy/
// route.ts had before it was pointed at the same shared context field, see
// that route's own test file for the equivalent check on that surface).
describe("listGoalsWithFeasibility - availableBalance apportionment across active goals", () => {
  let userId: number;
  let activeGoalAId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-DATA-BALANCE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash", initialBalance: 9_000_000 },
    });

    const goalA = await prisma.goal.create({
      data: { userId, name: "فعال ۱", category: "other", targetAmount: 60_000_000, deadline: daysFromNow(180) },
    });
    activeGoalAId = goalA.id;
    await prisma.goal.create({
      data: { userId, name: "فعال ۲", category: "other", targetAmount: 30_000_000, deadline: daysFromNow(90) },
    });
    await prisma.goal.create({
      data: { userId, name: "رهاشده", category: "other", targetAmount: 5_000_000, deadline: daysFromNow(30), status: "abandoned" },
    });
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("attributes a 9,000,000 / 2-active-goals = 4,500,000 share to an active goal, not the whole balance", async () => {
    const goals = await listGoalsWithFeasibility(userId);
    const goalA = goals.find((g) => g.id === activeGoalAId)!;

    const expectedWithCorrectSplit = (60_000_000 - 4_500_000) / goalA.feasibility.monthsRemaining;
    const expectedWithFullBalance = (60_000_000 - 9_000_000) / goalA.feasibility.monthsRemaining;
    expect(goalA.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedWithCorrectSplit, 6);
    expect(goalA.feasibility.requiredMonthlyAmount).not.toBeCloseTo(expectedWithFullBalance, 6);
  });

  it("attributes no balance share to the abandoned goal", async () => {
    const goals = await listGoalsWithFeasibility(userId);
    const abandoned = goals.find((g) => g.name === "رهاشده")!;

    // No availableBalance at all -> requiredMonthlyAmount is the raw
    // targetAmount / monthsRemaining, unaffected by the account balance.
    expect(abandoned.feasibility.requiredMonthlyAmount).toBeCloseTo(
      5_000_000 / abandoned.feasibility.monthsRemaining,
      6
    );
  });
});

describe("updateGoal / deleteGoal - not found", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-DATA-NOTFOUND-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  it("updateGoal throws GoalNotFoundError for a non-existent id", async () => {
    await expect(updateGoal(userId, 999_999_999, { status: "achieved" })).rejects.toThrow(GoalNotFoundError);
  });

  it("deleteGoal throws GoalNotFoundError for a non-existent id", async () => {
    await expect(deleteGoal(userId, 999_999_999)).rejects.toThrow(GoalNotFoundError);
  });
});
