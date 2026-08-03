import { chatCompletion } from "@/lib/nvidia-ai";
import { findSimilarCategory, resolveNewCategoryIcon, type CategoryType } from "@/lib/categories";
import { findMerchant, type MerchantLookupResult, type MerchantMatchSource } from "@/lib/merchant-lookup";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate } from "@/lib/extract-date";
import { parseBankSms, type BankSmsParseResult } from "@/lib/bank/parse-bank-sms";
import { normalizeText as normalizeBankSmsText } from "@/lib/bank/normalize";
import type { Bank } from "@/lib/bank/types";

// The AI's proposal for a brand-new category - see buildSystemPrompt's
// قوانین for when the model may populate this (last resort only).
// sanitizeNewCategorySuggestion decides what's trusted enough to surface
// here; anything else (missing fields, or an extra key like a
// hallucinated `icon` - not part of this schema, see Subtask 10.3) is
// dropped instead.
export interface SuggestedCategory {
  name: string;
  parentName: string | null;
  reason: string;
}

// The surfaced form of SuggestedCategory, once it's confirmed to have no
// match among existing categories (see findSimilarCategory in
// lib/categories.ts). icon is computed server-side via
// resolveNewCategoryIcon - never taken from the AI's own response, which
// per SuggestedCategory above doesn't even carry one.
export interface SuggestedCategoryWithIcon extends SuggestedCategory {
  icon: string;
}

export interface ParsedTransaction {
  amount: number;
  type: CategoryType;
  category: string;
  description: string;
  date: string;
  // Where `category` came from - a learned user mapping, the global
  // merchant list, a keyword override, the AI's own guess, or a
  // deterministically-parsed bank SMS (which always lands on "سایر" - see
  // buildBankSmsResult).
  source?: MerchantMatchSource | "ai" | "bank-sms";
  // Only meaningful when source is "ai" - a merchant-resolved category is
  // always confidence: 1 / needsConfirmation: false (see resolveAiCategory).
  // Unset when source is "bank-sms" - there's no category signal to be
  // confident about there in the first place.
  confidence?: number;
  needsConfirmation?: boolean;
  reason?: string;
  // Bank identity and detection confidence, populated only when source is
  // "bank-sms". Kept separate from `confidence`, which means "confidence in
  // the category" - conflating the two would lose the bank engine's own
  // signal.
  bank?: Bank;
  bankConfidence?: number;
  // Strictly additive - `category` above is already a valid existing
  // category (or "سایر") regardless of whether this is set. Only ever
  // populated alongside an actual AI call, and only once findSimilarCategory
  // has confirmed it doesn't already match an existing category (a match
  // instead overwrites category/subcategory above - see
  // parseTransactionWithAI).
  suggestedCategory?: SuggestedCategoryWithIcon;
}

export interface CategoryOption {
  name: string;
  type: CategoryType;
  // Name of the parent category, if this is a subcategory. Needed to
  // validate the AI's (category, subcategory) pair against the real
  // hierarchy, not just check each name exists somewhere.
  parentName?: string;
}

interface RawParsedTransaction {
  amount: number;
  type: string;
  category: string;
  subcategory?: string | null;
  description?: string;
  date?: string;
  confidence?: number;
  reason?: string;
  newCategorySuggestion?: SuggestedCategory | null;
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

// newCategorySuggestion is optional and additive, so a malformed one must
// never fail the gate above and throw away an otherwise-valid
// amount/type/category - it's validated separately here instead. Only an
// object with exactly these three keys is trusted; anything else (missing
// fields, or an extra key like a hallucinated `icon` - not part of this
// schema, see Subtask 10.3) is dropped rather than partially trusted.
const SUGGESTION_KEYS = ["name", "parentName", "reason"];

function sanitizeNewCategorySuggestion(value: unknown): SuggestedCategory | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== SUGGESTION_KEYS.length || keys.some((k) => !SUGGESTION_KEYS.includes(k))) {
    return undefined;
  }
  if (typeof v.name !== "string" || typeof v.reason !== "string") return undefined;
  if (v.parentName !== null && typeof v.parentName !== "string") return undefined;
  return { name: v.name, parentName: v.parentName as string | null, reason: v.reason };
}

