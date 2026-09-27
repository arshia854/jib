import "server-only";
import { toJalaali } from "jalaali-js";
import { prisma } from "@/lib/prisma";
import { getJalaaliMonthRange } from "@/lib/format";
import { summarizeMonth } from "@/lib/analytics/spending-summary";
import { getTotalBalance, getAccountBalance } from "@/lib/data/accounts";
import { getUserFacts } from "@/lib/facts/user-facts";

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
// These apply to a "regular" or unknown-regularity income - see the
// *_IRREGULAR_INCOME pair below for freelance/variable income.
export const FEASIBILITY_ON_TRACK_RATIO = 1.0;
export const FEASIBILITY_ADJUSTMENT_RATIO = 0.7;

// Same two ratios, but applied when the user's income_regularity UserFact
// (lib/facts/known-facts.ts) is "irregular" (freelance/project-based/
// commission/seasonal work). A trailing GOAL_LOOKBACK_MONTHS average is a
// much less reliable predictor for this group than for a fixed salary - one
// large invoice or one dry spell swings actualMonthlyAverage far more than
// it would for someone paid the same amount every month - so both
// boundaries move outward, widening the uncertain "needs_adjustment" middle
// band rather than confidently calling something "on_track" or
// "unrealistic" off a number that could look very different next month:
// - ON_TRACK needs a real cushion (1.25x, vs. 1.0x) above the bare-minimum
//   required rate before volatile income is treated as safely sufficient.
// - ADJUSTMENT only writes a goal off as flatly "unrealistic" below a much
//   lower bar (0.5x, vs. 0.7x), since irregular earners routinely have
//   individual months well under their own real average without that
//   meaning the goal itself is impossible.
// Same rule-of-thumb caveat as the pair above - nothing here is calibrated
// against this app's own data (none exists yet for this feature).
export const FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME = 1.25;
export const FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME = 0.5;

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

// Defense-in-depth safety net for computeGoalFeasibility below - NOT a fix
// for any specific root cause, just a bound on how far a bad upstream
// number can distort this function's output. availableBalance ultimately
// comes from getTotalBalance (lib/data/accounts.ts) via
// getGoalFeasibilityContext, which sums every transaction's amount signed
// by its `type` column - if that column is ever wrong on a large enough
// transaction (e.g. a quick-submit transaction whose background AI
// enrichment permanently failed and left it mistyped - see
// markEnrichmentFailed's own comment in lib/data/transactions.ts),
// availableBalance can come in deeply, spuriously negative, which would
// otherwise inflate remainingAmount/requiredMonthlyAmount without limit.
// Floored at -1x targetAmount rather than clamped to 0 - a real negative
// balance should still make a goal look harder, just not unboundedly so;
// past "the entire goal amount's worth of debt," requiredMonthlyAmount is
// already deep in "unrealistic" territory regardless of exactly how much
// further negative the real number goes, so there's nothing meaningful
// left to gain by letting it distort the figure further.
export const AVAILABLE_BALANCE_FLOOR_RATIO = -1;

export type FeasibilityStatus = "on_track" | "needs_adjustment" | "unrealistic";
export type IncomeRegularity = "regular" | "irregular";

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
  // The user's current total balance across every FinanceAccount (see
  // lib/data/accounts.ts's getTotalBalance) attributable to *this* goal -
  // money already sitting in an account counts toward a goal exactly like
  // initialAmount/alreadySaved, it just hasn't been manually earmarked for
  // this one goal by the user the way those two fields are. A user can have
  // several concurrent active goals drawing on the same pool of money, and
  // this phase has no portfolio/allocation feature to split it "correctly"
  // between them - so this pure function does not guess at cross-goal
  // allocation itself; the caller is responsible for apportioning
  // getTotalBalance's raw number across the user's active goals before
  // passing a per-goal share in here (see getGoalFeasibilityContext below
  // and its callers). Pass 0 for a goal with no meaningful share to
  // attribute (e.g. an already-abandoned/achieved goal).
  availableBalance: number;
  deadline: Date;
  // Average net (income - expense) per month over the lookback window - see
  // getActualMonthlyAverage below for how a real caller computes this.
  // `null` means "not enough transaction history exists yet to compute a
  // real average" (e.g. a brand-new user/account, or one who only recently
  // started logging transactions) - a genuine unknown, which
  // computeGoalFeasibility must NOT treat the same as a confirmed, observed
  // zero/negative cash flow (see its own handling of hasIncomeSignal below).
  actualMonthlyAverage: number | null;
  // The user's income_regularity UserFact (lib/facts/known-facts.ts):
  // "regular" | "irregular" | not-yet-recorded. Absent/null is treated the
  // same as "regular" (the original, less conservative thresholds) - since
  // assuming volatility without evidence would itself misjudge every goal
  // for a user this phase simply has no signal on yet.
  incomeRegularity?: IncomeRegularity | null;
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
 * trivially unit testable with hand-built inputs. getActualMonthlyAverage/
 * getGoalFeasibilityContext below are the pieces of this feature that
 * actually query the DB.
 */
