import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { listGoalsWithFeasibility, GoalNotFoundError, createGoal, updateGoal, deleteGoal } from "@/lib/data/goals";

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

// Phase B1 (savings roadmap): a goal linked to its own dedicated
// FinanceAccount (Goal.savingsAccountId) draws on that account's real
// balance instead of a share of the shared pool. This must not simply move
// the double-counting bug the availableBalance-apportionment suite above
// covers - see lib/goals/feasibility.ts's own doc comments on
// GoalFeasibilityContext/getGoalBalanceInputs for the exact rule this
// exercises end-to-end.
describe("listGoalsWithFeasibility - savingsAccountId (Phase B1 savings roadmap)", () => {
  let userId: number;
  let linkedAccountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-SAVINGS-ACCOUNT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    await prisma.financeAccount.create({
      data: { userId, name: "نقدی", type: "cash", initialBalance: 10_000_000 },
    });
    const linkedAccount = await prisma.financeAccount.create({
      data: { userId, name: "پس‌انداز مرتبط", type: "savings", initialBalance: 4_000_000 },
    });
    linkedAccountId = linkedAccount.id;
    // totalBalance for this user throughout this describe block:
    // 10,000,000 (cash) + 4,000,000 (linked savings) = 14,000,000.
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("a linked goal reports the account's real balance as alreadySaved; an unlinked goal keeps the (correctly shrunk) shared pool", async () => {
    const linkedGoal = await createGoal(userId, {
      name: "هدف مرتبط",
      category: "other",
      targetAmount: 50_000_000,
      deadline: daysFromNow(200),
      savingsAccountId: linkedAccountId,
    });
    const unlinkedGoal = await createGoal(userId, {
      name: "هدف بدون لینک",
      category: "other",
      targetAmount: 30_000_000,
      deadline: daysFromNow(100),
    });

    const goals = await listGoalsWithFeasibility(userId);
    const linked = goals.find((g) => g.id === linkedGoal.id)!;
    const unlinked = goals.find((g) => g.id === unlinkedGoal.id)!;

    expect(linked.savingsAccountId).toBe(linkedAccountId);
    // remainingAmount = targetAmount - initialAmount - alreadySaved -
    // availableBalance. For the linked goal: alreadySaved = 4,000,000 (its
    // account), availableBalance = 0.
    const expectedLinkedRequired = (50_000_000 - 4_000_000) / linked.feasibility.monthsRemaining;
    expect(linked.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedLinkedRequired, 6);

    // For the unlinked goal: alreadySaved = 0, availableBalance = its share
    // of the pool AFTER the linked account's 4,000,000 is earmarked away -
    // sharedPool = 14,000,000 - 4,000,000 = 10,000,000, split across the
    // one unlinked active goal.
    const expectedUnlinkedRequired = (30_000_000 - 10_000_000) / unlinked.feasibility.monthsRemaining;
    expect(unlinked.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedUnlinkedRequired, 6);

    await prisma.goal.deleteMany({ where: { id: { in: [linkedGoal.id, unlinkedGoal.id] } } });
  });

  it("an unlinked goal's shared-pool share shrinks once another active goal links an account", async () => {
    const unlinkedGoal = await createGoal(userId, {
      name: "بدون لینک - قبل",
      category: "other",
      targetAmount: 20_000_000,
      deadline: daysFromNow(120),
    });

    const before = await listGoalsWithFeasibility(userId);
    const beforeGoal = before.find((g) => g.id === unlinkedGoal.id)!;
    // Sole active goal, unlinked - the whole (unearmarked) 14,000,000 total
    // balance is its share.
    const expectedBefore = (20_000_000 - 14_000_000) / beforeGoal.feasibility.monthsRemaining;
    expect(beforeGoal.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedBefore, 6);

    const linkedGoal = await createGoal(userId, {
      name: "مرتبط - بعد",
      category: "other",
      targetAmount: 1_000_000,
      deadline: daysFromNow(60),
      savingsAccountId: linkedAccountId,
    });

    const after = await listGoalsWithFeasibility(userId);
    const afterGoal = after.find((g) => g.id === unlinkedGoal.id)!;
    // Still the only unlinked active goal (divisor unchanged at 1), but the
    // pool itself shrank by the newly linked account's 4,000,000 balance.
    const expectedAfter = (20_000_000 - 10_000_000) / afterGoal.feasibility.monthsRemaining;
    expect(afterGoal.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedAfter, 6);
    expect(afterGoal.feasibility.requiredMonthlyAmount).not.toBeCloseTo(expectedBefore, 6);

    await prisma.goal.deleteMany({ where: { id: { in: [unlinkedGoal.id, linkedGoal.id] } } });
  });

  it("two goals linked to the same account each report its real balance without double-subtracting it from the shared pool", async () => {
    const goalA1 = await createGoal(userId, {
      name: "مشترک ۱",
      category: "other",
      targetAmount: 40_000_000,
      deadline: daysFromNow(150),
      savingsAccountId: linkedAccountId,
    });
    const goalA2 = await createGoal(userId, {
      name: "مشترک ۲",
      category: "other",
      targetAmount: 25_000_000,
      deadline: daysFromNow(150),
      savingsAccountId: linkedAccountId,
    });
    const unlinkedGoal = await createGoal(userId, {
      name: "بدون لینک ۳",
      category: "other",
      targetAmount: 30_000_000,
      deadline: daysFromNow(100),
    });

    const goals = await listGoalsWithFeasibility(userId);
    const a1 = goals.find((g) => g.id === goalA1.id)!;
    const a2 = goals.find((g) => g.id === goalA2.id)!;
    const unlinked = goals.find((g) => g.id === unlinkedGoal.id)!;

    // Both goals sharing the account each get its FULL 4,000,000 balance as
    // their own alreadySaved - not halved between them.
    const expectedA1 = (40_000_000 - 4_000_000) / a1.feasibility.monthsRemaining;
    const expectedA2 = (25_000_000 - 4_000_000) / a2.feasibility.monthsRemaining;
    expect(a1.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedA1, 6);
    expect(a2.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedA2, 6);

    // The shared pool must be reduced by the account's balance exactly once
    // (sharedPool = 14,000,000 - 4,000,000 = 10,000,000) - not twice, which
    // would wrongly leave only 6,000,000 for the unlinked goal.
    const expectedUnlinked = (30_000_000 - 10_000_000) / unlinked.feasibility.monthsRemaining;
    expect(unlinked.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedUnlinked, 6);

    await prisma.goal.deleteMany({ where: { id: { in: [goalA1.id, goalA2.id, unlinkedGoal.id] } } });
  });

  it("clearing a link via updateGoal(savingsAccountId: null) reverts the goal to shared-pool behavior", async () => {
    // targetAmount deliberately large enough that neither state below is
    // "fully funded" (computeGoalFeasibility clamps requiredMonthlyAmount to
    // 0, not negative, once alreadySaved+availableBalance >= targetAmount -
    // see its own isFullyFunded branch) - otherwise the 14,000,000 unearmarked
    // pool alone would already exceed a smaller target and mask the revert.
    const goal = await createGoal(userId, {
      name: "قابل لغو",
      category: "other",
      targetAmount: 20_000_000,
      deadline: daysFromNow(90),
      savingsAccountId: linkedAccountId,
    });

    const linkedResult = await listGoalsWithFeasibility(userId);
    const linkedGoal = linkedResult.find((g) => g.id === goal.id)!;
    const expectedLinked = (20_000_000 - 4_000_000) / linkedGoal.feasibility.monthsRemaining;
    expect(linkedGoal.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedLinked, 6);

    await updateGoal(userId, goal.id, { savingsAccountId: null });

    const unlinkedResult = await listGoalsWithFeasibility(userId);
    const unlinkedGoal = unlinkedResult.find((g) => g.id === goal.id)!;
    expect(unlinkedGoal.savingsAccountId).toBeNull();
    // Reverted to shared-pool apportionment - the sole active goal now gets
    // the whole (unearmarked) 14,000,000 total balance as its share again.
    const expectedUnlinked = (20_000_000 - 14_000_000) / unlinkedGoal.feasibility.monthsRemaining;
    expect(unlinkedGoal.feasibility.requiredMonthlyAmount).toBeCloseTo(expectedUnlinked, 6);

    await prisma.goal.delete({ where: { id: goal.id } });
  });

  it("createGoal rejects a savingsAccountId belonging to another user", async () => {
    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-SAVINGS-ACCOUNT-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUser.id, name: "حساب کاربر دیگر", type: "savings", initialBalance: 0 },
    });

    await expect(
      createGoal(userId, {
        name: "تلاش نامعتبر",
        category: "other",
        targetAmount: 1_000_000,
        deadline: daysFromNow(30),
        savingsAccountId: otherAccount.id,
      })
    ).rejects.toThrow();

    await prisma.financeAccount.deleteMany({ where: { userId: otherUser.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
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
