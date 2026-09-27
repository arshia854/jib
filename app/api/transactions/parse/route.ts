import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { parseTransactionWithAI, UserFacingParseError, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories, toCategoryOptions } from "@/lib/data/categories";
import { checkRateLimit, rateLimitResponse, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { logError } from "@/lib/error-log";
import { MAX_TRANSACTION_TEXT_LENGTH } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/observability/request-context";

// Temporary diagnostic instrumentation - reported ~40s end-to-end latency
// on this route, but the only existing timing (parse-transaction.ts's "AI
// call succeeded" log) covers just the chatCompletion() HTTP call, not
// listCategories() or the rest of parseTransactionWithAI() (merchant
// lookup, JSON parsing/validation, live-price lookups, ...). This adds
// enough timing to see the real split before touching any behavior. No
// getRequestId()-based correlation exists yet anywhere in this codebase
// (no route opens a runWithRequestContext() scope - see
// lib/observability/request-context.ts's own comment on this), so this
// call is expected to log requestId: undefined for now, same as every
// other existing getRequestId() call site; kept for when that lands.
function derivePathLabel(source: ParsedTransaction["source"]): "bank-sms" | "ai" | "merchant-fast-path" | "unknown" {
  if (source === "bank-sms") return "bank-sms";
  if (source === "ai") return "ai";
  if (source === undefined) return "unknown";
  return "merchant-fast-path";
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now();
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const limit = checkRateLimit(`transaction-parse:user:${session.userId}`, TRANSACTION_PARSE_USER_RULE);
  if (!limit.allowed) {
    return rateLimitResponse(limit);
  }

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return NextResponse.json({ error: "متن تراکنش نمی‌تواند خالی باشد." }, { status: 400 });
  }
  if (text.length > MAX_TRANSACTION_TEXT_LENGTH) {
    return NextResponse.json({ error: "متن تراکنش بیش از حد طولانی است." }, { status: 400 });
  }

  const categoriesStartedAt = Date.now();
  const categories = await listCategories(session.userId);
  const categoriesDuration = Date.now() - categoriesStartedAt;
  const categoryOptions = toCategoryOptions(categories);

  try {
    // Passed through as-is, whichever source produced it - including the
    // bank-sms path's bank/bankConfidence and its always-true
    // needsConfirmation. This route does no confidence-gated logic of its
    // own, so nothing here needs to special-case bank-sms vs. ai/merchant
    // results; NextResponse.json() also drops the AI-only (confidence,
    // reason) and bank-sms-only (bank, bankConfidence) fields when unset,
    // so each response only carries the fields its own source produced.
    const parseStartedAt = Date.now();
    const parsed: ParsedTransaction = await parseTransactionWithAI(session.userId, text, categoryOptions);
    const parseDuration = Date.now() - parseStartedAt;
    logger.info(
      {
        requestId: getRequestId(),
        route: "transactions/parse",
        userId: session.userId,
        duration: Date.now() - requestStartedAt,
        categoriesDuration,
        parseDuration,
        path: derivePathLabel(parsed.source),
      },
      "Transaction parse request completed"
    );
    return NextResponse.json({ parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطا در پردازش متن.";
    await logError({
      route: "transactions/parse",
      message,
      stack: error instanceof Error ? error.stack : undefined,
      userId: session.userId,
    });
    // New (Phase 12.5) - added alongside the existing logError() call
    // above, not replacing it (per the Phase 12 audit's decision: ErrorLog
    // stays exactly as-is, the pino/Sentry pipeline is purely additive).
    // Tagged API_ERROR here, not AI_ERROR: this is this route's own
    // generic catch-all around the whole parseTransactionWithAI() call,
    // which can also fail for non-AI reasons (e.g. its JSON-extraction/
    // validation steps after an otherwise-successful AI response) - the
    // narrower, AI-call-specific failure is already tagged AI_ERROR and
    // reported one layer down inside lib/ai/parse-transaction.ts (Phase
    // 12.4), so a raw AI failure ends up reported at both layers (by
    // design, not a bug - see that file's own comment).
    reportError({
      errorType: ERROR_TYPES.API_ERROR,
      route: "transactions/parse",
      userId: session.userId,
      message,
      error,
      context: { statusCode: 502, textLength: text.length },
    });
    // Only UserFacingParseError's message (a fixed Persian string written
    // for the user, e.g. "write it more clearly") reaches the client as-is.
    // Anything else - raw provider/network/config error text - goes only to
    // logError/reportError above, and the client gets a generic message.
    const clientMessage =
      error instanceof UserFacingParseError ? error.message : "متن پردازش نشد. لطفاً دوباره تلاش کنید.";
    return NextResponse.json({ error: clientMessage }, { status: 502 });
  }
}
