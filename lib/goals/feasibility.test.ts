import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import {
  computeGoalFeasibility,
  getActualMonthlyAverage,
  getGoalFeasibilityContext,
  FEASIBILITY_ON_TRACK_RATIO,
  FEASIBILITY_ADJUSTMENT_RATIO,
  FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME,
  FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME,
  type GoalFeasibilityInput,
} from "@/lib/goals/feasibility";

// Fixed "now"/"deadline" pair whose Jalali calendar dates are exactly 6
// months apart on the same day-of-month (1405-06-14 -> 1405-12-14, verified
// against jalaali-js directly) - monthsUntil should report exactly 6, no
// rounding up, since there's no trailing partial month.
const NOW = new Date("2026-09-05T00:00:00.000Z");
const DEADLINE_6_MONTHS = new Date("2027-03-05T00:00:00.000Z");

// The task's own MacBook example: 60,000,000 Toman target, 6 months out,
// 12,000,000 already saved up front - remainingAmount = 48,000,000, and
// requiredMonthlyAmount = 48,000,000 / 6 = 8,000,000 exactly, chosen so the
// ratio math below stays in clean round numbers.
function input(overrides: Partial<GoalFeasibilityInput> = {}): GoalFeasibilityInput {
  return {
    targetAmount: 60_000_000,
    initialAmount: 12_000_000,
    alreadySaved: 0,
    availableBalance: 0,
    deadline: DEADLINE_6_MONTHS,
    actualMonthlyAverage: 8_000_000,
    now: NOW,
    ...overrides,
  };
}

