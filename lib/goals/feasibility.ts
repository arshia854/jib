import "server-only";
import { toJalaali } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { summarizeMonth } from "@/lib/analytics/spending-summary";

type PrismaClient = typeof prisma;

// Ratio (actualMonthlyAverage / requiredMonthlyAmount) thresholds for
// feasibilityStatus below. Named/documented rather than left as magic
// numbers, same precedent as UNUSUAL_TRANSACTION_MULTIPLIER/
// RECURRING_EXPENSE_LOOKBACK_MONTHS in lib/analytics/spending-summary.ts -
// a rule-of-thumb figure, not derived from this app's own data (no
// calibration data exists for this feature yet).
//
// >= 1.0: the user's typical monthly net cash flow already covers (or
// exceeds) what the goal requires - "on_track".
// 0.7-1.0: covers a meaningful majority of what's required but would still
// fall short on the current deadline - "needs_adjustment" (the deadline or
// target may need to move, but it isn't a stretch).
// below 0.7 (or a non-positive actual average - see computeGoalFeasibility):
// "unrealistic" as currently framed.
export const FEASIBILITY_ON_TRACK_RATIO = 1.0;
export const FEASIBILITY_ADJUSTMENT_RATIO = 0.7;

// How many trailing, *complete* Jalali months getActualMonthlyAverage
// averages over. Deliberately the last `GOAL_LOOKBACK_MONTHS` *closed*
// months - NOT current-month-inclusive like
// RECURRING_EXPENSE_LOOKBACK_MONTHS's own "current + the 2 before it"
// window (lib/analytics/spending-summary.ts). That window suits recurring-
// expense *detection* fine (a still-open month can still show a description
// showed up "present" or not), but actualMonthlyAverage is an arithmetic
// average feeding a feasibility ratio - mixing in a still-accruing partial
// month would bias it (e.g. income already posted but this month's
// expenses not fully logged yet inflates the average; the reverse deflates
// it), for no benefit over just using whole, settled months. 3 is the same
// figure as RECURRING_EXPENSE_LOOKBACK_MONTHS for the same reason that
// number was chosen there: long enough to smooth over one atypical month,
// short enough to still reflect the user's *current* spending pattern
// rather than very old history.
export const GOAL_LOOKBACK_MONTHS = 3;

export type FeasibilityStatus = "on_track" | "needs_adjustment" | "unrealistic";

export interface GoalFeasibility {
  requiredMonthlyAmount: number;
  actualMonthlyAverage: number;
  feasibilityRatio: number;
  feasibilityStatus: FeasibilityStatus;
  projectedCompletionMonths: number | null;
  gap: number;
  monthsRemaining: number;
}

export interface GoalFeasibilityInput {
  targetAmount: number;
  initialAmount: number;
  // Progress this phase can attribute to the user's tracked net cash flow
  // *since* the goal was created, on top of initialAmount - kept as its own
  // input (rather than folded into initialAmount) so a later phase's real
  // tracking dashboard can compute and pass a non-zero value without
  // changing this function's contract. Phase 1 has no such tracking source
  // yet (see prisma/schema.prisma's Goal model and lib/data/goals.ts), so
  // every current caller passes 0.
  alreadySaved: number;
  deadline: Date;
  // Average net (income - expense) per month over the lookback window -
  // see getActualMonthlyAverage below for how a real caller computes this.
  actualMonthlyAverage: number;
  // Injectable for tests (mirrors this codebase's existing "now" injection
  // pattern, e.g. lib/reports/*'s periodToGregorianRange callers) - defaults
  // to the real current time.
  now?: Date;
}

/**
 * Number of Jalali months from `now` to `deadline`, rounded up, minimum 1 -
 * computed via jalaali-js's own calendar fields (not a naive
 * `(deadline - now) / 30 days`), matching lib/format.ts's getJalaaliMonthRange
 * pattern of doing date math through toJalaali rather than raw millisecond
 * arithmetic. Whole calendar months between the two dates' (year, month)
 * pairs, plus one more if `deadline`'s day-of-month falls later in its month
 * than `now`'s does in its own - i.e. a trailing partial month still counts
 * as a full month to save during. A `deadline` at or before `now` (already
 * passed, or today) still returns at least 1 rather than 0/negative -
 * something to save this month, not "nothing left to do".
 */
function monthsUntil(deadline: Date, now: Date): number {
  const nowJ = toJalaali(now);
  const deadlineJ = toJalaali(deadline);

  let months = (deadlineJ.jy - nowJ.jy) * 12 + (deadlineJ.jm - nowJ.jm);
  if (deadlineJ.jd > nowJ.jd) {
    months += 1;
  }

  return Math.max(1, months);
}

