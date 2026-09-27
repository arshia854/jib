import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  updateSavingsStrategy,
  deleteSavingsStrategy,
  SavingsStrategyNotFoundError,
  DuplicateActiveStrategyError,
  SAVINGS_STRATEGY_FORMULA_TYPES,
  SAVINGS_STRATEGY_STATUSES,
} from "@/lib/data/savings-strategies";
import { MAX_SAVINGS_STRATEGY_TARGET_AMOUNT } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

const DUPLICATE_ACTIVE_STRATEGY_MESSAGE = "شما همین حالا یک استراتژی «فعال» از این نوع دارید. اول اون رو متوقف یا حذف کن.";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const strategyId = Number(id);
  if (!Number.isInteger(strategyId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  if (body?.formulaType !== undefined && !SAVINGS_STRATEGY_FORMULA_TYPES.some((t) => t === body.formulaType)) {
    return NextResponse.json({ error: "نوع فرمول نامعتبر است." }, { status: 400 });
  }
  if (body?.status !== undefined && !SAVINGS_STRATEGY_STATUSES.some((s) => s === body.status)) {
    return NextResponse.json({ error: "وضعیت استراتژی نامعتبر است." }, { status: 400 });
  }

  const data: {
    formulaType?: string;
    targetPercent?: number | null;
    targetAmount?: number | null;
    status?: string;
  } = {};
  if (typeof body?.formulaType === "string" && SAVINGS_STRATEGY_FORMULA_TYPES.some((t) => t === body.formulaType)) {
    data.formulaType = body.formulaType;
  }
  if (typeof body?.status === "string" && SAVINGS_STRATEGY_STATUSES.some((s) => s === body.status)) {
    data.status = body.status;
  }

  // Only enforce the exactly-one-of rule when the caller is actually
  // touching one of these two fields in this call - a caller who only
  // updates status/formulaType shouldn't be forced to resend a valid
  // targetPercent/targetAmount. Touching just one of the two switches the
  // strategy to that representation and implicitly clears the other, to
  // keep the "exactly one is set" invariant true after the update.
  if (body?.targetPercent !== undefined || body?.targetAmount !== undefined) {
    const hasTargetPercent = body?.targetPercent !== undefined && body?.targetPercent !== null;
    const hasTargetAmount = body?.targetAmount !== undefined && body?.targetAmount !== null;
    if (hasTargetPercent === hasTargetAmount) {
      return NextResponse.json(
        { error: "دقیقاً یکی از درصد هدف یا مبلغ هدف باید مشخص شود." },
        { status: 400 }
      );
    }
    if (hasTargetPercent) {
      const targetPercent = Number(body.targetPercent);
      if (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > 100) {
        return NextResponse.json({ error: "درصد هدف نامعتبر است." }, { status: 400 });
      }
      data.targetPercent = targetPercent;
      data.targetAmount = null;
    } else {
      const targetAmount = Number(body.targetAmount);
      if (
        !Number.isFinite(targetAmount) ||
        !Number.isInteger(targetAmount) ||
        targetAmount <= 0 ||
        targetAmount > MAX_SAVINGS_STRATEGY_TARGET_AMOUNT
      ) {
        return NextResponse.json({ error: "مبلغ هدف نامعتبر است." }, { status: 400 });
      }
      data.targetAmount = targetAmount;
      data.targetPercent = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const strategy = await updateSavingsStrategy(session.userId, strategyId, data);
    return NextResponse.json({ strategy });
  } catch (error) {
    if (error instanceof SavingsStrategyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof DuplicateActiveStrategyError) {
      return NextResponse.json({ error: DUPLICATE_ACTIVE_STRATEGY_MESSAGE }, { status: 409 });
    }
    // Unhandled/unexpected only - SavingsStrategyNotFoundError and
    // DuplicateActiveStrategyError above are already-handled, expected
    // outcomes and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "savings-strategies/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error updating savings strategy",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "updateSavingsStrategy", model: "SavingsStrategy", code: error.code }
        : { operation: "updateSavingsStrategy", model: "SavingsStrategy" },
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
  const strategyId = Number(id);
  if (!Number.isInteger(strategyId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteSavingsStrategy(session.userId, strategyId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SavingsStrategyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - SavingsStrategyNotFoundError above is an
    // already-handled, expected outcome and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "savings-strategies/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting savings strategy",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteSavingsStrategy", model: "SavingsStrategy", code: error.code }
        : { operation: "deleteSavingsStrategy", model: "SavingsStrategy" },
    });
    throw error;
  }
}