export function computeGoalFeasibility(input: GoalFeasibilityInput): GoalFeasibility {
  const now = input.now ?? new Date();
  const monthsRemaining = monthsUntil(input.deadline, now);

  // `null` (no usable transaction history yet) is a genuine unknown, not a
  // confirmed zero - tracked separately via hasIncomeSignal rather than
  // silently coercing to 0, which would make "no data" and "confirmed zero
  // cash flow" indistinguishable in every branch below (see this input's
  // own doc comment on actualMonthlyAverage).
  const hasIncomeSignal = input.actualMonthlyAverage !== null;
  const actualMonthlyAverage = input.actualMonthlyAverage ?? 0;

  // See AVAILABLE_BALANCE_FLOOR_RATIO's own comment above - this is a safety
  // net against a corrupted upstream balance, not normal behavior for a
  // genuine (small) negative account balance, which passes through
  // unchanged.
  const availableBalance = Math.max(input.availableBalance, input.targetAmount * AVAILABLE_BALANCE_FLOOR_RATIO);

  const remainingAmount = input.targetAmount - input.initialAmount - input.alreadySaved - availableBalance;
  const isFullyFunded = remainingAmount <= 0;

  const requiredMonthlyAmount = isFullyFunded ? 0 : remainingAmount / monthsRemaining;

  // requiredMonthlyAmount is only ever 0 in the isFullyFunded branch above
  // (monthsRemaining is always >= 1, so remainingAmount > 0 implies a
  // strictly positive requiredMonthlyAmount) - so the only division-by-zero
  // risk here is the fully-funded case, handled by clamping the ratio to
  // exactly "on track" (1) rather than computing actual/0 (Infinity, or NaN
  // if actualMonthlyAverage is itself 0). Same "clamp rather than return
  // Infinity/NaN" convention computeSavingsRate/computeOverallChange follow.
  let feasibilityRatio: number;
  if (isFullyFunded) {
    feasibilityRatio = 1;
  } else if (!hasIncomeSignal) {
    // No ratio is meaningful without a real average to compare against -
    // clamped to 0 rather than NaN. Not surfaced to the user on its own
    // (only feasibilityStatus/gap/projectedCompletionMonths are rendered -
    // see components/goals/goals-manager.tsx), so this only affects other
    // internal math, never a displayed percentage.
    feasibilityRatio = 0;
  } else {
    feasibilityRatio = Math.round((actualMonthlyAverage / requiredMonthlyAmount) * 100) / 100;
  }

  const isIrregularIncome = input.incomeRegularity === "irregular";
  const onTrackRatio = isIrregularIncome ? FEASIBILITY_ON_TRACK_RATIO_IRREGULAR_INCOME : FEASIBILITY_ON_TRACK_RATIO;
  const adjustmentRatio = isIrregularIncome
    ? FEASIBILITY_ADJUSTMENT_RATIO_IRREGULAR_INCOME
    : FEASIBILITY_ADJUSTMENT_RATIO;

  // A fully-funded goal is "on_track" outright, regardless of current cash
  // flow - there's nothing left to save, so a non-positive
  // actualMonthlyAverage shouldn't retroactively call it unrealistic.
  let feasibilityStatus: FeasibilityStatus;
  if (isFullyFunded) {
    feasibilityStatus = "on_track";
  } else if (!hasIncomeSignal) {
    // Not enough transaction history to know real cash flow yet - an
    // unknown is not evidence of infeasibility. This was the single biggest
    // cause of the "almost every goal is flagged unrealistic" bug: any user
    // newer than GOAL_LOOKBACK_MONTHS (or with a quiet lookback window)
    // previously had every empty month counted as a real net of 0, which
    // both deflated the average and tripped the actualMonthlyAverage <= 0
    // branch below unconditionally. Judged a genuine middle ground instead.
    feasibilityStatus = "needs_adjustment";
  } else if (actualMonthlyAverage <= 0) {
    feasibilityStatus = "unrealistic";
  } else if (feasibilityRatio >= onTrackRatio) {
    feasibilityStatus = "on_track";
  } else if (feasibilityRatio >= adjustmentRatio) {
    feasibilityStatus = "needs_adjustment";
  } else {
    feasibilityStatus = "unrealistic";
  }

  let projectedCompletionMonths: number | null;
  if (isFullyFunded) {
    projectedCompletionMonths = 0;
  } else if (!hasIncomeSignal || actualMonthlyAverage <= 0) {
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
 * why), counted only over months that actually have at least one logged
 * transaction. A month with zero transactions is not the same thing as a
 * real net of zero - it usually just means the user hadn't started using
 * Jib yet (or logging that far back), not that they earned and spent
 * nothing - so it is excluded from the average entirely rather than pulled
 * in as a 0 that drags a real recent month's average down (previously this
 * was the single biggest cause of the "every goal is unrealistic" bug: a
 * user newer than `lookbackMonths` has, by definition, mostly or entirely
 * empty months in this window). Returns `null` - not 0 - when *none* of the
 * lookback months have any data at all, so callers (computeGoalFeasibility)
 * can tell "confirmed no/negative cash flow" apart from "no history to
 * judge from yet". Reuses summarizeMonth (lib/analytics/spending-summary.ts)
 * for the actual aggregation so this stays in lockstep with that file's
 * isTransfer-exclusion and income/expense rules rather than a second,
 * possibly-drifting copy of them.
 */
