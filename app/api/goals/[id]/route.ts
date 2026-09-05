import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { updateGoal, deleteGoal, GoalNotFoundError, GOAL_STATUSES } from "@/lib/data/goals";
import { MAX_NAME_LENGTH, MAX_GOAL_TARGET_AMOUNT } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const goalId = Number(id);
  if (!Number.isInteger(goalId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  if (typeof body?.name === "string" && body.name.trim().length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "نام هدف بیش از حد طولانی است." }, { status: 400 });
  }
  if (body?.targetAmount !== undefined && body?.targetAmount !== null) {
    const targetAmount = Number(body.targetAmount);
    if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > MAX_GOAL_TARGET_AMOUNT) {
      return NextResponse.json({ error: "مبلغ هدف نامعتبر است." }, { status: 400 });
    }
  }
  if (body?.initialAmount !== undefined && body?.initialAmount !== null) {
    const initialAmount = Number(body.initialAmount);
    if (!Number.isFinite(initialAmount) || initialAmount < 0 || initialAmount > MAX_GOAL_TARGET_AMOUNT) {
      return NextResponse.json({ error: "مبلغ ذخیره‌شده فعلی نامعتبر است." }, { status: 400 });
    }
  }
  if (body?.deadline !== undefined && body?.deadline !== null) {
    const deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) {
      return NextResponse.json({ error: "مهلت هدف نامعتبر است." }, { status: 400 });
    }
  }
  if (body?.status !== undefined && !GOAL_STATUSES.some((s) => s === body.status)) {
    return NextResponse.json({ error: "وضعیت هدف نامعتبر است." }, { status: 400 });
  }

  const data: { name?: string; targetAmount?: number; deadline?: Date; status?: string; initialAmount?: number } = {};
  if (typeof body?.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (body?.targetAmount !== undefined && body?.targetAmount !== null) data.targetAmount = Math.round(Number(body.targetAmount));
  if (body?.initialAmount !== undefined && body?.initialAmount !== null) data.initialAmount = Math.round(Number(body.initialAmount));
  if (body?.deadline !== undefined && body?.deadline !== null) data.deadline = new Date(body.deadline);
  if (typeof body?.status === "string" && GOAL_STATUSES.some((s) => s === body.status)) data.status = body.status;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const goal = await updateGoal(session.userId, goalId, data);
    return NextResponse.json({ goal });
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - GoalNotFoundError above is an
    // already-handled, expected outcome and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "goals/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error updating goal",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "updateGoal", model: "Goal", code: error.code }
        : { operation: "updateGoal", model: "Goal" },
    });
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const goalId = Number(id);
  if (!Number.isInteger(goalId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteGoal(session.userId, goalId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GoalNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - GoalNotFoundError above is an
    // already-handled, expected outcome and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "goals/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting goal",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteGoal", model: "Goal", code: error.code }
        : { operation: "deleteGoal", model: "Goal" },
    });
    throw error;
  }
}
