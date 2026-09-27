import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { streamChatCompletion, AI_PROVIDER, type ChatMessageInput, type StreamUsageInfo } from "@/lib/nvidia-ai";
import { getFinancialContextSummary } from "@/lib/data/chat-context";
import {
  listMessages,
  getConversation,
  touchConversation,
  maybeAutoTitle,
  ConversationNotFoundError,
} from "@/lib/data/conversations";
import { checkRateLimit, rateLimitResponse, CHAT_USER_RULE, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories, toCategoryOptions } from "@/lib/data/categories";
import { getAssetTypeOption } from "@/lib/assets";
import { formatJalaaliDate, formatNumber, formatDecimal } from "@/lib/format";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/limits";
import { logger } from "@/lib/observability/logger";
import { REQUEST_ID_HEADER, runWithRequestContext } from "@/lib/observability/request-context";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Bounds worst-case prompt size from a single very long historical message
// (e.g. a wall of pasted text) without losing recent conversational flow -
// the last 16 messages are still all sent, just capped in length.
const HISTORY_MESSAGE_CHAR_CAP = 800;

// How many of THIS conversation's messages ride along as prompt history.
// Scoped per conversation since this change, so nothing from another
// thread can bleed into this one's context.
const HISTORY_MESSAGE_TAKE = 16;

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
  return `تو «جیب» هستی؛ یک رفیق باهوش و مالی‌آگاه که حواسش به وضعیت مالی کاربره و کمکش می‌کنه به هدف‌هاش برسه - نه یک ربات رسمی، نه یک مربی شعاری و نه یک ناظر سرزنشگر. همیشه با «تو» به کاربر خطاب کن، نه «شما». این گفتگو صمیمی‌ترین سطح لحن در اپ است، پس می‌تونی کمی از بقیه بخش‌ها راحت‌تر باشی - اما هیچ‌وقت فقط برای پر کردن سکوت یا نشون دادن شخصیت حرف نزن.

قوانین پاسخ‌دادن:
- قضاوت نکن، توصیف کن - مثلاً به‌جای «زیادی خرج کردی» بگو «خرجت از میانگین بیشتر شده».
- وقتی پاسخت بر اساس اطلاعات مالی زیر باشه، ساختار «واقعیت ← تحلیل ← پیشنهاد» را رعایت کن: اول یک عدد یا واقعیت مشخص از همین داده‌ها، بعد دلیلش در صورت وجود، و پیشنهاد را فقط وقتی بیار که واقعاً از داده‌ها درمی‌آد - نه به‌صرف اینکه مفید به‌نظر برسه.
- الکی خوش‌وبش، احوال‌پرسی مصنوعی یا شوخی بی‌دلیل نساز؛ فقط وقتی حرفی برای گفتن هست حرف بزن.
- در موقعیت جدی (موجودی کم، هشدار ریسک، هر چیز مربوط به امنیت حساب) هیچ شوخی یا ایموجی به‌کار نبر.
- کوتاه و مستقیم پاسخ بده؛ این یک گفتگو است، نه یک گزارش.
- اگر داده کافی برای پاسخ دقیق نیست، صادقانه بگو و حدس نزن.
- اگر می‌خوای در یک جمله بامزه یا باحال باشی، این بامزگی باید از یک مشاهده‌ی دقیق و مشخص درباره‌ی اطلاعات مالی زیر یا همین پیام کاربر در همین گفتگو بیاید، نه از یک جک یا شعار کلی که برای هر کاربر و هر گفتگوی دیگری هم جواب بده: اگه بشه یه جمله رو از یک گفتگوی کاملاً متفاوت برداری و همون اثر رو بزنه، یعنی از داده‌های این کاربر نیومده - باید حذفش کنی یا دوباره بر اساس یک عدد یا واقعیت واقعی از همین اطلاعات بسازی.
- وقتی اطلاعات مالی زیر به‌وضوح یکی از این حال‌وهواها را نشان می‌ده: خرج بیشتر از میانگین خود کاربر، یک ماه خوب و زیر بودجه، نزدیک‌شدن به یک هدف، یا یک فرصت صرفه‌جویی محسوس در یکی از دسته‌ها - می‌تونی، به‌عنوان یک استثنای محدود بر ترتیب «واقعیت ← تحلیل ← پیشنهاد» بالا، پاسخ را با یک جمله‌ی جسور، بامزه و مشخص درباره‌ی همین داده باز کنی، اما فقط پیش از عدد واقعی، نه به‌جای آن - مثلاً چیزی در مایه‌ی «انگار امسال رکورد خرج‌کردن جابه‌جا کردی» (برای خرج بیشتر از حد معمول)، «این ماه حسابی مراقب جیبت بودی» (برای ماه خوب) یا «دیگه بوی رسیدن به هدف میاد» (برای نزدیک‌شدن به هدف) - این‌ها فقط نمونه‌ی حال‌وهوا هستن برای الگو گرفتن، نه جمله‌ی آماده برای عیناً تکرار کردن؛ خودت بر اساس عدد واقعی همین مکالمه و با تنوع بساز. همیشه اول همون تکه‌ی بامزه، بعد عدد واقعی، در همون جمله یا جمله‌ی بعدی.
- این استثنا فقط همینه و هیچ‌کدوم از دو قانون بالا رو ضعیف نمی‌کنه: طبق قانون «در موقعیت جدی...» هیچ‌وقت به موجودی کم، هشدار ریسک یا هر چیز مربوط به امنیت حساب تکه‌ی بامزه اضافه نکن، و طبق قانون «الکی خوش‌وبش... نساز» وقتی چیز معناداری تغییر نکرده فقط همینو رک بگو، بدون شوخی یا تلاش برای گرم‌کردن یک پاسخ خنثی.
- در هر پاسخ حداکثر یک تکه‌ی بامزه/جسور بگذار، هیچ‌وقت دو یا چند تا را روی هم نگذار، و هیچ‌وقت بعدش توضیح نده چرا بامزه بود - بعد از همون یک تکه مستقیم برو سراغ عدد و ادامه‌ی حرف.

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
  if (!parsed.assetSuggestion) return `${base}. می‌خوای ثبتش کنم؟`;

  const option = getAssetTypeOption(parsed.assetSuggestion.type);
  const unit = option?.unitLabel ? ` ${option.unitLabel}` : "";
  return `${base} - با ثبت آن، ${formatDecimal(parsed.assetSuggestion.quantity, 4)}${unit} ${option?.label ?? ""} هم به دارایی‌هات اضافه می‌شود. می‌خوای ثبتش کنم؟`;
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
  const categoryOptions = toCategoryOptions(categories);

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

// Both reply paths (the suggest_transaction JSON response and the normal
// streamed one) end the same way: bump the thread's position in the
// history list, and - only for a still-untitled thread - name it after the
// message that started it. maybeAutoTitle is a no-op on every later turn
// (its own `title: null` WHERE guarantees that), so this is safe to call
// unconditionally rather than reading the title back first.
async function finalizeConversationTurn(conversationId: number, userMessage: string) {
  await Promise.all([touchConversation(conversationId), maybeAutoTitle(conversationId, userMessage)]);
}

// Phase 1 chat-pipeline-instrumentation: fields for the one structured
// "chat pipeline timing" log line emitted per request (see
// emitPipelineTiming below). Every *Ms field is a real, measured stage
// from this route's actual control flow - nothing here is a stage that
// was expected but doesn't exist as a discrete step; see the inline
// comments at each assignment site for what each one actually covers and
// what's nested inside it rather than broken out separately.
interface PipelineTimingFields {
  requestId: string;
  userId: number;
  conversationId: number;
  outcome: "transaction_suggestion" | "ai_error" | "success";
  precheckDurationMs: number;
  transactionIntentDurationMs: number;
  suggestionAttemptDurationMs: number | null;
  dbDurationMs: number;
  contextDurationMs: number | null;
  llmTtfbMs: number | null;
  llmTotalDurationMs: number | null;
  llmProvider: string | null;
  llmModel: string | null;
  // Final assistant-message persist (prisma.chatMessage.create) plus
  // finalizeConversationTurn() (touchConversation + maybeAutoTitle via
  // Promise.all) - both run AFTER suggestionAttemptDurationMs/
  // llmTotalDurationMs are computed but BEFORE emitPipelineTiming() is
  // called, so without this field that time was silently folded into
  // totalDurationMs with nothing naming it. null on the ai_error path,
  // which does no DB writes at all.
  finalizeDurationMs: number | null;
  // Named `usage`, not `tokens` - lib/observability/redact.ts's
  // SENSITIVE_KEYWORDS list matches "token" as a case-insensitive
  // *substring* of the key (so it also catches names like "apiKeySecret"),
  // which means a field literally named `tokens` gets masked to
  // "[REDACTED]" wholesale, silently defeating requirement 3. Confirmed
  // by running this route's own tests and seeing exactly that in the
  // logged output before this rename. `usage` is also the name
  // lib/ai/detect-transaction-intent.ts's own log line already uses for
  // the same TokenUsage-shaped data, so this also matches existing
  // convention.
  usage: StreamUsageInfo | null;
  totalDurationMs: number;
}

// Requirement: "a logging failure can never break or delay the actual
// response" - the try/catch here is the whole point of this wrapper
// (logger.info/pino is not expected to throw, but nothing about this
// instrumentation's correctness should depend on that staying true).
function emitPipelineTiming(fields: PipelineTimingFields): void {
  try {
    logger.info(fields, "chat pipeline timing");
  } catch {
    // Deliberately swallowed - see this function's own comment above.
  }
}

export async function POST(request: NextRequest) {
  // Same pattern proxy.ts documents for a route handler that wants
  // getRequestId() (used by reportError/detectTransactionIntent/etc.
  // below) to work for its own nested calls: reuse the header proxy.ts
  // forwards when present, otherwise mint one - see
  // lib/observability/request-context.ts's own doc comment on why a scope
  // opened in proxy.ts doesn't already cover this handler. This route
  // previously had no such scope at all (every existing getRequestId()
  // call site here and in lib/ai/detect-transaction-intent.ts logged
  // requestId: undefined) - opening it here is what makes requirement 1
  // ("threaded through all log lines for that request") actually true,
  // not just for this new log line but for the pre-existing ones too.
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  return runWithRequestContext({ requestId }, () => handleChatPost(request, requestId));
}

async function handleChatPost(request: NextRequest, requestId: string): Promise<Response> {
  const totalStartedAt = Date.now();

  const session = await getSession();
  if (!session) {
    return Response.json({ error: "ابتدا وارد شو." }, { status: 401 });
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

  // Every message now belongs to exactly one conversation - there is no
  // "the user's thread" any more. Clients with no conversation yet (a
  // brand-new user, or the "گفتگوی جدید" button) create one first via
  // POST /api/chat/conversations and send its id here; this route never
  // creates one implicitly, so a typo'd/absent id can't silently start a
  // stray thread.
  const conversationId = Number(body?.conversationId);
  if (!Number.isInteger(conversationId)) {
    return Response.json({ error: "شناسه گفتگو نامعتبر است." }, { status: 400 });
  }

  // dbDurationMs below aggregates only these two direct-in-this-route
  // Prisma calls (ownership lookup + the user message insert) - the DB
  // calls made by getFinancialContextSummary/listMessages (context stage,
  // below) and by trySuggestTransaction's own listCategories/
  // parseTransactionWithAI (transaction-intent stage) are real DB calls
  // too, but they're already counted inside their own stage's *DurationMs -
  // instrumenting each of those individually would mean threading timers
  // into lib/data/chat-context.ts, lib/data/conversations.ts,
  // lib/data/categories.ts and lib/ai/parse-transaction.ts, which is
  // outside this route-only instrumentation pass. The final assistant
  // message insert and finalizeConversationTurn (touchConversation +
  // maybeAutoTitle) are DB work too, but run after this stage and are
  // timed separately as finalizeDurationMs (see PipelineTimingFields).
  let dbDurationMs = 0;

  // Ownership checked before anything is written and before any AI call is
  // made - a guessed id belonging to someone else costs nothing and
  // reveals nothing beyond the same 404 a nonexistent id gets.
  const ownershipCheckStartedAt = Date.now();
  try {
    await getConversation(session.userId, conversationId);
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
  dbDurationMs += Date.now() - ownershipCheckStartedAt;

  const userMessageInsertStartedAt = Date.now();
  await prisma.chatMessage.create({
    data: { userId: session.userId, role: "user", content: message, conversationId },
  });
  dbDurationMs += Date.now() - userMessageInsertStartedAt;

  // router/precheck stage: handler entry through session/rate-limit/body
  // validation, conversation-ownership check and persisting the user's
  // message - everything that runs before intent logic starts.
  const precheckDurationMs = Date.now() - totalStartedAt;

  const transactionIntentStartedAt = Date.now();
  const intent = await detectTransactionIntent(message, session.userId);
  const transactionIntentDurationMs = Date.now() - transactionIntentStartedAt;

  let suggestionClarifyingNote: string | undefined;
  // Only set when the intent branch below actually runs
  // trySuggestTransaction - stays null in the log line otherwise, rather
  // than a misleading 0.
  let suggestionAttemptDurationMs: number | null = null;
  if (intent.isPastUnloggedTransaction) {
    const suggestionAttemptStartedAt = Date.now();
    const attempt = await trySuggestTransaction(session.userId, message);
    suggestionAttemptDurationMs = Date.now() - suggestionAttemptStartedAt;

    if (attempt.ok) {
      // Persisted as plain text, same as every other assistant reply, so
      // chat history/context stays coherent - the structured
      // `transaction` payload below is deliberately NOT persisted (no DB
      // write happens here at all beyond this chat log line; see
      // components/chat/chat-interface.tsx for where the pending
      // suggestion actually lives - client-side state only, until the
      // user explicitly confirms).
      const finalizeStartedAt = Date.now();
      await prisma.chatMessage.create({
        data: { userId: session.userId, role: "assistant", content: attempt.confirmationText, conversationId },
      });
      await finalizeConversationTurn(conversationId, message);
      const finalizeDurationMs = Date.now() - finalizeStartedAt;
      // This path short-circuits before context building or any LLM call,
      // so those fields are null below rather than fabricated - see
      // PipelineTimingFields' own comment.
      emitPipelineTiming({
        requestId,
        userId: session.userId,
        conversationId,
        outcome: "transaction_suggestion",
        precheckDurationMs,
        transactionIntentDurationMs,
        suggestionAttemptDurationMs,
        dbDurationMs,
        contextDurationMs: null,
        llmTtfbMs: null,
        llmTotalDurationMs: null,
        llmProvider: null,
        llmModel: null,
        usage: null,
        finalizeDurationMs,
        totalDurationMs: Date.now() - totalStartedAt,
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

  // context stage: builds the financial-summary prompt block
  // (getFinancialContextSummary - itself several Prisma reads run via its
  // own internal Promise.all, not broken out separately here - see
  // dbDurationMs's own comment) together with this conversation's message
  // history. The two run concurrently, so this one timer covers both.
  const contextStartedAt = Date.now();
  const [context, orderedHistory] = await Promise.all([
    getFinancialContextSummary(session.userId),
    // Already oldest-first, and already the most RECENT N (not the oldest
    // N) - see listMessages' own comment on that ordering.
    listMessages(session.userId, conversationId, HISTORY_MESSAGE_TAKE),
  ]);
  const contextDurationMs = Date.now() - contextStartedAt;

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
  // Captured via streamChatCompletion's onUsage callback (see
  // StreamUsageInfo in lib/nvidia-ai.ts) - only populated once the
  // provider actually sends the final usage SSE chunk, which lands
  // partway through consuming the stream below, not when the call
  // resolves - so these stay unset until that chunk arrives (or forever,
  // if the stream is cancelled before it does).
  let usage: StreamUsageInfo | null = null;
  const aiCallStartedAt = Date.now();
  try {
    upstream = await streamChatCompletion(messages, {
      onUsage: (info) => {
        usage = info;
      },
    });
    // llmTtfbMs: NVIDIA NIM/ArvanCloud accepting the request and starting
    // to stream a response (fetch()'s promise resolving on response
    // headers/first SSE bytes) - not the full response body, which
    // streams asynchronously afterward through the ReadableStream below
    // (see llmTotalDurationMs, measured at that stream's completion).
    logger.info(
      {
        requestId,
        route: "api/chat",
        userId: session.userId,
        duration: Date.now() - aiCallStartedAt,
        provider: AI_PROVIDER,
      },
      "AI call succeeded"
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : "ارتباط با هوش مصنوعی برقرار نشد، دوباره تلاش کن.";
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
    // The LLM call is the failure itself here, so llmTtfbMs/
    // llmTotalDurationMs stay null rather than a misleading number.
    emitPipelineTiming({
      requestId,
      userId: session.userId,
      conversationId,
      outcome: "ai_error",
      precheckDurationMs,
      transactionIntentDurationMs,
      suggestionAttemptDurationMs,
      dbDurationMs,
      contextDurationMs,
      llmTtfbMs: null,
      llmTotalDurationMs: null,
      llmProvider: AI_PROVIDER,
      llmModel: null,
      usage: null,
      finalizeDurationMs: null,
      totalDurationMs: Date.now() - totalStartedAt,
    });
    // Same 502 as before, but a fixed client-facing message - `text` (raw
    // provider/network/config error text) goes only to reportError above.
    return Response.json({ error: "ارتباط با هوش مصنوعی برقرار نشد، دوباره تلاش کن." }, { status: 502 });
  }
  const llmTtfbMs = Date.now() - aiCallStartedAt;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // llmTotalDurationMs: full generation, from the initial call to
        // the stream fully draining - not "response sent" in the
        // headers-flushed sense (the client has been receiving bytes
        // since llmTtfbMs), but the actual end of this request's real
        // work, which is where requirement 4's "one log line per
        // request" is emitted from on this path (totalDurationMs below
        // covers the same span, from handler entry).
        const llmTotalDurationMs = Date.now() - aiCallStartedAt;
        const finalizeStartedAt = Date.now();
        if (fullResponse.trim()) {
          await prisma.chatMessage.create({
            data: { userId: session.userId, role: "assistant", content: fullResponse, conversationId },
          });
        }
        // Runs even when the model returned nothing worth persisting: the
        // user's own message is already in this conversation, so its
        // "last activity" and its title should reflect that turn either
        // way.
        await finalizeConversationTurn(conversationId, message);
        const finalizeDurationMs = Date.now() - finalizeStartedAt;
        emitPipelineTiming({
          requestId,
          userId: session.userId,
          conversationId,
          outcome: "success",
          precheckDurationMs,
          transactionIntentDurationMs,
          suggestionAttemptDurationMs,
          dbDurationMs,
          contextDurationMs,
          llmTtfbMs,
          llmTotalDurationMs,
          llmProvider: AI_PROVIDER,
          llmModel: usage?.model ?? null,
          usage,
          finalizeDurationMs,
          totalDurationMs: Date.now() - totalStartedAt,
        });
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