export async function getActualMonthlyAverage(
  userId: number,
  lookbackMonths: number = GOAL_LOOKBACK_MONTHS,
  client: PrismaClient = prisma
): Promise<number | null> {
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
      // No logged activity at all this month - exclude it rather than
      // counting it as a real net of 0 (see this function's own doc
      // comment above).
      if (transactions.length === 0) return null;
      const summary = summarizeMonth(transactions, range.label);
      return summary.income - summary.expense;
    })
  );

  const monthsWithData = nets.filter((n): n is number => n !== null);
  if (monthsWithData.length === 0) return null;

  return monthsWithData.reduce((sum, n) => sum + n, 0) / monthsWithData.length;
}

export interface GoalFeasibilityContext {
  actualMonthlyAverage: number | null;
  // The user's raw, unscoped getTotalBalance() - NOT reduced for
  // savingsAccountId earmarking (see availableBalancePerActiveGoal below for
  // the number that *is* reduced). Kept as the plain total since nothing
  // reads this field for apportionment purposes on its own.
  totalBalance: number;
  incomeRegularity: IncomeRegularity | null;
  // Count of the user's currently `status: "active"` goals that have NO
  // savingsAccountId - the divisor behind availableBalancePerActiveGoal
  // below. Phase B1 (savings roadmap): a goal with its own dedicated
  // savingsAccountId no longer competes for the shared pool at all (see
  // that field's own doc comment), so it's excluded from this count the
  // same way an achieved/abandoned goal already was.
  activeGoalCount: number;
  // (totalBalance minus every FinanceAccount balance already earmarked to
  // an active, linked goal) split evenly across activeGoalCount - the one
  // apportionment calculation every caller of this function needs (see
  // GoalFeasibilityInput's own doc comment on availableBalance for why a
  // per-goal share, not the raw total, is what computeGoalFeasibility
  // wants). 0 when the user has no unlinked active goals. Computed once,
  // here, so every caller (listGoalsWithFeasibility, the single-goal
  // strategy route) uses the exact same number for a given active,
  // *unlinked* goal rather than each re-deriving its own - pass 0 instead
  // of this field for a goal that is itself not active (achieved/
  // abandoned) or that has its own savingsAccountId (see
  // getGoalBalanceInputs below, which makes that call for every goal
  // shape). Still a deliberately simple stand-in (no real
  // portfolio-allocation feature beyond per-goal account linking), not a
  // claim that the user's remaining unearmarked money is actually
  // allocated this way.
  //
  // Phase B1 (savings roadmap): the pool this splits is no longer the raw
  // totalBalance. Once a goal is linked to a dedicated savingsAccountId,
  // that account's money is earmarked for that goal (see
  // getGoalBalanceInputs) and must stop being offered to every *other*
  // active goal too - otherwise linking a goal to an account would just
  // move the double-counting bug instead of fixing it (the same money
  // would count once via that goal's own alreadySaved AND again via every
  // other active goal's availableBalancePerActiveGoal share). So this pool
  // is totalBalance minus the balance of every FinanceAccount linked
  // (savingsAccountId) to at least one *active* goal, counted once per
  // distinct account regardless of how many active goals point at it (two
  // goals can legitimately share one savings account - each of them still
  // individually reports that account's real balance as its own
  // alreadySaved; only this shared-pool subtraction must not double-count
  // the account itself).
  availableBalancePerActiveGoal: number;
}