describe("computeGoalFeasibility", () => {
  it("MacBook example: 60,000,000 Toman / 6 months / 12,000,000 initial, hitting the required amount exactly", () => {
    const result = computeGoalFeasibility(input());

    // Hand-verified: (60,000,000 - 12,000,000 - 0) / 6 = 8,000,000.
    expect(result.monthsRemaining).toBe(6);
    expect(result.requiredMonthlyAmount).toBe(8_000_000);
    expect(result.actualMonthlyAverage).toBe(8_000_000);
    expect(result.feasibilityRatio).toBe(1);
    expect(result.feasibilityStatus).toBe("on_track");
    expect(result.gap).toBe(0);
    // ceil(48,000,000 / 8,000,000) = 6.
    expect(result.projectedCompletionMonths).toBe(6);
  });

  it("on_track at the exact FEASIBILITY_ON_TRACK_RATIO boundary (1.0)", () => {
    // 8,400,000 / 8,000,000 = 1.05, safely above 1.0 - also check the exact
    // boundary value itself via a ratio of precisely 1.0 (the default input
    // above already covers 1.0; this covers a value clearly above it).
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: 8_400_000 }));
    expect(result.feasibilityRatio).toBe(1.05);
    expect(result.feasibilityRatio).toBeGreaterThanOrEqual(FEASIBILITY_ON_TRACK_RATIO);
    expect(result.feasibilityStatus).toBe("on_track");
  });

  it("needs_adjustment at the exact FEASIBILITY_ADJUSTMENT_RATIO boundary (0.7)", () => {
    // 5,600,000 / 8,000,000 = 0.7 exactly.
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: 5_600_000 }));
    expect(result.feasibilityRatio).toBe(FEASIBILITY_ADJUSTMENT_RATIO);
    expect(result.feasibilityStatus).toBe("needs_adjustment");
  });

  it("needs_adjustment just below the on_track boundary", () => {
    // 7,600,000 / 8,000,000 = 0.95.
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: 7_600_000 }));
    expect(result.feasibilityRatio).toBe(0.95);
    expect(result.feasibilityStatus).toBe("needs_adjustment");
  });

  it("unrealistic just below the FEASIBILITY_ADJUSTMENT_RATIO boundary", () => {
    // 5,520,000 / 8,000,000 = 0.69 exactly.
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: 5_520_000 }));
    expect(result.feasibilityRatio).toBe(0.69);
    expect(result.feasibilityStatus).toBe("unrealistic");
  });

  it("unrealistic (and projectedCompletionMonths null) when actualMonthlyAverage is zero", () => {
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: 0 }));
    expect(result.feasibilityStatus).toBe("unrealistic");
    expect(result.projectedCompletionMonths).toBeNull();
  });

  it("unrealistic (and projectedCompletionMonths null) when actualMonthlyAverage is negative", () => {
    const result = computeGoalFeasibility(input({ actualMonthlyAverage: -500_000 }));
    expect(result.feasibilityStatus).toBe("unrealistic");
    expect(result.projectedCompletionMonths).toBeNull();
    // gap is still a plain, non-clamped number (can be very large/negative).
    expect(result.gap).toBe(8_000_000 - -500_000);
  });

  it("clamps requiredMonthlyAmount to 0 and is on_track when the goal is already fully funded via initialAmount alone", () => {
    const result = computeGoalFeasibility(
      input({ targetAmount: 60_000_000, initialAmount: 60_000_000, alreadySaved: 0, actualMonthlyAverage: -1_000_000 })
    );
    expect(result.requiredMonthlyAmount).toBe(0);
    expect(result.feasibilityStatus).toBe("on_track");
    expect(result.projectedCompletionMonths).toBe(0);
  });

  it("clamps requiredMonthlyAmount to 0 when initialAmount + alreadySaved together exceed targetAmount", () => {
    const result = computeGoalFeasibility(
      input({ targetAmount: 60_000_000, initialAmount: 30_000_000, alreadySaved: 40_000_000, actualMonthlyAverage: 0 })
    );
    expect(result.requiredMonthlyAmount).toBe(0);
    expect(result.feasibilityStatus).toBe("on_track");
    expect(result.projectedCompletionMonths).toBe(0);
  });

  it("monthsRemaining rounds up a trailing partial month (deadline's day-of-month is later than now's)", () => {
    // 1405-12-20 (deadline) vs 1405-06-14 (now): 6 whole months plus a
    // trailing few days -> rounds up to 7.
    const result = computeGoalFeasibility(input({ deadline: new Date("2027-03-11T00:00:00.000Z") }));
    expect(result.monthsRemaining).toBe(7);
  });

  it("monthsRemaining does not round up when deadline's day-of-month is earlier than now's", () => {
    // 1405-12-10 (deadline) vs 1405-06-14 (now): whole-month diff is already
    // 6 and the deadline falls slightly *before* reaching that 6th month
    // mark day-wise, so no trailing partial month is added - stays at 6,
    // not rounded down to 5 either.
    const result = computeGoalFeasibility(input({ deadline: new Date("2027-03-01T00:00:00.000Z") }));
    expect(result.monthsRemaining).toBe(6);
  });

  it("monthsRemaining clamps to a minimum of 1 for a deadline that has already passed", () => {
    const result = computeGoalFeasibility(input({ deadline: new Date("2026-01-01T00:00:00.000Z") }));
    expect(result.monthsRemaining).toBe(1);
  });

  describe("availableBalance (current account balance toward the goal)", () => {
    it("fully funds a goal via availableBalance alone, on_track even with no/negative cash flow", () => {
      // remainingAmount = 60,000,000 - 12,000,000 - 0 - 48,000,000 = 0.
      const result = computeGoalFeasibility(input({ availableBalance: 48_000_000, actualMonthlyAverage: -1_000_000 }));
      expect(result.requiredMonthlyAmount).toBe(0);
      expect(result.feasibilityStatus).toBe("on_track");
      expect(result.projectedCompletionMonths).toBe(0);
    });

    it("lowers requiredMonthlyAmount (and can flip needs_adjustment to on_track) when only partially covered by balance", () => {
      // Without availableBalance: (60,000,000 - 12,000,000) / 6 = 8,000,000
      // required, 5,600,000 actual -> ratio 0.7 -> needs_adjustment (see the
      // boundary test above). A 24,000,000 balance share drops
      // remainingAmount to 24,000,000, requiredMonthlyAmount to 4,000,000,
      // so the same 5,600,000 actual average is now comfortably on_track.
      const result = computeGoalFeasibility(input({ availableBalance: 24_000_000, actualMonthlyAverage: 5_600_000 }));
      expect(result.requiredMonthlyAmount).toBe(4_000_000);
      expect(result.feasibilityRatio).toBe(1.4);
      expect(result.feasibilityStatus).toBe("on_track");
    });
  });

  describe("actualMonthlyAverage: null (not enough transaction history yet)", () => {
    it("is needs_adjustment, not unrealistic - the fix for 'every new goal is flagged unrealistic'", () => {
      // Same shape as a brand-new Jib user: no closed lookback month has any
      // logged transactions yet (getActualMonthlyAverage returns null), so
      // there is genuinely no cash-flow evidence either way. Previously this
      // path coerced straight to 0 and fell into the `actualMonthlyAverage
      // <= 0` branch, i.e. "unrealistic" unconditionally, regardless of the
      // goal's own numbers.
      const result = computeGoalFeasibility(input({ actualMonthlyAverage: null }));
      expect(result.feasibilityStatus).toBe("needs_adjustment");
      expect(result.projectedCompletionMonths).toBeNull();
      // Still reports a real requiredMonthlyAmount/gap so the UI can show
      // "you'd need to save X/month" even without a historical baseline.
      expect(result.requiredMonthlyAmount).toBe(8_000_000);
      expect(result.gap).toBe(8_000_000);
    });

    it("is still on_track outright when fully funded (availableBalance/initialAmount), even with no history", () => {
      const result = computeGoalFeasibility(
        input({ availableBalance: 48_000_000, actualMonthlyAverage: null })
      );
      expect(result.feasibilityStatus).toBe("on_track");
      expect(result.projectedCompletionMonths).toBe(0);
    });
  });

  describe("incomeRegularity: irregular income gets a wider (more conservative) band", () => {
    it("a ratio that is on_track for regular income is only needs_adjustment for irregular income", () => {
      // 8,800,000 / 8,000,000 = 1.1 - above FEASIBILITY_ON_TRACK_RATIO (1.0)
      // but below FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME (1.25).
      const regular = computeGoalFeasibility(
        input({ actualMonthlyAverage: 8_800_000, incomeRegularity: "regular" })
      );
      const irregular = computeGoalFeasibility(
        input({ actualMonthlyAverage: 8_800_000, incomeRegularity: "irregular" })
      );
      expect(regular.feasibilityRatio).toBe(1.1);
      expect(regular.feasibilityStatus).toBe("on_track");
      expect(irregular.feasibilityRatio).toBe(1.1);
      expect(irregular.feasibilityStatus).toBe("needs_adjustment");
    });

    it("a ratio that is on_track above the irregular threshold is on_track for irregular income too", () => {
      // 10,400,000 / 8,000,000 = 1.3, above FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME (1.25).
      const result = computeGoalFeasibility(
        input({ actualMonthlyAverage: 10_400_000, incomeRegularity: "irregular" })
      );
      expect(result.feasibilityRatio).toBe(1.3);
      expect(result.feasibilityRatio).toBeGreaterThanOrEqual(FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME);
      expect(result.feasibilityStatus).toBe("on_track");
    });

    it("a ratio that is unrealistic for regular income is only needs_adjustment for irregular income", () => {
      // 4,800,000 / 8,000,000 = 0.6 - below FEASIBILITY_ADJUSTMENT_RATIO
      // (0.7, regular income unrealistic) but above
      // FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME (0.5).
      const regular = computeGoalFeasibility(
        input({ actualMonthlyAverage: 4_800_000, incomeRegularity: "regular" })
      );
      const irregular = computeGoalFeasibility(
        input({ actualMonthlyAverage: 4_800_000, incomeRegularity: "irregular" })
      );
      expect(regular.feasibilityStatus).toBe("unrealistic");
      expect(irregular.feasibilityStatus).toBe("needs_adjustment");
    });

    it("a ratio below the irregular threshold is still unrealistic for irregular income", () => {
      // 3,600,000 / 8,000,000 = 0.45, below FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME (0.5).
      const result = computeGoalFeasibility(
        input({ actualMonthlyAverage: 3_600_000, incomeRegularity: "irregular" })
      );
      expect(result.feasibilityRatio).toBe(0.45);
      expect(result.feasibilityRatio).toBeLessThan(FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME);
      expect(result.feasibilityStatus).toBe("unrealistic");
    });

    it("treats a missing/null incomeRegularity the same as regular income", () => {
      // Same 0.6 ratio as the "regular" case above - undefined incomeRegularity
      // (the field omitted entirely) must not accidentally get the wider
      // irregular-income band without evidence.
      const result = computeGoalFeasibility(input({ actualMonthlyAverage: 4_800_000 }));
      expect(result.feasibilityStatus).toBe("unrealistic");
    });
  });
});

