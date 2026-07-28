import { chatCompletion } from "@/lib/openrouter";
import type { CategoryType } from "@/lib/categories";

export interface ParsedTransaction {
  amount: number;
  type: CategoryType;
  category: string;
  description: string;
  date: string;
}

interface CategoryOption {
  name: string;
  type: CategoryType;
}

interface RawParsedTransaction {
  amount: number;
  type: string;
  category: string;
  description?: string;
  date?: string;
}

function isRawParsedTransaction(value: unknown): value is RawParsedTransaction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.amount === "number" &&
    Number.isFinite(v.amount) &&
    (v.type === "income" || v.type === "expense") &&
    typeof v.category === "string"
  );
}

function buildSystemPrompt(categories: CategoryOption[]): string {
  const expenseCats = categories.filter((c) => c.type === "expense").map((c) => c.name).join("، ");
  const incomeCats = categories.filter((c) => c.type === "income").map((c) => c.name).join("، ");
  const today = new Date().toISOString().slice(0, 10);

  return `شما دستیار استخراج اطلاعات مالی اپلیکیشن «جیب» هستید. کاربر یک جمله فارسی محاوره‌ای درباره یک تراکنش مالی می‌نویسد (مثلاً «۵۰ تومن ناهار خوردم» یا «حقوق ۱۵ میلیون تومن گرفتم»). فقط یک شیء JSON با دقیقاً همین کلیدها برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"amount": number, "type": "income" | "expense", "category": string, "description": string, "date": "YYYY-MM-DD"}

دسته‌های هزینه مجاز: ${expenseCats}
دسته‌های درآمد مجاز: ${incomeCats}
امروز (تقویم میلادی): ${today}

قوانین:
- amount همیشه عدد صحیح مثبت به تومان است.
- تبدیل واحد را فقط بر اساس آنچه صریحاً در متن ذکر شده انجام بده، حدس نزن:
  بدون واحد یا "تومان"/"تومن" → همان عدد؛ "هزار تومان/تومن" → عدد×۱۰۰۰؛ "میلیون تومان/تومن" → عدد×۱۰۰۰۰۰۰؛ "ریال" → عدد÷۱۰.
- اگر نوع (درآمد/هزینه) از متن مشخص نبود، "expense" در نظر بگیر.
- category را دقیقاً از یکی از لیست‌های بالا (متناسب با type) انتخاب کن؛ اگر هیچ‌کدام مناسب نبود از دسته «سایر» با type درست استفاده کن.
- description خلاصه‌ای حداکثر ۵ کلمه‌ای و طبیعی از تراکنش است.
- date را به‌صورت YYYY-MM-DD میلادی برگردان. اگر تاریخ خاصی گفته نشده امروز را برگردان. "دیروز"/"پریروز" را نسبت به امروز محاسبه کن.`;
}

function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned);
}

export async function parseTransactionWithAI(
  rawInput: string,
  categories: CategoryOption[]
): Promise<ParsedTransaction> {
  const content = await chatCompletion(
    [
      { role: "system", content: buildSystemPrompt(categories) },
      { role: "user", content: rawInput },
    ],
    { json: true }
  );

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    throw new Error("متوجه متن تراکنش نشدم. لطفاً واضح‌تر بنویسید.");
  }

  if (!isRawParsedTransaction(parsed) || parsed.amount <= 0) {
    throw new Error("پاسخ هوش مصنوعی ساختار نامعتبری داشت. دوباره تلاش کنید.");
  }

  const type = parsed.type as CategoryType;
  const categoryValid = categories.some((c) => c.name === parsed.category && c.type === type);

  return {
    amount: Math.round(parsed.amount),
    type,
    category: categoryValid ? parsed.category : "سایر",
    description: parsed.description?.trim() || rawInput.slice(0, 40),
    date: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : new Date().toISOString().slice(0, 10),
  };
}
