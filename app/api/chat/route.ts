import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { streamChatCompletion, AI_PROVIDER, type ChatMessageInput } from "@/lib/nvidia-ai";
import { getFinancialContextSummary } from "@/lib/data/chat-context";
import { checkRateLimit, rateLimitResponse, CHAT_USER_RULE, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { getAssetTypeOption } from "@/lib/assets";
import { formatJalaaliDate, formatNumber, formatDecimal } from "@/lib/format";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/limits";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/observability/request-context";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Bounds worst-case prompt size from a single very long historical message
// (e.g. a wall of pasted text) without losing recent conversational flow -
// the last 16 messages are still all sent, just capped in length.
const HISTORY_MESSAGE_CHAR_CAP = 800;

function truncateForPrompt(content: string): string {
  if (content.length <= HISTORY_MESSAGE_CHAR_CAP) return content;
  return `${content.slice(0, HISTORY_MESSAGE_CHAR_CAP)}…`;
}

// extraNote is only ever the low-confidence-transaction nudge appended below
// (buildSuggestionAttemptNote's result) - kept as a plain optional suffix
// rather than a separate prompt/call so the normal conversational flow
// (context, history, streaming) stays completely unchanged in every other
// case.
function buildSystemPrompt(context: string, extraNote?: string): string {
  return `شما «جیب‌یار»، دستیار مالی هوشمند اپلیکیشن «جیب» هستید. به زبان فارسی، دوستانه، مختصر و کاربردی پاسخ بده. پاسخ‌هایت را بر اساس اطلاعات مالی واقعی زیر (استخراج‌شده از حساب کاربر) بنا کن و در صورت لزوم توصیه عملی برای مدیریت بهتر مالی بده. اگر داده کافی برای پاسخ دقیق نیست، صادقانه بگو و حدس نزن.

اطلاعات مالی فعلی کاربر:
${context}${extraNote ? `\n\n${extraNote}` : ""}`;
}

const SUGGESTION_CLARIFYING_NOTE =
  "به‌نظر می‌رسد کاربر یک تراکنش (خرج یا دریافت) گذشته و ثبت‌نشده را توصیف کرده، اما مبلغ یا نوع خرید به‌اندازه‌ی کافی مشخص نیست. به‌جای پاسخ عمومی، یک سؤال کوتاه و دقیق بپرس تا این اطلاعات مشخص شود (مثلاً دقیق مبلغ چقدر بود، یا برای چه چیزی خرج شد).";

// این خرید [تاریخ] به مبلغ [مبلغ] تومان برای [توضیح] ثبت نشده. می‌خواید ثبتش کنم؟
// When parsed.assetSuggestion is set (lib/ai/parse-transaction.ts detected
// this as buying a live-priced asset - gold/usd/bitcoin), an extra clause
// tells the user confirming this will also add it to their Assets, so
// "بله" isn't a surprise once it does (see handleConfirmSuggestion in
// components/chat/chat-interface.tsx, which forwards assetSuggestion as
// assetPurchase to POST /api/transactions).
function buildConfirmationText(parsed: ParsedTransaction): string {
  const base = `این خرید ${formatJalaaliDate(parsed.date)} به مبلغ ${formatNumber(parsed.amount)} تومان برای ${parsed.description} ثبت نشده`;
  if (!parsed.assetSuggestion) return `${base}. می‌خواید ثبتش کنم؟`;

  const option = getAssetTypeOption(parsed.assetSuggestion.type);
  const unit = option?.unitLabel ? ` ${option.unitLabel}` : "";
  return `${base} - با ثبت آن، ${formatDecimal(parsed.assetSuggestion.quantity, 4)}${unit} ${option?.label ?? ""} هم به دارایی‌هات اضافه می‌شود. می‌خواید ثبتش کنم؟`;
}

type SuggestionAttempt =
  | { ok: true; confirmationText: string; parsed: ParsedTransaction }
  | { ok: false; reason: "rate-limited" | "parse-failed" | "low-confidence" };

// Reuses parseTransactionWithAI (lib/ai/parse-transaction.ts) as-is for the
// actual extraction - this function only decides, from its result, whether
// confidence is high enough to surface a suggest_transaction card instead of
// falling back to plain chat. Per the agreed guardrail: trigger only when
// the category resolution is already confident (needsConfirmation === false,
// the same >=0.80 bucket / deterministic-match bar the manual add-transaction
// preview already uses - see resolveAiCategory) and no newCategorySuggestion
// is pending (that flow has its own "بساز" UI in AddTransactionForm which
// the chat confirmation card does not reimplement). Scoped to type
// "expense" only, matching the confirmation copy's "این خرید" phrasing and
// the task's "past, unlogged expense" framing.
async function trySuggestTransaction(userId: number, message: string): Promise<SuggestionAttempt> {
  // Shares the exact same rate-limit bucket as the manual /api/transactions/
  // parse preview endpoint (same key prefix, same rule) - both are "AI
  // category/amount extraction" cost from the user's point of view, so they
  // draw from one shared budget rather than each getting their own.
  const limit = checkRateLimit(`transaction-parse:user:${userId}`, TRANSACTION_PARSE_USER_RULE);
  if (!limit.allowed) {
    return { ok: false, reason: "rate-limited" };
  }

  const categories = await listCategories(userId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryOptions = categories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
  }));

  let parsed: ParsedTransaction;
  try {
    parsed = await parseTransactionWithAI(userId, message, categoryOptions);
  } catch {
    return { ok: false, reason: "parse-failed" };
  }

  // parsed.assetSuggestion is an explicit exception to the needsConfirmation
  // gate: an asset purchase's amount/quantity comes from a deterministic
  // live-price lookup (lib/ai/parse-transaction.ts's resolveAssetPurchase),
  // not a guess, so mediocre *category* confidence (there's no perfect
  // "buying an investment" category to match against - see that file's own
  // buildSystemPrompt) shouldn't be enough to suppress the suggestion card
  // entirely. suggestedCategory still bails out unconditionally - that flow
  // needs its own "بساز" UI (AddTransactionForm), which this chat card
  // doesn't reimplement, same as before this change.
  if (
    parsed.type !== "expense" ||
    parsed.suggestedCategory ||
    (parsed.needsConfirmation && !parsed.assetSuggestion)
  ) {
    return { ok: false, reason: "low-confidence" };
  }

  return { ok: true, confirmationText: buildConfirmationText(parsed), parsed };
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const limit = checkRateLimit(`chat:user:${session.userId}`, CHAT_USER_RULE);
  if (!limit.allowed) {
    return rateLimitResponse(limit);
  }

  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) {
    return Response.json({ error: "پیام نمی‌تواند خالی باشد." }, { status: 400 });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return Response.json({ error: "پیام بیش از حد طولانی است." }, { status: 400 });
  }

  await prisma.chatMessage.create({ data: { userId: session.userId, role: "user", content: message } });

  const intent = await detectTransactionIntent(message, session.userId);

  let suggestionClarifyingNote: string | undefined;
  if (intent.isPastUnloggedTransaction) {
    const attempt = await trySuggestTransaction(session.userId, message);

    if (attempt.ok) {
      // Persisted as plain text, same as every other assistant reply, so
      // chat history/context stays coherent - the structured
      // `transaction` payload below is deliberately NOT persisted (no DB
      // write happens here at all beyond this chat log line; see
      // components/chat/chat-interface.tsx for where the pending
      // suggestion actually lives - client-side state only, until the
      // user explicitly confirms).
      await prisma.chatMessage.create({
        data: { userId: session.userId, role: "assistant", content: attempt.confirmationText },
      });
      return Response.json({
        type: "transaction_suggestion",
        message: attempt.confirmationText,
        transaction: attempt.parsed,
        rawInput: message,
      });
    }

    // Only nudge toward a clarifying question when the message genuinely
    // looked like an unlogged transaction but extraction fell short - a
    // rate-limit skip says nothing about the message itself, so it falls
    // through to a completely normal reply instead.
    if (attempt.reason === "low-confidence" || attempt.reason === "parse-failed") {
      suggestionClarifyingNote = SUGGESTION_CLARIFYING_NOTE;
    }
  }

  const [context, history] = await Promise.all([
    getFinancialContextSummary(session.userId),
    prisma.chatMessage.findMany({ where: { userId: session.userId }, orderBy: { timestamp: "desc" }, take: 16 }),
  ]);

  const orderedHistory = history.reverse();
  const lastIndex = orderedHistory.length - 1;
  const messages: ChatMessageInput[] = [
    { role: "system", content: buildSystemPrompt(context, suggestionClarifyingNote) },
    ...orderedHistory.map(
      (m, i): ChatMessageInput => ({
        role: m.role === "assistant" ? "assistant" : "user",
        // The last item is the current user message just created above -
        // never truncate that one, only older history.
        content: i === lastIndex ? m.content : truncateForPrompt(m.content),
      })
    ),
  ];

  let upstream: ReadableStream<Uint8Array>;
  const aiCallStartedAt = Date.now();
  try {
    upstream = await streamChatCompletion(messages);
    // "Success" here, and the duration measured, cover the initial call
    // only - i.e. NVIDIA NIM accepting the request and starting to stream
    // a response - not the full response body, which streams
    // asynchronously afterward through the ReadableStream below. Measuring
    // full-stream duration would mean threading timing state through that
    // stream's pull()/cancel() callbacks, a materially bigger change than
    // this sub-task's "wrap the AI call" scope.
    logger.info(
      {
        requestId: getRequestId(),
        route: "api/chat",
        userId: session.userId,
        duration: Date.now() - aiCallStartedAt,
        provider: AI_PROVIDER,
      },
      "AI call succeeded"
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : "خطا در ارتباط با هوش مصنوعی.";
    // Sanitized params only - `messages` carries the user's financial
    // context/chat history, never logged/reported verbatim (Phase 12.4.1).
    reportError({
      errorType: ERROR_TYPES.AI_ERROR,
      route: "api/chat",
      userId: session.userId,
      duration: Date.now() - aiCallStartedAt,
      message: text,
      error,
      context: { provider: AI_PROVIDER, messageCount: messages.length },
    });
    // Response unchanged - same 502 + same Persian error text as before.
    return Response.json({ error: text }, { status: 502 });
  }

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (fullResponse.trim()) {
          await prisma.chatMessage.create({
            data: { userId: session.userId, role: "assistant", content: fullResponse },
          });
        }
        controller.close();
        return;
      }
      fullResponse += decoder.decode(value, { stream: true });
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
