import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

// generateGoalStrategy itself (the real NVIDIA NIM call) is out of scope
// here - this file is only about confirming the *feasibility* this route
// computes (specifically its availableBalance apportionment) matches
// listGoalsWithFeasibility for the same goal, same shape as
// lib/goals/strategy.test.ts's own mocking of chatCompletion one layer
// further down. Mocking generateGoalStrategy directly (rather than
// chatCompletion) lets these tests capture the exact GoalFeasibility object
// the route passes it, without needing a real/mocked AI response shape.
vi.mock("@/lib/goals/strategy", () => ({
  generateGoalStrategy: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { generateGoalStrategy } from "@/lib/goals/strategy";
import { POST } from "@/app/api/goals/[id]/strategy/route";
import { listGoalsWithFeasibility } from "@/lib/data/goals";
import type { GoalFeasibility } from "@/lib/goals/feasibility";

const mockedGetSession = vi.mocked(getSession);
const mockedGenerateGoalStrategy = vi.mocked(generateGoalStrategy);

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function makeStrategyRequest(): NextRequest {
  return new NextRequest("http://localhost/api/goals/1/strategy", { method: "POST" });
}

async function postStrategyAndCaptureFeasibility(goalId: number): Promise<GoalFeasibility> {
  const res = await POST(makeStrategyRequest(), { params: Promise.resolve({ id: String(goalId) }) });
  expect(res.status).toBe(200);
  // generateGoalStrategy(goalInput, feasibility, userId) - see
  // lib/goals/strategy.ts's own signature.
  const call = mockedGenerateGoalStrategy.mock.calls.at(-1);
  return call![1];
}

// The consistency bug this file guards against: listGoalsWithFeasibility
// (lib/data/goals.ts) apportions the user's whole account balance evenly
// across their active goals, but this route used to attribute the entire,
// un-split balance to whichever single goal was being strategized - a user
// with several active goals would see a more optimistic, balance-driven
// feasibility here than the goals list showed for that same goal. Both now
// go through the exact same getGoalFeasibilityContext().
// availableBalancePerActiveGoal (lib/goals/feasibility.ts), so these tests
// assert the two surfaces agree rather than re-testing the apportionment
// arithmetic itself (already covered by lib/goals/feasibility.test.ts's own
// getGoalFeasibilityContext describe block).
describe("POST /api/goals/[id]/strategy - availableBalance consistency with the goals list", () => {
  describe("a single-goal user", () => {
    let userId: number;
    let goalId: number;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { phoneNumber: `TEST-GOALS-STRATEGY-SINGLE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
      });
      userId = user.id;
      mockedGetSession.mockResolvedValue(asSession(userId));
      mockedGenerateGoalStrategy.mockResolvedValue({ actions: [], summary: "", generatedAt: new Date().toISOString() });

      await prisma.financeAccount.create({
        data: { userId, name: "حساب تست", type: "cash", initialBalance: 5_000_000 },
      });
      const goal = await prisma.goal.create({
        data: { userId, name: "تنها هدف فعال", category: "other", targetAmount: 60_000_000, deadline: daysFromNow(180) },
      });
      goalId = goal.id;
    });

    afterAll(async () => {
      await prisma.goal.deleteMany({ where: { userId } });
      await prisma.financeAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    });

    it("passes the exact same GoalFeasibility the goals list computes for this goal", async () => {
      const routeFeasibility = await postStrategyAndCaptureFeasibility(goalId);

      const [listedGoal] = await listGoalsWithFeasibility(userId);
      expect(listedGoal.id).toBe(goalId);
      expect(routeFeasibility).toEqual(listedGoal.feasibility);

      // With a single active goal, the whole balance is this goal's share -
      // checked directly against requiredMonthlyAmount's own formula
      // (targetAmount - availableBalance) / monthsRemaining, using the
      // response's own monthsRemaining rather than a hardcoded month count
      // (a real "now"-based Jalali deadline doesn't divide into whole
      // months evenly the way the unit tests' injected `now` does).
      expect(routeFeasibility.requiredMonthlyAmount).toBeCloseTo(
        (60_000_000 - 5_000_000) / routeFeasibility.monthsRemaining,
        6
      );
    });
  });

  describe("a multi-goal user (two active, one abandoned)", () => {
    let userId: number;
    let activeGoalAId: number;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { phoneNumber: `TEST-GOALS-STRATEGY-MULTI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
      });
      userId = user.id;
      mockedGetSession.mockResolvedValue(asSession(userId));
      mockedGenerateGoalStrategy.mockResolvedValue({ actions: [], summary: "", generatedAt: new Date().toISOString() });

      // 9,000,000 total, split across the 2 *active* goals below ->
      // 4,500,000 each. The abandoned goal must be excluded from both the
      // divisor and from receiving a share (same rule
      // listGoalsWithFeasibility's own doc comment describes).
      await prisma.financeAccount.create({
        data: { userId, name: "حساب تست", type: "cash", initialBalance: 9_000_000 },
      });

      const goalA = await prisma.goal.create({
        data: { userId, name: "هدف فعال ۱", category: "other", targetAmount: 60_000_000, deadline: daysFromNow(180) },
      });
      activeGoalAId = goalA.id;
      await prisma.goal.create({
        data: { userId, name: "هدف فعال ۲", category: "other", targetAmount: 30_000_000, deadline: daysFromNow(90) },
      });
      await prisma.goal.create({
        data: {
          userId,
          name: "هدف رهاشده",
          category: "other",
          targetAmount: 10_000_000,
          deadline: daysFromNow(30),
          status: "abandoned",
        },
      });
    });

    afterAll(async () => {
      await prisma.goal.deleteMany({ where: { userId } });
      await prisma.financeAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    });

    it("apportions the same per-goal balance share as the goals list for one of the active goals", async () => {
      const routeFeasibility = await postStrategyAndCaptureFeasibility(activeGoalAId);

      const listed = await listGoalsWithFeasibility(userId);
      const listedGoalA = listed.find((g) => g.id === activeGoalAId)!;
      expect(routeFeasibility).toEqual(listedGoalA.feasibility);

      // Concrete regression guard on the apportionment itself: goal A's
      // requiredMonthlyAmount must reflect a 4,500,000 (9,000,000 / 2
      // active goals) share, not the pre-fix behavior of attributing the
      // full 9,000,000 to whichever single goal was being strategized.
      const expectedWithCorrectSplit = (60_000_000 - 4_500_000) / routeFeasibility.monthsRemaining;
      const expectedWithPreFixBug = (60_000_000 - 9_000_000) / routeFeasibility.monthsRemaining;
      expect(routeFeasibility.requiredMonthlyAmount).toBeCloseTo(expectedWithCorrectSplit, 6);
      expect(routeFeasibility.requiredMonthlyAmount).not.toBeCloseTo(expectedWithPreFixBug, 6);
    });
  });
});
