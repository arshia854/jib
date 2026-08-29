import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { checkRateLimit, rateLimitResponse, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { logError } from "@/lib/error-log";
import { MAX_TRANSACTION_TEXT_LENGTH } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

export async function POST(request: NextRequest) {
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

  const categories = await listCategories(session.userId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryOptions = categories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
  }));

  try {
    // Passed through as-is, whichever source produced it - including the
    // bank-sms path's bank/bankConfidence and its always-true
    // needsConfirmation. This route does no confidence-gated logic of its
    // own, so nothing here needs to special-case bank-sms vs. ai/merchant
    // results; NextResponse.json() also drops the AI-only (confidence,
    // reason) and bank-sms-only (bank, bankConfidence) fields when unset,
    // so each response only carries the fields its own source produced.
    const parsed: ParsedTransaction = await parseTransactionWithAI(session.userId, text, categoryOptions);
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
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
