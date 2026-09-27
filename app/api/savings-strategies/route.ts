import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  listSavingsStrategies,
  createSavingsStrategy,
  DuplicateActiveStrategyError,
  SAVINGS_STRATEGY_FORMULA_TYPES,
  SAVINGS_STRATEGY_STATUSES,
} from "@/lib/data/savings-strategies";
import { MAX_SAVINGS_STRATEGY_TARGET_AMOUNT } from "@/lib/limits";

const DUPLICATE_ACTIVE_STRATEGY_MESSAGE = "شما همین حالا یک استراتژی «فعال» از این نوع دارید. اول اون رو متوقف یا حذف کن.";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const strategies = await listSavingsStrategies(session.userId);
  return NextResponse.json({ strategies });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const formulaType = typeof body?.formulaType === "string" ? body.formulaType : "";
  const targetPercentInput = body?.targetPercent;
  const targetAmountInput = body?.targetAmount;
  const hasTargetPercent = targetPercentInput !== undefined && targetPercentInput !== null;
  const hasTargetAmount = targetAmountInput !== undefined && targetAmountInput !== null;
  const status = typeof body?.status === "string" ? body.status : "active";

  if (!SAVINGS_STRATEGY_FORMULA_TYPES.some((t) => t === formulaType)) {
    return NextResponse.json({ error: "نوع فرمول نامعتبر است." }, { status: 400 });
  }
  if (hasTargetPercent === hasTargetAmount) {
    return NextResponse.json(
      { error: "دقیقاً یکی از درصد هدف یا مبلغ هدف باید مشخص شود." },
      { status: 400 }
    );
  }
  if (hasTargetPercent) {
    const targetPercent = Number(targetPercentInput);
    if (!Number.isFinite(targetPercent) || targetPercent <= 0 || targetPercent > 100) {
      return NextResponse.json({ error: "درصد هدف نامعتبر است." }, { status: 400 });
    }
  }
  if (hasTargetAmount) {
    const targetAmount = Number(targetAmountInput);
    if (
      !Number.isFinite(targetAmount) ||
      !Number.isInteger(targetAmount) ||
      targetAmount <= 0 ||
      targetAmount > MAX_SAVINGS_STRATEGY_TARGET_AMOUNT
    ) {
      return NextResponse.json({ error: "مبلغ هدف نامعتبر است." }, { status: 400 });
    }
  }
  if (!SAVINGS_STRATEGY_STATUSES.some((s) => s === status)) {
    return NextResponse.json({ error: "وضعیت استراتژی نامعتبر است." }, { status: 400 });
  }

  try {
    const strategy = await createSavingsStrategy(session.userId, {
      formulaType,
      targetPercent: hasTargetPercent ? Number(targetPercentInput) : null,
      targetAmount: hasTargetAmount ? Number(targetAmountInput) : null,
      status,
    });
    return NextResponse.json({ strategy }, { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateActiveStrategyError) {
      return NextResponse.json({ error: DUPLICATE_ACTIVE_STRATEGY_MESSAGE }, { status: 409 });
    }
    throw error;
  }
}
