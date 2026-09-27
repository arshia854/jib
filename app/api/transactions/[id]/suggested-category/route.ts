import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import {
  getTransaction,
  applySuggestedCategory,
  dismissSuggestedCategory,
  TransactionNotFoundError,
} from "@/lib/data/transactions";
import {
  resolveOrCreateCategoryFromSuggestion,
  CategoryCreationRateLimitedError,
  InvalidParentCategoryError,
  DuplicateCategoryError,
} from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { rateLimitResponse } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

// Acts on the AI's newCategorySuggestion left standing on a "quick submit"
// transaction's background enrichment (schema.prisma's own comment on
// Transaction.suggestedCategoryName and lib/workflows/enrich-transaction.ts)
// - the same "بسازمش؟" decision the synchronous AI-preview flow's own
// add-transaction-form.tsx already lets the user make inline, surfaced here
// for a transaction that was quick-submitted and enriched in the
// background instead, where there's no live preview screen to show it on.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const transactionId = Number(id);
  if (!Number.isInteger(transactionId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "accept" && action !== "dismiss") {
    return NextResponse.json({ error: "درخواست نامعتبر است." }, { status: 400 });
  }

  try {
    if (action === "dismiss") {
      await dismissSuggestedCategory(session.userId, transactionId);
      return NextResponse.json({ ok: true });
    }

    // action === "accept" - resolve the same way POST /api/categories'
    // source: "ai-suggestion" branch does (dedup, forced icon, rate limit -
    // see resolveOrCreateCategoryFromSuggestion's own comment for why this
    // isn't a copy-pasted duplicate of that logic), then apply the result.
    // getTransaction (ownership-scoped) is the same read applySuggestedCategory
    // itself repeats right before writing - a deliberate, cheap
    // double-check, not redundant: this call needs the suggestion's actual
    // name/parentName/type to resolve a category in the first place, before
    // applySuggestedCategory's own guard ever runs.
    const transaction = await getTransaction(session.userId, transactionId);
    if (!transaction || transaction.suggestedCategoryName === null) {
      throw new TransactionNotFoundError("این تراکنش پیشنهاد دسته‌بندی‌ای ندارد.");
    }

    const { category } = await resolveOrCreateCategoryFromSuggestion(session.userId, {
      name: transaction.suggestedCategoryName,
      parentName: transaction.suggestedCategoryParentName,
      type: transaction.type as CategoryType,
    });
    await applySuggestedCategory(session.userId, transactionId, category.id);
    return NextResponse.json({ ok: true, category });
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof CategoryCreationRateLimitedError) {
      return rateLimitResponse(
        { allowed: false, remaining: 0, retryAfterSeconds: error.retryAfterSeconds },
        error.message
      );
    }
    if (error instanceof InvalidParentCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DuplicateCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Unhandled/unexpected only - the known domain outcomes above are
    // already handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "transactions/[id]/suggested-category",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error resolving suggested category",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: action, transactionId, code: error.code }
        : { operation: action, transactionId },
    });
    throw error;
  }
}
