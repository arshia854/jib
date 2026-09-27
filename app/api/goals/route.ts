import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listGoalsWithFeasibility, createGoal, GOAL_CATEGORIES } from "@/lib/data/goals";
import { AccountNotFoundError } from "@/lib/data/accounts";
import { MAX_NAME_LENGTH, MAX_GOAL_TARGET_AMOUNT } from "@/lib/limits";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const goals = await listGoalsWithFeasibility(session.userId);
  return NextResponse.json({ goals });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const category = typeof body?.category === "string" ? body.category : "";
  const targetAmount = Number(body?.targetAmount);
  const initialAmountInput = body?.initialAmount;
  const initialAmount = initialAmountInput === undefined || initialAmountInput === null ? 0 : Number(initialAmountInput);
  const deadline = typeof body?.deadline === "string" || body?.deadline instanceof Date ? new Date(body.deadline) : null;
  // Phase B1 (savings roadmap): optional link to one of the user's own
  // FinanceAccounts. Omitted/null both mean "no link" - ownership itself
  // (does this id exist and belong to this user) is createGoal's job, not
  // re-checked here, same split as every other DB-lookup-dependent rule in
  // this route.
  const savingsAccountIdInput = body?.savingsAccountId;
  const savingsAccountId =
    savingsAccountIdInput === undefined || savingsAccountIdInput === null ? null : Number(savingsAccountIdInput);
  if (savingsAccountId !== null && !Number.isInteger(savingsAccountId)) {
    return NextResponse.json({ error: "حساب پس‌انداز نامعتبر است." }, { status: 400 });
  }

  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "نام هدف الزامی و کوتاه‌تر از حد مجاز است." }, { status: 400 });
  }
  if (!GOAL_CATEGORIES.some((c) => c === category)) {
    return NextResponse.json({ error: "دسته هدف نامعتبر است." }, { status: 400 });
  }
  if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount > MAX_GOAL_TARGET_AMOUNT) {
    return NextResponse.json({ error: "مبلغ هدف نامعتبر است." }, { status: 400 });
  }
  if (!Number.isFinite(initialAmount) || initialAmount < 0 || initialAmount > MAX_GOAL_TARGET_AMOUNT) {
    return NextResponse.json({ error: "مبلغ ذخیره‌شده فعلی نامعتبر است." }, { status: 400 });
  }
  if (!deadline || Number.isNaN(deadline.getTime())) {
    return NextResponse.json({ error: "مهلت هدف نامعتبر است." }, { status: 400 });
  }
  // "Past/today" both rejected - a deadline must be at least tomorrow.
  // Compared at whole-day granularity (not a raw timestamp diff) so a
  // deadline of "today" at any time of day is rejected the same way a
  // deadline that already fully passed is, matching the task's own "past/
  // today" wording.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadlineDay = new Date(deadline);
  deadlineDay.setHours(0, 0, 0, 0);
  if (deadlineDay.getTime() <= today.getTime()) {
    return NextResponse.json({ error: "مهلت هدف باید در آینده باشد." }, { status: 400 });
  }

  try {
    const goal = await createGoal(session.userId, {
      name,
      category,
      targetAmount: Math.round(targetAmount),
      initialAmount: Math.round(initialAmount),
      deadline,
      savingsAccountId,
    });
    return NextResponse.json({ goal }, { status: 201 });
  } catch (error) {
    // Same status this class already maps to elsewhere (app/api/transfers/
    // route.ts, app/api/accounts/[id]/route.ts) - reused as-is, not
    // redefined.
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
