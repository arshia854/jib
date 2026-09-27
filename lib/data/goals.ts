import "server-only";
import { prisma } from "@/lib/prisma";
import {
  getGoalFeasibilityContext,
  getGoalBalanceInputs,
  computeGoalFeasibility,
  type GoalFeasibility,
} from "@/lib/goals/feasibility";
import { assertAccountOwnership } from "@/lib/data/accounts";

type PrismaClient = typeof prisma;

// Fixed vocabulary for Goal.category (prisma/schema.prisma) - enforced here
// at the application level only (see that model's own doc comment for why
// no DB-level constraint exists). No free text: app/api/goals/route.ts's
// POST and app/api/goals/[id]/route.ts's PATCH both reject anything outside
// this list.
export const GOAL_CATEGORIES = ["device", "travel", "car", "emergency_fund", "home_down_payment", "other"] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

export const GOAL_STATUSES = ["active", "achieved", "abandoned"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export class GoalNotFoundError extends Error {}

export interface GoalWithFeasibility {
  id: number;
  name: string;
  category: string;
  targetAmount: number;
  initialAmount: number;
  deadline: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  savingsAccountId: number | null;
  feasibility: GoalFeasibility;
  // getGoalBalanceInputs' (lib/goals/feasibility.ts) own two return values -
  // already computed per goal below to build `feasibility`, surfaced here as
  // siblings (not nested inside feasibility) so a caller (the savings page's
  // read-only goal-allocation view) can show "how much of this goal is
  // already covered" without recomputing this goal's own alreadySaved/
  // availableBalance split itself.
  alreadySaved: number;
  availableBalance: number;
}

/**
 * The user's own goals - active first, then by deadline ascending - each
 * with its computed GoalFeasibility attached.
 *
 * actualMonthlyAverage (lib/goals/feasibility.ts) only depends on userId and
 * the shared lookback window, never on any one goal's own fields, so it's
 * computed exactly once here and reused for every goal below rather than
 * re-running an identical query once per row - not the kind of batching the
 * task's own "N+1 is acceptable, don't over-engineer a batch query" note
 * warns against skipping (that note is about computeGoalFeasibility itself,
 * which genuinely does need to run once per goal and does, below - and,
 * since Phase B1, so does getGoalBalanceInputs for a goal with its own
 * savingsAccountId).
 *
 * `status` has no natural DB sort order ("abandoned" < "achieved" <
 * "active" alphabetically, the opposite of "active first"), so the active/
 * inactive split is done in JS after an `orderBy: { deadline: "asc" }`
 * fetch - Array.prototype.sort is a stable sort, so goals within each group
 * keep the deadline-ascending order the query already gave them.
 */
export async function listGoalsWithFeasibility(
  userId: number,
  client: PrismaClient = prisma
): Promise<GoalWithFeasibility[]> {
  const [goals, context] = await Promise.all([
    client.goal.findMany({ where: { userId }, orderBy: { deadline: "asc" } }),
    getGoalFeasibilityContext(userId, client),
  ]);

  const sorted = [...goals].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));

  // getGoalBalanceInputs (lib/goals/feasibility.ts) resolves each goal's own
  // alreadySaved/availableBalance split - its own dedicated account balance
  // for a goal with a savingsAccountId, or its share of
  // context.availableBalancePerActiveGoal (0 for an achieved/abandoned
  // goal) otherwise. Awaited per goal (one extra query per *linked* goal
  // only) rather than batched - same acceptable N+1 as computeGoalFeasibility
  // itself, per this function's own doc comment above.
  return Promise.all(
    sorted.map(async (goal) => {
      const { alreadySaved, availableBalance } = await getGoalBalanceInputs(userId, goal, context, client);
      return {
        ...goal,
        feasibility: computeGoalFeasibility({
          targetAmount: goal.targetAmount,
          initialAmount: goal.initialAmount,
          alreadySaved,
          availableBalance,
          deadline: goal.deadline,
          actualMonthlyAverage: context.actualMonthlyAverage,
          incomeRegularity: context.incomeRegularity,
        }),
        alreadySaved,
        availableBalance,
      };
    })
  );
}

export async function createGoal(
  userId: number,
  data: {
    name: string;
    category: string;
    targetAmount: number;
    initialAmount?: number;
    deadline: Date;
    // Phase B1 (savings roadmap): optional link to one of the user's own
    // FinanceAccounts (prisma/schema.prisma's Goal.savingsAccountId).
    // Validated below via assertAccountOwnership before it's ever written -
    // same ownership check lib/data/accounts.ts's own updateAccount/
    // deleteAccount already apply to a FinanceAccount id, reused here rather
    // than re-implemented.
    savingsAccountId?: number | null;
  }
) {
  if (data.savingsAccountId != null) {
    await assertAccountOwnership(userId, data.savingsAccountId);
  }

  return prisma.goal.create({
    data: {
      name: data.name,
      category: data.category,
      targetAmount: data.targetAmount,
      initialAmount: data.initialAmount ?? 0,
      deadline: data.deadline,
      savingsAccountId: data.savingsAccountId ?? null,
      userId,
    },
  });
}

/**
 * Single goal lookup, scoped to its owner - same `{ id, userId }` ownership
 * check and GoalNotFoundError-on-miss contract as updateGoal/deleteGoal
 * below. Added for app/api/goals/[id]/strategy/route.ts (Phase 2 AI
 * strategy), which needs the raw Goal row on its own (not
 * listGoalsWithFeasibility()'s whole-list-plus-feasibility shape) - it
 * computes its own GoalFeasibility from this row's fields via
 * lib/goals/feasibility.ts.
 */
export async function getGoal(userId: number, id: number) {
  const goal = await prisma.goal.findFirst({ where: { id, userId } });
  if (!goal) {
    throw new GoalNotFoundError("هدف یافت نشد.");
  }
  return goal;
}

export async function updateGoal(
  userId: number,
  id: number,
  data: {
    name?: string;
    targetAmount?: number;
    deadline?: Date;
    status?: string;
    initialAmount?: number;
    // `undefined` (key omitted) means "leave the link as-is"; `null` means
    // "explicitly clear it, revert this goal to shared-pool apportionment" -
    // same optional-vs-null-vs-omitted distinction the API route already
    // has to preserve through JSON, and the same reason createGoal's own
    // savingsAccountId is `number | null | undefined` rather than just
    // `number | undefined`.
    savingsAccountId?: number | null;
  }
) {
  const existing = await prisma.goal.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new GoalNotFoundError("هدف یافت نشد.");
  }
  if (data.savingsAccountId !== undefined && data.savingsAccountId !== null) {
    await assertAccountOwnership(userId, data.savingsAccountId);
  }
  return prisma.goal.update({ where: { id }, data });
}

export async function deleteGoal(userId: number, id: number) {
  const existing = await prisma.goal.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new GoalNotFoundError("هدف یافت نشد.");
  }
  return prisma.goal.delete({ where: { id } });
}