/**
 * Bundles every per-user (not per-goal) input computeGoalFeasibility needs -
 * actual cash flow, current total account balance, declared income
 * regularity, and the user's active-goal count/balance-per-goal share -
 * behind one call, so a caller iterating over several goals for the same
 * user (listGoalsWithFeasibility) fetches each exactly once rather than
 * re-querying per goal, and so every caller (including the single-goal
 * strategy route, which has no sibling-goal list of its own to derive
 * activeGoalCount from) apportions totalBalance identically instead of each
 * computing its own version of the same split. Reuses getTotalBalance
 * (lib/data/accounts.ts) and getUserFacts (lib/facts/user-facts.ts) as-is
 * rather than re-deriving either.
 *
 * Phase B1 (savings roadmap) note: this context alone is enough for an
 * *unlinked* goal, but a goal with its own savingsAccountId also needs
 * getGoalBalanceInputs (below) applied per-goal on top of this context -
 * see that function's own doc comment. listGoalsWithFeasibility
 * (lib/data/goals.ts) does this; app/api/goals/[id]/strategy/route.ts does
 * NOT yet (out of scope for this phase - flagged, not fixed, since it would
 * also mean deciding how lib/goals/strategy.ts's own GoalStrategyGoalInput
 * should represent alreadySaved), so a goal linked to a savingsAccountId
 * will still get an incorrect (stale, pool-based) availableBalance from
 * that one route until it's updated the same way.
 */
export async function getGoalFeasibilityContext(
  userId: number,
  client: PrismaClient = prisma
): Promise<GoalFeasibilityContext> {
  const [actualMonthlyAverage, totalBalance, facts, activeGoalCount, activeLinkedGoals] = await Promise.all([
    getActualMonthlyAverage(userId, undefined, client),
    getTotalBalance(userId, client),
    getUserFacts(userId),
    // Phase B1: only active goals with NO savingsAccountId compete for the
    // shared pool - see activeGoalCount's own doc comment above.
    client.goal.count({ where: { userId, status: "active", savingsAccountId: null } }),
    // Every active goal that IS linked, so the accounts they earmark can be
    // subtracted from the shared pool below - fetched as goal rows (not a
    // distinct account-id query) since a plain findMany is simplest here;
    // de-duplication of the account ids themselves happens right below.
    client.goal.findMany({
      where: { userId, status: "active", savingsAccountId: { not: null } },
      select: { savingsAccountId: true },
    }),
  ]);

  const regularityValue = facts.find((f) => f.key === "income_regularity")?.value;
  const incomeRegularity: IncomeRegularity | null =
    regularityValue === "regular" || regularityValue === "irregular" ? regularityValue : null;

  // Distinct linked account ids only - two active goals sharing one account
  // must not subtract that account's balance from the pool twice (see
  // availableBalancePerActiveGoal's own doc comment above). One
  // getAccountBalance call per distinct account, not per goal.
  const distinctLinkedAccountIds = [...new Set(activeLinkedGoals.map((g) => g.savingsAccountId!))];
  const linkedAccountBalances = await Promise.all(
    distinctLinkedAccountIds.map((accountId) => getAccountBalance(userId, accountId, client))
  );
  const earmarkedBalance = linkedAccountBalances.reduce((sum, balance) => sum + balance, 0);

  const sharedPool = totalBalance - earmarkedBalance;
  const availableBalancePerActiveGoal = activeGoalCount > 0 ? sharedPool / activeGoalCount : 0;

  return { actualMonthlyAverage, totalBalance, incomeRegularity, activeGoalCount, availableBalancePerActiveGoal };
}

/**
 * Per-goal alreadySaved/availableBalance split (Phase B1, savings roadmap) -
 * the one piece of GoalFeasibilityInput apportionment that depends on a
 * single goal's own fields (savingsAccountId, status), not just the shared
 * per-user GoalFeasibilityContext above. A goal linked to its own
 * savingsAccountId draws on that account's real balance directly
 * (alreadySaved) and gets no share of the shared pool (availableBalance: 0
 * - see availableBalancePerActiveGoal's own doc comment on why); an unlinked
 * goal is unchanged from before this phase. Pulled out as its own function
 * (rather than inlined in listGoalsWithFeasibility) so every caller that
 * computes one goal's feasibility from a shared GoalFeasibilityContext
 * applies the exact same rule.
 */
export async function getGoalBalanceInputs(
  userId: number,
  goal: { status: string; savingsAccountId: number | null },
  context: GoalFeasibilityContext,
  client: PrismaClient = prisma
): Promise<{ alreadySaved: number; availableBalance: number }> {
  if (goal.savingsAccountId != null) {
    const alreadySaved = await getAccountBalance(userId, goal.savingsAccountId, client);
    return { alreadySaved, availableBalance: 0 };
  }
  return { alreadySaved: 0, availableBalance: goal.status === "active" ? context.availableBalancePerActiveGoal : 0 };
}
