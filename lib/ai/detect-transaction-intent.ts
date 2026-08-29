import { chatCompletion, AI_PROVIDER, type TokenUsage } from "@/lib/nvidia-ai";
import { extractJson } from "@/lib/ai/parse-transaction";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/observability/request-context";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// The chat assistant's only "tool-calling"-shaped decision point: does this
// message describe a past, unlogged transaction the user wants recorded
// (as opposed to a question/general chat)? Modeled as its own tiny
// json-mode call - same chatCompletion({ json: true }) mechanism
// parseTransactionWithAI already uses for the real extraction - rather than
// real OpenAI-style tools/tool_choice, since chatCompletion has never sent
// those and NVIDIA NIM + the configured llama-3.1-70b-instruct model
// haven't been verified to honor them reliably. The actual amount/category
// extraction is a separate step (parseTransactionWithAI) - this call's only
// job is the binary trigger decision.
export interface ChatIntent {
  isPastUnloggedTransaction: boolean;
}

function buildSystemPrompt(): string {
  return `شما بخشی از دستیار مالی «جیب» هستید. فقط یک وظیفه دارید: تشخیص اینکه آیا آخرین پیام کاربر توصیف یک تراکنش مالی گذشته و هنوز ثبت‌نشده است (چیزی که کاربر می‌خواهد در جیب ثبت شود) یا نه. فقط یک شیء JSON با دقیقاً همین کلید برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"isPastUnloggedTransaction": boolean}

قوانین:
- فقط وقتی true بگذار که پیام صراحتاً یک خرج یا دریافت مشخص با مبلغ را توصیف می‌کند که قبلاً اتفاق افتاده و در جیب ثبت نشده (مثلاً «دیروز ۲۰۰ تومن آبمیوه خوردم یادم رفت ثبت کنم» یا «هفته پیش ۵۰۰ تومن برای تعمیر ماشین دادم، ننوشتمش»).
- اگر پیام صرفاً یک سؤال درباره‌ی وضعیت مالی، تحلیل، مقایسه، یا گفتگوی عمومی است (مثلاً «این ماه چقدر خرج کردم؟» یا «چطور بیشتر پس‌انداز کنم؟»)، false بگذار.
- اگر پیام مبهم است، مبلغ مشخصی ندارد، یا معلوم نیست تراکنش قبلاً ثبت نشده، false بگذار - چنین پیامی باید مثل گفتگوی عادی پاسخ داده شود.
- اگر کاربر توضیح می‌دهد که تراکنشی را همین الان (نه در گذشته) می‌خواهد اضافه کند از طریق فرم ثبت تراکنش، false بگذار - این تشخیص فقط برای تراکنش‌های گذشته و فراموش‌شده است.`;
}

// Fails safe to { isPastUnloggedTransaction: false } on any malformed/
// unexpected response - a missed detection just means this one message is
// answered as normal chat (the existing, always-safe behavior), whereas a
// false positive would risk surfacing a bogus transaction suggestion.
//
// userId is only used for observability (Phase 12.4) - attaching it to the
// AI-latency/failure log line and Sentry report below - not for any
// behavioral decision in this function.
export async function detectTransactionIntent(message: string, userId: number): Promise<ChatIntent> {
  const aiCallStartedAt = Date.now();
  let content: string;
  let usage: TokenUsage | undefined;
  try {
    content = await chatCompletion(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: message },
      ],
      { json: true, onUsage: (u) => { usage = u; } }
    );
    logger.info(
      {
        requestId: getRequestId(),
        route: "ai/detect-transaction-intent",
        userId,
        duration: Date.now() - aiCallStartedAt,
        provider: AI_PROVIDER,
        usage,
      },
      "AI call succeeded"
    );
  } catch (error) {
    // Sanitized params only - `message` is the user's raw chat message,
    // never logged/reported verbatim (Phase 12.4.1).
    reportError({
      errorType: ERROR_TYPES.AI_ERROR,
      route: "ai/detect-transaction-intent",
      userId,
      duration: Date.now() - aiCallStartedAt,
      message: error instanceof Error ? error.message : "AI call failed",
      error,
      context: { provider: AI_PROVIDER, messageLength: message.length },
    });
    // Existing fallback behavior preserved unchanged (Phase 12.4.2/12.4.3):
    // this function already treats any failure here as "answer normally",
    // not an error to surface - logging is purely additive.
    return { isPastUnloggedTransaction: false };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch (extractError) {
    // Sanitized input only - `content` is the AI's own response text -
    // logged as shape (length), not verbatim. No parser-version field:
    // this codebase has no such concept anywhere (checked), so none is
    // invented here per the Phase 12 spec. Existing fallback behavior
    // (answer normally) preserved unchanged - logging is purely additive.
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "ai/detect-transaction-intent",
      userId,
      message: extractError instanceof Error ? extractError.message : "Failed to extract JSON from AI response",
      error: extractError,
      context: { contentLength: content.length },
    });
    return { isPastUnloggedTransaction: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    const validationError = new Error("AI response was not a JSON object");
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "ai/detect-transaction-intent",
      userId,
      message: validationError.message,
      error: validationError,
      context: { contentLength: content.length },
    });
    return { isPastUnloggedTransaction: false };
  }

  const value = (parsed as Record<string, unknown>).isPastUnloggedTransaction;
  return { isPastUnloggedTransaction: value === true };
}
