import { chatCompletion } from "@/lib/openrouter";
import type { CategoryType } from "@/lib/categories";
import { findMerchant, type MerchantLookupResult, type MerchantMatchSource } from "@/lib/merchant-lookup";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate } from "@/lib/extract-date";

export interface ParsedTransaction {
  amount: number;
  type: CategoryType;
  category: string;
  description: string;
  date: string;
  // Where `category` came from - a learned user mapping, the global
  // merchant list, a keyword override, or the AI's own guess.
  source?: MerchantMatchSource | "ai";
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

// A merchant match's leaf category is its subcategory when present (e.g.
// "خرید آنلاین" under "خرید"), otherwise its top-level category. Only
// returned if it's actually a valid category for this user under the
// given type - a stale merchant/mapping pointing at a renamed or deleted
// category must not leak through.
function resolveCategoryOverride(
  match: MerchantLookupResult,
  type: CategoryType,
  categories: CategoryOption[]
): string | null {
  if (match.source === "none") return null;
  const candidate = match.subcategory ?? match.category;
  if (!candidate) return null;
  return categories.some((c) => c.name === candidate && c.type === type) ? candidate : null;
}

export async function parseTransactionWithAI(
  userId: number,
  rawInput: string,
  categories: CategoryOption[]
): Promise<ParsedTransaction> {
  const merchantMatch = await findMerchant(userId, rawInput);

  // Fully deterministic path: a merchant match gives us category (and its
  // own type - no need to guess income/expense), and if amount/date also
  // extract confidently from the raw text, there's nothing left for the
  // AI to add. Skip OpenRouter entirely.
  if (merchantMatch.source !== "none" && merchantMatch.type) {
    const overrideCategory = resolveCategoryOverride(merchantMatch, merchantMatch.type, categories);
    const amount = extractAmount(rawInput);
    const date = extractDate(rawInput);

    if (overrideCategory && amount !== null && date !== null) {
      return {
        amount,
        type: merchantMatch.type,
        category: overrideCategory,
        description: merchantMatch.merchantName ?? rawInput.slice(0, 40),
        date,
        source: merchantMatch.source,
      };
    }
  }

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
  const overrideCategory = resolveCategoryOverride(merchantMatch, type, categories);
  const aiCategoryValid = categories.some((c) => c.name === parsed.category && c.type === type);

  return {
    amount: Math.round(parsed.amount),
    type,
    category: overrideCategory ?? (aiCategoryValid ? parsed.category : "سایر"),
    description: parsed.description?.trim() || rawInput.slice(0, 40),
    date: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : new Date().toISOString().slice(0, 10),
    source: overrideCategory ? merchantMatch.source : "ai",
  };
}
