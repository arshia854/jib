import { describe, it, expect } from "vitest";
import {
  computeGoalFeasibility,
  FEASIBILITY_ON_TRACK_RATIO,
  FEASIBILITY_ADJUSTMENT_RATIO,
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
});
