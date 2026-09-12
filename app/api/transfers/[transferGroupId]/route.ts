import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { deleteTransfer, TransferNotFoundError } from "@/lib/data/transfers";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ transferGroupId: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { transferGroupId } = await params;
  // Unlike /api/accounts/[id] and /api/transactions/[id] (numeric
  // Number.isInteger ids), transferGroupId is the crypto.randomUUID() string
  // createTransfer() generated - just a non-empty-string shape check here;
  // anything malformed simply won't match any row and falls through to
  // deleteTransfer()'s own TransferNotFoundError below.
  if (!transferGroupId) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteTransfer(session.userId, transferGroupId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TransferNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - the known outcome above is already
    // handled, expected, and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "transfers/[transferGroupId]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting transfer",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteTransfer", model: "Transaction", code: error.code }
        : { operation: "deleteTransfer", model: "Transaction" },
    });
    throw error;
  }
}
