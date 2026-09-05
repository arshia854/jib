import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getGoal, GoalNotFoundError } from "@/lib/data/goals";
import { getGoalFeasibilityContext, computeGoalFeasibility } from "@/lib/goals/feasibility";
import { generateGoalStrategy } from "@/lib/goals/strategy";
import { checkRateLimit, rateLimitResponse, GOAL_STRATEGY_USER_RULE } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const goalId = Number(id);
  if (!Number.isInteger(goalId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  // Rate-limited before the (cheap) ownership lookup below - same ordering
  // as transactions/parse's own POST, so a rate-limited client is turned
  // away without spending a DB round-trip on it either.
  const limit = checkRateLimit(`goal-strategy:user:${session.userId}`, GOAL_STRATEGY_USER_RULE);
  if (!limit.allowed) {
    return rateLimitResponse(limit);
  }

  let goal;
  try {
    goal = await getGoal(session.userId, goalId);
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - GoalNotFoundError above is an
    // already-handled, expected outcome and isn't reported here. Same
    // pattern as app/api/goals/[id]/route.ts's PATCH/DELETE.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "goals/[id]/strategy",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error fetching goal",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "getGoal", model: "Goal", code: error.code }
        : { operation: "getGoal", model: "Goal" },
    });
    throw error;
  }

  // Same feasibility computation listGoalsWithFeasibility (lib/data/goals.ts)
  // runs per goal - reused here rather than re-deriving a second, possibly
  // drifting version of it, just scoped to this one goal instead of the
  // user's whole list. getGoalFeasibilityContext's own
  // availableBalancePerActiveGoal already apportions the user's whole
  // balance across their active goals identically to what
  // listGoalsWithFeasibility shows for this same goal - this route has no
  // sibling-goal list of its own, but doesn't need one, since
  // activeGoalCount/the resulting per-goal share are computed inside
  // getGoalFeasibilityContext, not derived from a list the caller fetched.
  const context = await getGoalFeasibilityContext(session.userId);
  const feasibility = computeGoalFeasibility({
    targetAmount: goal.targetAmount,
    initialAmount: goal.initialAmount,
    alreadySaved: 0,
    availableBalance: goal.status === "active" ? context.availableBalancePerActiveGoal : 0,
    deadline: goal.deadline,
    actualMonthlyAverage: context.actualMonthlyAverage,
    incomeRegularity: context.incomeRegularity,
  });

  try {
    const strategy = await generateGoalStrategy(
      { name: goal.name, targetAmount: goal.targetAmount, initialAmount: goal.initialAmount, deadline: goal.deadline },
      feasibility,
      session.userId
    );
    return NextResponse.json({ strategy });
  } catch (error) {
    // generateGoalStrategy already reports its own AI_ERROR/PARSER_ERROR
    // failures internally (lib/goals/strategy.ts) and only ever throws its
    // one user-facing Persian message - re-reporting here would just
    // duplicate that same event under a third errorType for no benefit.
    const message = error instanceof Error ? error.message : "در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
