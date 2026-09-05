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
