import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { streamChatCompletion, type ChatMessageInput } from "@/lib/nvidia-ai";
import { getFinancialContextSummary } from "@/lib/data/chat-context";
import { checkRateLimit, rateLimitResponse, CHAT_USER_RULE, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import type { CategoryType } from "@/lib/categories";
import { formatJalaaliDate, formatNumber } from "@/lib/format";

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
function buildConfirmationText(parsed: ParsedTransaction): string {
  return `این خرید ${formatJalaaliDate(parsed.date)} به مبلغ ${formatNumber(parsed.amount)} تومان برای ${parsed.description} ثبت نشده. می‌خواید ثبتش کنم؟`;
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

  if (parsed.type !== "expense" || parsed.needsConfirmation || parsed.suggestedCategory) {
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

  await prisma.chatMessage.create({ data: { userId: session.userId, role: "user", content: message } });

  const intent = await detectTransactionIntent(message);

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
  try {
    upstream = await streamChatCompletion(messages);
  } catch (error) {
    const text = error instanceof Error ? error.message : "خطا در ارتباط با هوش مصنوعی.";
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
