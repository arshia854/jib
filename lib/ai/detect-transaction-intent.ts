import { chatCompletion } from "@/lib/nvidia-ai";
import { extractJson } from "@/lib/ai/parse-transaction";

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
export async function detectTransactionIntent(message: string): Promise<ChatIntent> {
  let content: string;
  try {
    content = await chatCompletion(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: message },
      ],
      { json: true }
    );
  } catch {
    return { isPastUnloggedTransaction: false };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return { isPastUnloggedTransaction: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { isPastUnloggedTransaction: false };
  }

  const value = (parsed as Record<string, unknown>).isPastUnloggedTransaction;
  return { isPastUnloggedTransaction: value === true };
}