// getActualMonthlyAverage/getGoalFeasibilityContext genuinely query the DB
// (unlike computeGoalFeasibility above), so these mirror lib/analytics/
// spending-summary.test.ts's own fixture/cleanup convention: real users,
// accounts, categories and transactions against the actual (test-DB-pointed,
// see vitest.config.ts) prisma client rather than a mock.
const currentRange = getJalaaliMonthRange();
// The most recent of the 3 trailing *closed* months getActualMonthlyAverage's
// default lookback covers (its own cursor loop walks "immediately-prior
// first") - the only one of the 3 the tests below populate with data.
const range1 = getJalaaliMonthRange(new Date(currentRange.start.getTime() - 1));

function dateInMonth(range: { start: Date }, dayOffset: number): Date {
  return new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + dayOffset);
}

async function makeUserWithAccount(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-GOALS-FEASIBILITY-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  const account = await prisma.financeAccount.create({
    data: { userId: user.id, name: "حساب تست", type: "cash", initialBalance: 0 },
  });
  return { userId: user.id, accountId: account.id };
}

async function cleanup(userId: number) {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.userFact.deleteMany({ where: { userId } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.financeAccount.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("getActualMonthlyAverage", () => {
  let emptyUserId: number;
  let singleActiveMonthUserId: number;
  let singleActiveMonthAccountId: number;

  beforeAll(async () => {
    ({ userId: emptyUserId } = await makeUserWithAccount("EMPTY"));

    const { userId, accountId } = await makeUserWithAccount("SINGLE-ACTIVE-MONTH");
    singleActiveMonthUserId = userId;
    singleActiveMonthAccountId = accountId;
    const [income, expense] = await Promise.all([
      prisma.category.create({
        data: { userId, name: "حقوق تست فیزیبیلیتی", icon: "💰", color: "#200001", type: "income" },
      }),
      prisma.category.create({
        data: { userId, name: "خرج تست فیزیبیلیتی", icon: "🧾", color: "#200002", type: "expense" },
      }),
    ]);
    // Only range1 (the most recent closed month) gets any transactions -
    // range2/range3 are left entirely empty, simulating a user who only
    // started logging transactions in Jib one month ago.
    await Promise.all([
      prisma.transaction.create({
        data: {
          userId,
          accountId: singleActiveMonthAccountId,
          categoryId: income.id,
          amount: 3_000_000,
          type: "income",
          rawInput: "تست",
          date: dateInMonth(range1, 3),
        },
      }),
      prisma.transaction.create({
        data: {
          userId,
          accountId: singleActiveMonthAccountId,
          categoryId: expense.id,
          amount: 1_000_000,
          type: "expense",
          rawInput: "تست",
          date: dateInMonth(range1, 5),
        },
      }),
    ]);
  });

  afterAll(async () => {
    await cleanup(emptyUserId);
    await cleanup(singleActiveMonthUserId);
  });

  it("returns null (not 0) when none of the lookback months have any logged transaction", async () => {
    await expect(getActualMonthlyAverage(emptyUserId)).resolves.toBeNull();
  });

  it("averages only over months with real activity, not diluted by empty months counted as 0", async () => {
    // net = 3,000,000 - 1,000,000 = 2,000,000, from range1 alone. The old,
    // buggy behavior would have divided this same 2,000,000 net by all 3
    // lookback months (range2/range3 contributing a literal 0 each),
    // yielding ~666,667 instead - a ~3x understatement purely from lack of
    // history, not from any real drop in income.
    await expect(getActualMonthlyAverage(singleActiveMonthUserId)).resolves.toBe(2_000_000);
  });
});

describe("getGoalFeasibilityContext", () => {
  let userId: number;

  beforeAll(async () => {
    ({ userId } = await makeUserWithAccount("CONTEXT"));
    await prisma.financeAccount.updateMany({ where: { userId }, data: { initialBalance: 5_000_000 } });
    await prisma.userFact.create({
      data: { userId, key: "income_regularity", value: "irregular", source: "user_stated" },
    });
  });

  afterAll(async () => {
    await cleanup(userId);
  });

  it("bundles totalBalance (getTotalBalance) and incomeRegularity (getUserFacts) alongside actualMonthlyAverage", async () => {
    const context = await getGoalFeasibilityContext(userId);
    expect(context.totalBalance).toBe(5_000_000);
    expect(context.incomeRegularity).toBe("irregular");
    // No transactions were created for this user - same "no history yet"
    // case getActualMonthlyAverage's own describe block covers above.
    expect(context.actualMonthlyAverage).toBeNull();
  });

  it("incomeRegularity is null when no income_regularity UserFact has been recorded", async () => {
    const { userId: freshUserId } = await makeUserWithAccount("CONTEXT-NO-FACT");
    try {
      const context = await getGoalFeasibilityContext(freshUserId);
      expect(context.incomeRegularity).toBeNull();
    } finally {
      await cleanup(freshUserId);
    }
  });

  it("activeGoalCount/availableBalancePerActiveGoal: 0 and 0 with no goals at all", async () => {
    const { userId: freshUserId } = await makeUserWithAccount("CONTEXT-NO-GOALS");
    try {
      const context = await getGoalFeasibilityContext(freshUserId);
      expect(context.activeGoalCount).toBe(0);
      expect(context.availableBalancePerActiveGoal).toBe(0);
    } finally {
      await cleanup(freshUserId);
    }
  });

  it("availableBalancePerActiveGoal equals the whole balance with exactly one active goal", async () => {
    const { userId: freshUserId } = await makeUserWithAccount("CONTEXT-SINGLE-GOAL");
    await prisma.financeAccount.updateMany({ where: { userId: freshUserId }, data: { initialBalance: 5_000_000 } });
    await prisma.goal.create({
      data: { userId: freshUserId, name: "هدف تست", category: "other", targetAmount: 10_000_000, deadline: new Date("2027-01-01") },
    });
    try {
      const context = await getGoalFeasibilityContext(freshUserId);
      expect(context.activeGoalCount).toBe(1);
      expect(context.availableBalancePerActiveGoal).toBe(5_000_000);
    } finally {
      await cleanup(freshUserId);
    }
  });

  // This is the exact number both listGoalsWithFeasibility (lib/data/
  // goals.ts) and the single-goal strategy route (app/api/goals/[id]/
  // strategy/route.ts) now read - see this field's own doc comment above on
  // why it lives here instead of being computed separately by each caller.
  it("splits totalBalance evenly across active goals only, excluding achieved/abandoned goals from the divisor", async () => {
    const { userId: freshUserId } = await makeUserWithAccount("CONTEXT-MULTI-GOAL");
    await prisma.financeAccount.updateMany({ where: { userId: freshUserId }, data: { initialBalance: 9_000_000 } });
    await Promise.all([
      prisma.goal.create({
        data: { userId: freshUserId, name: "فعال ۱", category: "other", targetAmount: 10_000_000, deadline: new Date("2027-01-01") },
      }),
      prisma.goal.create({
        data: { userId: freshUserId, name: "فعال ۲", category: "other", targetAmount: 20_000_000, deadline: new Date("2027-06-01") },
      }),
      prisma.goal.create({
        data: {
          userId: freshUserId,
          name: "رهاشده",
          category: "other",
          targetAmount: 5_000_000,
          deadline: new Date("2027-01-01"),
          status: "abandoned",
        },
      }),
    ]);
    try {
      const context = await getGoalFeasibilityContext(freshUserId);
      // 2 active goals - the abandoned one is excluded from the count.
      expect(context.activeGoalCount).toBe(2);
      expect(context.availableBalancePerActiveGoal).toBe(4_500_000);
    } finally {
      await cleanup(freshUserId);
    }
  });
});