// Groups subcategories under their parent for the prompt, e.g.
// "خوراک و رستوران: سوپرمارکت، رستوران/کافه، دلیوری آنلاین" - lets the
// model see the real hierarchy instead of one flat name pool.
function formatCategoryTree(categories: CategoryOption[], type: CategoryType): string {
  return categories
    .filter((c) => c.type === type && !c.parentName)
    .map((top) => {
      const children = categories.filter((c) => c.type === type && c.parentName === top.name).map((c) => c.name);
      return children.length ? `${top.name}: ${children.join("، ")}` : top.name;
    })
    .join("\n");
}

function buildSystemPrompt(categories: CategoryOption[]): string {
  const expenseTree = formatCategoryTree(categories, "expense");
  const incomeTree = formatCategoryTree(categories, "income");
  const today = new Date().toISOString().slice(0, 10);

  return `شما دستیار استخراج اطلاعات مالی اپلیکیشن «جیب» هستید. کاربر یک جمله فارسی محاوره‌ای درباره یک تراکنش مالی می‌نویسد (مثلاً «۵۰ تومن ناهار خوردم» یا «حقوق ۱۵ میلیون تومن گرفتم»). گاهی متن ممکن است شامل نام فروشنده، توضیح، یا حتی متن یک پیامک بانکی paste‌شده باشد. فقط یک شیء JSON با دقیقاً همین کلیدها برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"amount": number, "type": "income" | "expense", "description": string, "date": "YYYY-MM-DD", "category": string, "subcategory": string | null, "confidence": number, "reason": string, "newCategorySuggestion": {"name": string, "parentName": string | null, "reason": string} | null}

دسته‌های هزینه مجاز (به‌همراه زیردسته‌ها):
${expenseTree}

دسته‌های درآمد مجاز (به‌همراه زیردسته‌ها):
${incomeTree}

امروز (تقویم میلادی): ${today}

قوانین:
- amount همیشه عدد صحیح مثبت به تومان است.
- تبدیل واحد را فقط بر اساس آنچه صریحاً در متن ذکر شده انجام بده، حدس نزن:
  عددی کاملاً بدون واحد (نه "تومان"/"تومن"، نه "هزار"/"میلیون"، نه "ریال") که بین ۱ تا ۹۹۹ باشد → عدد×۱۰۰۰ (مثلاً «۸۰» یعنی ۸۰ هزار تومان)؛ همان حالت با عدد ۱۰۰۰ یا بیشتر → همان عدد؛ عدد به‌همراه "تومان"/"تومن" صریح → همان عدد؛ الگوی "X و Y" یا "X.Y" با هر دو بخش بین ۱ تا ۹۹۹ → (X×۱۰۰۰۰۰۰)+(Y×۱۰۰۰) (مثلاً «۱ و ۱۰۰» یعنی ۱ میلیون و ۱۰۰ هزار تومان)؛ "هزار تومان/تومن" → عدد×۱۰۰۰؛ "میلیون تومان/تومن" → عدد×۱۰۰۰۰۰۰؛ "ریال" → عدد÷۱۰.
- اگر نوع (درآمد/هزینه) از متن مشخص نبود، "expense" در نظر بگیر.
- برای انتخاب category/subcategory، سیگنال‌های متن را به این ترتیب اولویت (از مهم‌ترین به کم‌اهمیت‌ترین) در نظر بگیر:
  ۱. نام فروشنده/مرچنت ذکرشده در متن
  ۲. توضیح یا شرح تراکنش
  ۳. کلیدواژه‌های مرتبط با نوع کالا/خدمت که از متن استخراج می‌شود
  ۴. متن پیامک بانکی، در صورتی که کاربر آن را عیناً paste کرده باشد
  ۵. نوع تراکنش (درآمد/هزینه)
  ۶. مبلغ - این را فقط یک سیگنال ضعیف در نظر بگیر؛ هرگز اجازه نده مبلغ، سیگنال‌های قوی‌تر مثل نام فروشنده یا توضیح را override کند.
- category را دقیقاً از یکی از دسته‌های سطح‌بالای بالا (متناسب با type) انتخاب کن. اگر یک زیردسته‌ی دقیق‌تر و مرتبط زیر همان دسته وجود دارد، نامش را در subcategory بگذار؛ در غیر این صورت subcategory را null کن.
- اگر هیچ دسته‌ای مناسب نبود، category را «سایر» با type درست بگذار و subcategory را null کن.
- newCategorySuggestion را فقط به‌عنوان آخرین راه‌حل پر کن: وقتی هیچ‌یک از دسته‌ها/زیردسته‌های مجاز بالا (متناسب با همان type) حتی به‌صورت تقریبی و نسبی هم مناسب نیستند. اگر متن فقط مبهم است ولی دست‌کم یک دسته‌ی موجود تاحدی جواب می‌دهد، newCategorySuggestion را null بگذار و مسیر عادی confidence را طی کن (بدون تغییر).
- parentName باید دقیقاً همان نام یکی از دسته‌های سطح‌بالای بالا (متناسب با type) باشد. فقط وقتی هیچ‌کدام از آن‌ها والد معقولی برای دسته‌ی پیشنهادی نیست، parentName را null بگذار.
- newCategorySuggestion فقط برای یک مفهوم هزینه/درآمد کلی و تکرارشونده مناسب است، نه یک رویداد یک‌باره، شخص خاص، سفر، یا پروژه. مثال:
  خوب: «دخانیات»، «لوازم حیوان خانگی»
  بد: «سفر شمال»، «ناهار دانشگاه»، «مامان»، «پروژه ایکس»
- پر شدن newCategorySuggestion هیچ تغییری در category ایجاد نمی‌کند: در همان پاسخ، category باید طبق همان قوانین بالا روی نزدیک‌ترین دسته‌ی معتبر موجود یا «سایر» تنظیم شود.
- confidence عددی بین ۰ و ۱ است: میزان اطمینانت به انتخاب category/subcategory (نه به amount یا date).
- reason یک جمله کوتاه فارسی است که دلیل انتخاب category/subcategory را توضیح می‌دهد.
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

interface AiCategoryResolution {
  category: string;
  confidence: number;
  needsConfirmation: boolean;
}

// Validates the AI's (category, subcategory) pair against the real
// hierarchy - category must be a top-level category, and subcategory (if
// given) must actually belong to it. A category/subcategory name that
// merely exists somewhere in the list isn't enough (e.g. AI must not pair
// a subcategory with the wrong parent). Falls back to just the top-level
// category if only the subcategory half is invalid.
function findValidatedLeafCategory(
  category: string,
  subcategory: string | null | undefined,
  type: CategoryType,
  categories: CategoryOption[]
): string | null {
  const categoryValid = categories.some((c) => c.name === category && c.type === type && !c.parentName);
  if (!categoryValid) return null;
  if (!subcategory) return category;

  const subcategoryValid = categories.some(
    (c) => c.name === subcategory && c.type === type && c.parentName === category
  );
  return subcategoryValid ? subcategory : category;
}

// Confidence gating per spec section 8 - only applies to the AI's own
// category decision (a merchant override bypasses this entirely, see
// callers). An invalid (category, subcategory) pair is treated as
// confidence 0 for the bucketing decision regardless of what number the
// AI reported, since a confidently-wrong hallucinated category is worse
// than an honestly uncertain one - but the raw reported confidence is
// still returned as-is, for observability.
//   >= 0.80          -> auto-assign, no confirmation needed
//   0.50 - 0.79      -> assign, but flag needsConfirmation
//   < 0.50 / invalid -> fall back to "سایر", flag needsConfirmation
function resolveAiCategory(parsed: RawParsedTransaction, type: CategoryType, categories: CategoryOption[]): AiCategoryResolution {
  const leafCategory = findValidatedLeafCategory(parsed.category, parsed.subcategory, type, categories);
  const rawConfidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;
  const effectiveConfidence = leafCategory ? rawConfidence : 0;

  if (effectiveConfidence >= 0.8) {
    return { category: leafCategory!, confidence: rawConfidence, needsConfirmation: false };
  }
  if (effectiveConfidence >= 0.5) {
    return { category: leafCategory!, confidence: rawConfidence, needsConfirmation: true };
  }
  return { category: "سایر", confidence: rawConfidence, needsConfirmation: true };
}

// The bank engine only resolves amount/type/date - it has no merchant name
// or category signal at all (SMS bodies carry a transaction label like
// "خرید"/"برداشت", never a merchant name), so category always lands on
// "سایر", the same generic bucket the AI path falls back to on low/invalid
// confidence, and needsConfirmation is always true so the user picks the
// real category on the preview screen.
function buildBankSmsResult(bankResult: BankSmsParseResult, rawInput: string): ParsedTransaction {
  return {
    amount: bankResult.amount,
    type: bankResult.type,
    category: "سایر",
    // rawInput is the raw multi-line SMS body; normalize it (collapses line
    // breaks/whitespace) before truncating so the preview description reads
    // as one line instead of a ragged mid-word cut.
    description: normalizeBankSmsText(rawInput).slice(0, 40),
    date: bankResult.date,
    source: "bank-sms",
    bank: bankResult.bank,
    bankConfidence: bankResult.bankConfidence,
    needsConfirmation: true,
  };
}

export async function parseTransactionWithAI(
  userId: number,
  rawInput: string,
  categories: CategoryOption[]
): Promise<ParsedTransaction> {
  // Bank SMS detection is fully deterministic and purpose-built for this
  // input shape, so it's tried first and, when it resolves, wins outright -
  // skipping both the merchant lookup and the AI call. parseBankSms is
  // all-or-nothing (bank + amount + type must all resolve or it returns
  // null), so a null result here covers "no bank detected" and "bank
  // detected but parsing incomplete" identically, falling through to the
  // exact same existing path below unchanged either way.
  const bankResult = parseBankSms(rawInput);
  if (bankResult) {
    const merchantMatch = await findMerchant(userId, rawInput);
    if (merchantMatch.source !== "none" && merchantMatch.type === bankResult.type) {
      const overrideCategory = resolveCategoryOverride(merchantMatch, merchantMatch.type, categories);
      if (overrideCategory) {
        return {
          ...buildBankSmsResult(bankResult, rawInput),
          category: overrideCategory,
          source: merchantMatch.source,
          needsConfirmation: false,
        };
      }
    }
    return buildBankSmsResult(bankResult, rawInput);
  }

  const merchantMatch = await findMerchant(userId, rawInput);

  // Fully deterministic path: a merchant match gives us category (and its
  // own type - no need to guess income/expense), and if amount/date also
  // extract confidently from the raw text, there's nothing left for the
  // AI to add. Skip the LLM call entirely.
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
        confidence: 1,
        needsConfirmation: false,
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
  const suggestedCategory = sanitizeNewCategorySuggestion(parsed.newCategorySuggestion);

  const base = {
    amount: Math.round(parsed.amount),
    type,
    description: parsed.description?.trim() || rawInput.slice(0, 40),
    date: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : new Date().toISOString().slice(0, 10),
  };

  // A merchant match still wins deterministically even when the AI ran
  // (e.g. it was only needed for amount/date) - confidence gating is only
  // for when the AI's own category guess is actually being used.
  if (overrideCategory) {
    return {
      ...base,
      category: overrideCategory,
      source: merchantMatch.source,
      confidence: 1,
      needsConfirmation: false,
    };
  }

  const aiResolution = resolveAiCategory(parsed, type, categories);
  let finalCategory = aiResolution.category;
  let finalNeedsConfirmation = aiResolution.needsConfirmation;
  let finalSuggestedCategory: SuggestedCategoryWithIcon | undefined;

  // newCategorySuggestion is only ever surfaced to the user once confirmed
  // it isn't just a different name for a category that already exists (see
  // findSimilarCategory) - a match wins deterministically over the AI's own
  // category guess above, the same treatment resolveCategoryOverride gets,
  // and still goes through the normal <select> via needsConfirmation rather
  // than silently overwriting the value the user never sees.
  if (suggestedCategory) {
    const matchedCategory = findSimilarCategory(suggestedCategory, categories, type);
    if (matchedCategory) {
      finalCategory = matchedCategory.name;
      finalNeedsConfirmation = true;
    } else {
      finalSuggestedCategory = {
        name: suggestedCategory.name,
        parentName: suggestedCategory.parentName,
        reason: suggestedCategory.reason,
        icon: resolveNewCategoryIcon(suggestedCategory.name),
      };
    }
  }

  return {
    ...base,
    category: finalCategory,
    source: "ai",
    confidence: aiResolution.confidence,
    needsConfirmation: finalNeedsConfirmation,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    suggestedCategory: finalSuggestedCategory,
  };
}
