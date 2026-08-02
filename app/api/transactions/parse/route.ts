import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { checkRateLimit, rateLimitResponse, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { logError } from "@/lib/error-log";

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
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
