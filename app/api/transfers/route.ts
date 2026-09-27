import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  createTransfer,
  SameAccountTransferError,
  InvalidTransferAmountError,
  TransferCategoryMissingError,
} from "@/lib/data/transfers";
// Reused as-is, not redefined (per this phase's own instructions) - the
// same class app/api/accounts/[id]/route.ts's PATCH/DELETE already map to
// 404.
import { AccountNotFoundError } from "@/lib/data/accounts";
import { MAX_DESCRIPTION_LENGTH, MAX_TRANSACTION_AMOUNT } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const fromAccountId = Number(body?.fromAccountId);
  const toAccountId = Number(body?.toAccountId);
  const amount = Number(body?.amount);
  const note = typeof body?.note === "string" ? body.note : undefined;
  const dateInput = typeof body?.date === "string" ? body.date : undefined;

  // Type/range shape only, same split as app/api/transactions/route.ts's
  // own POST - business rules that need a DB lookup or cross-field logic
  // (same account, account ownership, the transfer category pair existing
  // for this user) are createTransfer()'s job, not re-checked here.
  if (
    !Number.isInteger(fromAccountId) ||
    !Number.isInteger(toAccountId) ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_TRANSACTION_AMOUNT ||
    (note !== undefined && note.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return NextResponse.json({ error: "اطلاعات انتقال ناقص یا نامعتبر است." }, { status: 400 });
  }

  const date = dateInput && !Number.isNaN(Date.parse(dateInput)) ? new Date(dateInput) : new Date();

  try {
    const transfer = await createTransfer(session.userId, {
      fromAccountId,
      toAccountId,
      amount: Math.round(amount),
      date,
      note,
    });
    return NextResponse.json(transfer, { status: 201 });
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof SameAccountTransferError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidTransferAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Same "expected, named condition blocking the operation, not the
    // client's fault, not an unknown crash" status as AccountInUseError
    // (app/api/accounts/[id]/route.ts's DELETE) - the transfer categories
    // genuinely not existing yet for this user is a real, anticipated state
    // (see TransferCategoryMissingError's own comment), not a validation
    // error on the request body.
    if (error instanceof TransferCategoryMissingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Unhandled/unexpected only - the known outcomes above are already
    // handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "transfers",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error creating transfer",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createTransfer", model: "Transaction", code: error.code }
        : { operation: "createTransfer", model: "Transaction" },
    });
    throw error;
  }
}