/**
 * Pure, deterministic feasibility calculation for one goal - no Prisma call,
 * no AI/LLM call, just arithmetic over already-fetched numbers (same
 * pure-function-over-already-fetched-data pattern as computeSavingsRate/
 * computeOverallChange in lib/analytics/spending-summary.ts), so it's
 * trivially unit testable with hand-built inputs. getActualMonthlyAverage
 * below is the one piece of this feature that actually queries the DB.
 */
export function computeGoalFeasibility(input: GoalFeasibilityInput): GoalFeasibility {
  const now = input.now ?? new Date();
  const monthsRemaining = monthsUntil(input.deadline, now);
  const actualMonthlyAverage = input.actualMonthlyAverage;

  const remainingAmount = input.targetAmount - input.initialAmount - input.alreadySaved;
  const isFullyFunded = remainingAmount <= 0;

  const requiredMonthlyAmount = isFullyFunded ? 0 : remainingAmount / monthsRemaining;

  // requiredMonthlyAmount is only ever 0 in the isFullyFunded branch above
  // (monthsRemaining is always >= 1, so remainingAmount > 0 implies a
  // strictly positive requiredMonthlyAmount) - so the only division-by-zero
  // risk here is the fully-funded case, handled by clamping the ratio to
  // exactly "on track" (1) rather than computing actual/0 (Infinity, or NaN
  // if actualMonthlyAverage is itself 0). Same "clamp rather than return
  // Infinity/NaN" convention computeSavingsRate/computeOverallChange follow.
  const feasibilityRatio = isFullyFunded ? 1 : Math.round((actualMonthlyAverage / requiredMonthlyAmount) * 100) / 100;

  // A fully-funded goal is "on_track" outright, regardless of current cash
  // flow - there's nothing left to save, so a non-positive
  // actualMonthlyAverage shouldn't retroactively call it unrealistic.
  let feasibilityStatus: FeasibilityStatus;
  if (isFullyFunded) {
    feasibilityStatus = "on_track";
  } else if (actualMonthlyAverage <= 0) {
    feasibilityStatus = "unrealistic";
  } else if (feasibilityRatio >= FEASIBILITY_ON_TRACK_RATIO) {
    feasibilityStatus = "on_track";
  } else if (feasibilityRatio >= FEASIBILITY_ADJUSTMENT_RATIO) {
    feasibilityStatus = "needs_adjustment";
  } else {
    feasibilityStatus = "unrealistic";
  }

  let projectedCompletionMonths: number | null;
  if (isFullyFunded) {
    projectedCompletionMonths = 0;
  } else if (actualMonthlyAverage <= 0) {
    projectedCompletionMonths = null;
  } else {
    projectedCompletionMonths = Math.ceil(remainingAmount / actualMonthlyAverage);
  }

  const gap = requiredMonthlyAmount - actualMonthlyAverage;

  return {
    requiredMonthlyAmount,
    actualMonthlyAverage,
    feasibilityRatio,
    feasibilityStatus,
    projectedCompletionMonths,
    gap,
    monthsRemaining,
  };
}

/**
 * Average net (income - expense) per Jalali month over the last
 * `lookbackMonths` *complete* months (not including the current,
 * still-in-progress month - see GOAL_LOOKBACK_MONTHS's own doc comment for
 * why). Reuses summarizeMonth (lib/analytics/spending-summary.ts) for the
 * actual aggregation so this stays in lockstep with that file's
 * isTransfer-exclusion and income/expense rules rather than a second,
 * possibly-drifting copy of them.
 */
export async function getActualMonthlyAverage(
  userId: number,
  lookbackMonths: number = GOAL_LOOKBACK_MONTHS,
  client: PrismaClient = prisma
): Promise<number> {
  const ranges: { start: Date; end: Date; label: string }[] = [];
  let cursor = getJalaaliMonthRange().start;
  for (let i = 0; i < lookbackMonths; i++) {
    const range = getJalaaliMonthRange(new Date(cursor.getTime() - 1));
    ranges.push(range);
    cursor = range.start;
  }

  const nets = await Promise.all(
    ranges.map(async (range) => {
      const transactions = await client.transaction.findMany({
        where: { userId, date: { gte: range.start, lt: range.end }, category: { isTransfer: false } },
        include: { category: true },
      });
      const summary = summarizeMonth(transactions, range.label);
      return summary.income - summary.expense;
    })
  );

  return nets.reduce((sum, n) => sum + n, 0) / nets.length;
}
