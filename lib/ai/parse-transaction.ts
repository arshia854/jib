import { chatCompletion, AI_PROVIDER, type TokenUsage } from "@/lib/nvidia-ai";
import {
  findSimilarCategory,
  resolveNewCategoryIcon,
  FALLBACK_EXPENSE_CATEGORY,
  FALLBACK_INCOME_CATEGORY,
  type CategoryType,
} from "@/lib/categories";
import { findMerchant, type MerchantLookupResult, type MerchantMatchSource } from "@/lib/merchant-lookup";
import { extractAmount } from "@/lib/extract-amount";
import { extractDate } from "@/lib/extract-date";
import { parseBankSms, type BankSmsParseResult } from "@/lib/bank/parse-bank-sms";
import { normalizeText as normalizeBankSmsText } from "@/lib/bank/normalize";
import type { Bank } from "@/lib/bank/types";
import { getLivePrices, LivePriceUnavailableError, type LivePrices } from "@/lib/prices/get-live-prices";
import type { LivePricedAssetType } from "@/lib/assets";
import { logger } from "@/lib/observability/logger";
import { getRequestId } from "@/lib/observability/request-context";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import {
  combineConfidence,
  extractionConfidenceForBankSms,
  categorizationConfidenceForMerchantMatch,
  EXTRACTION_CONFIDENCE_DETERMINISTIC,
  EXTRACTION_CONFIDENCE_AI,
  CATEGORIZATION_CONFIDENCE_NONE,
  type ConfidenceLevel,
} from "@/lib/ai/confidence";

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

// Populated only when the AI's own JSON response flagged this text as
// describing the purchase of a live-priced asset (gold/usd/bitcoin) to hold
// as an investment - see buildSystemPrompt's assetPurchase rules and
// resolveAssetPurchase below. quantity/purchasePricePerUnit are already
// resolved to real numbers (priced off the same live-price feed
// lib/data/assets.ts uses), never the AI's own raw guess - so this is
// ready to hand straight to POST /api/transactions' assetPurchase field
// (lib/data/transactions.ts's AssetPurchaseInput) to create a matching
// Asset row alongside the expense Transaction.
export interface AssetPurchaseSuggestion {
  type: LivePricedAssetType;
  quantity: number;
  purchasePricePerUnit: number;
}

export interface ParsedTransaction {
  amount: number;
  type: CategoryType;
  category: string;
  description: string;
  date: string;
  // Where `category` came from - a learned user mapping, the global
  // merchant list, a keyword override, the AI's own guess, or a
  // deterministically-parsed bank SMS (which always lands on
  // resolveFallbackCategory(type) - see buildBankSmsResult).
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
  // category (or the resolveFallbackCategory(type) fallback) regardless of
  // whether this is set. Only ever
  // populated alongside an actual AI call, and only once findSimilarCategory
  // has confirmed it doesn't already match an existing category (a match
  // instead overwrites category/subcategory above - see
  // parseTransactionWithAI).
  suggestedCategory?: SuggestedCategoryWithIcon;
  // Phase 8 (docs/roadmap-status.md) confidence model - see
  // lib/ai/confidence.ts for the full design rationale. Three separate,
  // named ("high" | "medium" | "low", never a number - no calibration data
  // exists) signals, always set together by every return branch of
  // parseTransactionWithAI:
  //   - extractionConfidence: how sure we are about amount/date themselves.
  //   - categorizationConfidence: how sure we are about `category` itself.
  //   - confidenceLevel: combineConfidence(extraction, categorization) -
  //     the weaker of the two, i.e. the overall signal.
  // Deliberately independent of `confidence`/`needsConfirmation` above,
  // which are unchanged and still the actual UI confirmation gate (see
  // that field's own comment and lib/ai/confidence.ts's top-of-file note
  // on why retrofitting needsConfirmation from these was rejected -
  // several already-shipped, already-tested "fast path, no confirmation
  // needed" flows resolve via a tier-2/3 merchant match, which this model
  // rates only "medium," and changing needsConfirmation to match would
  // have added a confirmation tap to those without a deliberate product
  // decision to do so). Optional only because
  // app/app/add/page.tsx's parseSuggestionParams() hand-reconstructs a
  // ParsedTransaction-shaped object from URL query params (the "ویرایش کن"
  // chat handoff) without these fields, the same reason `source`/
  // `confidence`/`needsConfirmation` are already optional - every actual
  // parseTransactionWithAI() return sets all three.
  extractionConfidence?: ConfidenceLevel;
  categorizationConfidence?: ConfidenceLevel;
  confidenceLevel?: ConfidenceLevel;
  // See AssetPurchaseSuggestion's own comment. Only ever set by a real AI
  // call (bank-sms/merchant-match fast paths never populate it - neither
  // has a signal for "this is an asset purchase" to begin with), and only
  // when a live price was actually available to resolve it against.
  assetSuggestion?: AssetPurchaseSuggestion;
}

export interface CategoryOption {
  name: string;
  type: CategoryType;
  // Name of the parent category, if this is a subcategory. Needed to
  // validate the AI's (category, subcategory) pair against the real
  // hierarchy, not just check each name exists somewhere.
  parentName?: string;
}

// Raw shape of the optional assetPurchase key in the AI's JSON response -
// see buildSystemPrompt's own rules for assetType/quantity/tomanAmount's
// exact meaning. Untrusted/unvalidated at this point (assetType could be
// any string, quantity/tomanAmount could be missing or the wrong type) -
// resolveAssetPurchase below is what actually validates and resolves it.
interface RawAssetPurchase {
  assetType?: string;
  quantity?: number | null;
  tomanAmount?: number | null;
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
  assetPurchase?: RawAssetPurchase | null;
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

{"amount": number, "type": "income" | "expense", "description": string, "date": "YYYY-MM-DD", "category": string, "subcategory": string | null, "confidence": number, "reason": string, "newCategorySuggestion": {"name": string, "parentName": string | null, "reason": string} | null, "assetPurchase": {"assetType": "gold" | "usd" | "bitcoin", "quantity": number | null, "tomanAmount": number | null} | null}

دسته‌های هزینه مجاز (به‌همراه زیردسته‌ها):
${expenseTree}

دسته‌های درآمد مجاز (به‌همراه زیردسته‌ها):
${incomeTree}

امروز (تقویم میلادی): ${today}

قوانین:
- amount همیشه عدد صحیح مثبت به تومان است.
- تبدیل واحد را فقط بر اساس این قوانین دقیق انجام بده، حدس آزاد نزن:
  عددی که نه "هزار"/"میلیون" و نه "ریال" همراهش نیامده - چه کاملاً بدون واحد باشد، چه فقط با "تومان"/"تومن" صریح همراه باشد - و بین ۱ تا ۹٬۹۹۹ باشد → عدد×۱۰۰۰ (مثلاً «۵۰» یا «۵۰ تومن» یعنی ۵۰ هزار تومان، «۱۳۰۰» یا «۱۳۰۰ تومن» یعنی ۱ میلیون و ۳۰۰ هزار تومان)؛ همان حالت با عدد ۱۰٬۰۰۰ یا بیشتر → همان عدد بدون تغییر (مثلاً «۵۰۰۰۰ تومن» یعنی همان ۵۰ هزار تومان، نه بیشتر - هرگز آن را دوباره در ۱۰۰۰ ضرب نکن)؛ الگوی "X و Y" یا "X.Y" با هر دو بخش بین ۱ تا ۹۹۹ → (X×۱۰۰۰۰۰۰)+(Y×۱۰۰۰) (مثلاً «۱ و ۱۰۰» یعنی ۱ میلیون و ۱۰۰ هزار تومان)؛ "هزار تومان/تومن" → عدد×۱۰۰۰؛ "میلیون تومان/تومن" → عدد×۱۰۰۰۰۰۰؛ "ریال" → عدد÷۱۰.
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
- date را به‌صورت YYYY-MM-DD میلادی برگردان. اگر تاریخ خاصی گفته نشده امروز را برگردان. "دیروز"/"پریروز" را نسبت به امروز محاسبه کن. "هفته پیش" یعنی دقیقاً ۷ روز قبل از امروز.
- assetPurchase فقط برای وقتی است که کاربر واقعاً در حال خرید و نگهداری یک دارایی (طلا، دلار، یا بیت‌کوین) به‌عنوان سرمایه‌گذاری/پس‌انداز است - نه خرج‌کردن دلار برای پرداخت چیزی، نه فروش دارایی، نه دریافت هدیه بدون خرید. در هر حالت دیگر assetPurchase را null بگذار.
  assetType باید دقیقاً یکی از "gold" | "usd" | "bitcoin" باشد (فقط همین سه نوع).
  اگر کاربر مقدار را در واحد طبیعی خود دارایی گفته (تعداد دلار برای دلار، گرم برای طلا، تعداد بیت‌کوین برای بیت‌کوین)، همان عدد را عیناً (بدون اعمال قوانین تبدیل واحد تومان بالا) در quantity بگذار و tomanAmount را null کن.
  اگر کاربر مبلغ خرید را به تومان گفته (نه واحد طبیعی دارایی)، آن مبلغ را طبق همان قوانین تبدیل واحد بالا در tomanAmount بگذار و quantity را null کن.
  وقتی assetPurchase پر می‌شود، amount را طبق بهترین حدس خودت بگذار - این عدد به‌صورت خودکار با قیمت لحظه‌ای واقعی جایگزین می‌شود، فقط باید عددی مثبت باشد.

نمونه برای دسته‌های مشابه که ممکن است اشتباه گرفته شوند:
- «نون و ماست خریدم» → category: «خوراک و رستوران»، subcategory: «سوپرمارکت» (نه «رستوران و کافه»، چون خرید برای خانه است نه صرف بیرون از خانه)
- «با دوستام قهوه خوردیم» → category: «خوراک و رستوران»، subcategory: «رستوران و کافه»
- «اسنپ گرفتم برم فرودگاه» → category: «حمل‌ونقل»، subcategory: «تاکسی و اسنپ» (نه «بنزین»، چون اسنپ سرویس تاکسی است نه خرید مستقیم سوخت)
- «قبض اینترنت خونه رو پرداخت کردم» → category: «قبوض و اشتراک»، subcategory: «اینترنت و تلفن» (نه «برق، آب و گاز»، با اینکه هر دو «قبض» هستند)
- «رفتم دکتر و ویزیت دادم» → category: «سلامت»، subcategory: «ویزیت پزشک» (نه «دارو»، چون هزینه ویزیت است نه خرید دارو)
- «حقوق این ماه ریخت» → category: «حقوق» | «بابت یه پروژه فریلنس پول گرفتم» → category: «درآمد آزاد»

نمونه برای assetPurchase:
- «صد دلار خریدم برای سرمایه‌گذاری» → type: expense، assetPurchase: {"assetType": "usd", "quantity": 100, "tomanAmount": null}
- «ده گرم طلا خریدم» → type: expense، assetPurchase: {"assetType": "gold", "quantity": 10, "tomanAmount": null}
- «دو میلیون تومن دلار خریدم برای سرمایه‌گذاری» → type: expense، assetPurchase: {"assetType": "usd", "quantity": null, "tomanAmount": 2000000}
- «قسط ماشین رو با دلار حساب کردم» → assetPurchase: null (خرج‌کردن دلار برای پرداخت است، نه خرید و نگهداری دارایی)`;
}

// Exported for reuse by lib/ai/detect-transaction-intent.ts, which needs
// the exact same "strip a ```json fence if the model added one anyway"
// tolerance for its own json-mode call - duplicating this would just be
// two copies of the same fence-stripping regex to keep in sync.
export function extractJson(text: string): unknown {
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

// Re-exported so existing imports of these two from this module (tests,
// mainly) keep working unchanged - the actual values now live in
// lib/categories.ts (see the comment there for why: lib/merchants.ts needs
// them too, and importing them from here directly would create a circular
// import that crashes at runtime). resolveFallbackCategory and
// warnIfFallbackCategoryMissing below still just reference these two
// constants, so nothing else about this file's behavior changes.
export { FALLBACK_EXPENSE_CATEGORY, FALLBACK_INCOME_CATEGORY };

function resolveFallbackCategory(type: CategoryType): string {
  return type === "income" ? FALLBACK_INCOME_CATEGORY : FALLBACK_EXPENSE_CATEGORY;
}

// Dev-only guard against the exact class of bug FALLBACK_EXPENSE_CATEGORY/
// FALLBACK_INCOME_CATEGORY above were introduced to fix: if prisma/seed.ts
// ever renames either seeded category without this file catching up, a
// transaction landing on the fallback would silently fail
// createTransaction's exact-name lookup (InvalidCategoryError) instead of
// saving. This can't prevent that, but it makes the drift loud in dev/test
// logs the moment a real categories list stops containing the expected
// name, instead of surfacing only much later as a confusing save error. No
// behavior change in production.
function warnIfFallbackCategoryMissing(name: string, type: CategoryType, categories: CategoryOption[]): void {
  if (process.env.NODE_ENV === "production") return;
  const exists = categories.some((c) => c.name === name && c.type === type && !c.parentName);
  if (!exists) {
    console.error(
      `[parse-transaction] fallback category "${name}" (type: ${type}) not found in the provided categories list - check it still matches the seeded DefaultCategory name in prisma/seed.ts.`
    );
  }
}

interface AiCategoryResolution {
  category: string;
  confidence: number;
  needsConfirmation: boolean;
  // Phase 8: the same three-way bucket needsConfirmation already gates on
  // below, just also exposed as a named level instead of staying an
  // internal-only threshold check - see lib/ai/confidence.ts.
  categorizationConfidence: ConfidenceLevel;
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

// Phase 9.2 - the previous check here was `!Number.isNaN(Date.parse(parsed.date))`,
// which only confirms V8's Date.parse() can make *something* of the
// string - it doesn't confirm the AI actually followed the prompt's own
// "YYYY-MM-DD" instruction. Date.parse()'s non-ISO fallback parsing is
// notoriously lenient/implementation-specific (e.g. it can silently roll
// an out-of-range day/month into a different date rather than rejecting
// it), which matters here specifically because `date` determines which
// calendar month a transaction lands in for every monthly report/summary
// downstream - a loosely-parsed date is a real data-integrity risk, not
// just a cosmetic one. This checks the exact shape the prompt asks for
// and that the numbers form a real calendar date (a naive regex alone
// would still accept "2024-02-30").
function isValidIsoDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const LIVE_PRICED_ASSET_TYPES: readonly LivePricedAssetType[] = ["gold", "usd", "bitcoin"];

function isLivePricedAssetPurchaseType(value: unknown): value is LivePricedAssetType {
  return typeof value === "string" && (LIVE_PRICED_ASSET_TYPES as readonly string[]).includes(value);
}

function livePriceForAssetPurchase(type: LivePricedAssetType, prices: LivePrices): number {
  switch (type) {
    case "gold":
      return prices.goldGramPricePerUnit;
    case "usd":
      return prices.usdPricePerUnit;
    case "bitcoin":
      return prices.bitcoinPricePerUnit;
  }
}

interface AssetPurchaseResolution {
  assetSuggestion?: AssetPurchaseSuggestion;
  // The real Toman cost of the purchase, once resolved against a live
  // price - overrides whatever placeholder the AI put in `amount` (see
  // buildSystemPrompt's own note that amount is just a best-effort guess
  // when assetPurchase is set). Undefined whenever assetSuggestion is,
  // so callers can use one check (`assetSuggestion ?`) for both.
  tomanAmountOverride?: number;
}

// Resolves the AI's raw assetPurchase signal (a native-unit quantity OR a
// Toman amount - never both, see buildSystemPrompt's own rules) into a
// concrete (quantity, purchasePricePerUnit) pair, priced off the same
// live-price feed the Assets page itself uses (lib/prices/get-live-prices.ts
// - the same module lib/data/assets.ts's listAssetsWithValue() calls). This
// is what keeps "خریدم صد دلار برای سرمایه‌گذاری" from being run through
// this file's Toman-only unit-conversion هزار/میلیون heuristics (which
// would otherwise turn a literal 100-dollar quantity into a bogus Toman
// figure) and means the AI never needs to know today's actual market price.
//
// Returns {} (no asset signal at all) for anything malformed, ambiguous, or
// when live prices simply aren't available right now - every caller treats
// that identically to "this wasn't an asset purchase," so a live-price
// hiccup degrades to an ordinary logged transaction rather than blocking
// the save or throwing.
async function resolveAssetPurchase(
  userId: number,
  raw: RawAssetPurchase | null | undefined
): Promise<AssetPurchaseResolution> {
  if (!raw || typeof raw !== "object" || !isLivePricedAssetPurchaseType(raw.assetType)) return {};

  const quantity =
    typeof raw.quantity === "number" && Number.isFinite(raw.quantity) && raw.quantity > 0 ? raw.quantity : null;
  const tomanAmount =
    typeof raw.tomanAmount === "number" && Number.isFinite(raw.tomanAmount) && raw.tomanAmount > 0
      ? raw.tomanAmount
      : null;
  if (quantity === null && tomanAmount === null) return {};

  let prices: LivePrices;
  try {
    prices = await getLivePrices();
  } catch (error) {
    // Best-effort, same spirit as detectTransactionIntent's own "fail safe,
    // never block the normal chat/transaction flow" fallback - a live-price
    // outage (or a genuinely unexpected error) must not turn an otherwise
    // fine transaction save into a hard failure just because the text
    // happened to look like an asset purchase. Only report the unexpected
    // case; LivePriceUnavailableError itself is the documented,
    // already-handled "no fetch has ever succeeded" outcome.
    if (!(error instanceof LivePriceUnavailableError)) {
      reportError({
        errorType: ERROR_TYPES.API_ERROR,
        route: "ai/parse-transaction",
        userId,
        message: error instanceof Error ? error.message : "Unexpected error fetching live prices for asset purchase",
        error,
        context: { operation: "resolveAssetPurchase" },
      });
    }
    return {};
  }

  const purchasePricePerUnit = livePriceForAssetPurchase(raw.assetType, prices);
  if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0) return {};

  const resolvedQuantity = quantity ?? tomanAmount! / purchasePricePerUnit;
  const resolvedTomanAmount = tomanAmount !== null ? Math.round(tomanAmount) : Math.round(quantity! * purchasePricePerUnit);

  return {
    assetSuggestion: { type: raw.assetType, quantity: resolvedQuantity, purchasePricePerUnit },
    tomanAmountOverride: resolvedTomanAmount,
  };
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
//   < 0.50 / invalid -> fall back to resolveFallbackCategory(type), flag needsConfirmation
function resolveAiCategory(parsed: RawParsedTransaction, type: CategoryType, categories: CategoryOption[]): AiCategoryResolution {
  const leafCategory = findValidatedLeafCategory(parsed.category, parsed.subcategory, type, categories);
  const rawConfidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;
  const effectiveConfidence = leafCategory ? rawConfidence : 0;

  if (effectiveConfidence >= 0.8) {
    return { category: leafCategory!, confidence: rawConfidence, needsConfirmation: false, categorizationConfidence: "high" };
  }
  if (effectiveConfidence >= 0.5) {
    return { category: leafCategory!, confidence: rawConfidence, needsConfirmation: true, categorizationConfidence: "medium" };
  }
  const fallback = resolveFallbackCategory(type);
  warnIfFallbackCategoryMissing(fallback, type, categories);
  return { category: fallback, confidence: rawConfidence, needsConfirmation: true, categorizationConfidence: "low" };
}

// The bank engine only resolves amount/type/date - it has no merchant name
// or category signal at all (SMS bodies carry a transaction label like
// "خرید"/"برداشت", never a merchant name), so category always lands on
// resolveFallbackCategory(bankResult.type), the same generic bucket the AI
// path falls back to on low/invalid confidence, and needsConfirmation is
// always true so the user picks the real category on the preview screen.
function buildBankSmsResult(bankResult: BankSmsParseResult, rawInput: string, categories: CategoryOption[]): ParsedTransaction {
  const fallback = resolveFallbackCategory(bankResult.type);
  warnIfFallbackCategoryMissing(fallback, bankResult.type, categories);
  const extractionConfidence = extractionConfidenceForBankSms(bankResult.bankConfidence);
  const categorizationConfidence = CATEGORIZATION_CONFIDENCE_NONE;
  return {
    amount: bankResult.amount,
    type: bankResult.type,
    category: fallback,
    // rawInput is the raw multi-line SMS body; normalize it (collapses line
    // breaks/whitespace) before truncating so the preview description reads
    // as one line instead of a ragged mid-word cut.
    description: normalizeBankSmsText(rawInput).slice(0, 40),
    date: bankResult.date,
    source: "bank-sms",
    bank: bankResult.bank,
    bankConfidence: bankResult.bankConfidence,
    needsConfirmation: true,
    extractionConfidence,
    categorizationConfidence,
    confidenceLevel: combineConfidence(extractionConfidence, categorizationConfidence),
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
        // A real merchant category signal now exists (unlike the plain
        // bank-SMS case, which has none at all - see buildBankSmsResult's
        // own comment) - categorizationConfidence is recomputed from the
        // merchant match itself rather than inherited from the "low"
        // buildBankSmsResult sets by default. extractionConfidence is
        // unaffected by which category won, so it's unchanged.
        const extractionConfidence = extractionConfidenceForBankSms(bankResult.bankConfidence);
        const categorizationConfidence = categorizationConfidenceForMerchantMatch(
          merchantMatch.source,
          merchantMatch.matchTier
        );
        return {
          ...buildBankSmsResult(bankResult, rawInput, categories),
          category: overrideCategory,
          source: merchantMatch.source,
          needsConfirmation: false,
          extractionConfidence,
          categorizationConfidence,
          confidenceLevel: combineConfidence(extractionConfidence, categorizationConfidence),
        };
      }
    }
    return buildBankSmsResult(bankResult, rawInput, categories);
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
      const categorizationConfidence = categorizationConfidenceForMerchantMatch(
        merchantMatch.source,
        merchantMatch.matchTier
      );
      return {
        amount,
        type: merchantMatch.type,
        category: overrideCategory,
        description: merchantMatch.merchantName ?? rawInput.slice(0, 40),
        date,
        source: merchantMatch.source,
        confidence: 1,
        needsConfirmation: false,
        extractionConfidence: EXTRACTION_CONFIDENCE_DETERMINISTIC,
        categorizationConfidence,
        confidenceLevel: combineConfidence(EXTRACTION_CONFIDENCE_DETERMINISTIC, categorizationConfidence),
      };
    }
  }

  // Reached only past both deterministic fast paths above (bank-SMS,
  // confident merchant match) - this is a real NVIDIA NIM call, so it's
  // the only place in this function that should ever emit an AI-latency
  // log event (Phase 12.4.3: fast-path transactions must not).
  const aiCallStartedAt = Date.now();
  let content: string;
  let usage: TokenUsage | undefined;
  try {
    content = await chatCompletion(
      [
        { role: "system", content: buildSystemPrompt(categories) },
        { role: "user", content: rawInput },
      ],
      { json: true, onUsage: (u) => { usage = u; } }
    );
    logger.info(
      {
        requestId: getRequestId(),
        route: "ai/parse-transaction",
        userId,
        duration: Date.now() - aiCallStartedAt,
        provider: AI_PROVIDER,
        // Phase 9.4 - undefined (dropped by pino, never logged as a
        // literal "usage":null) when the response didn't carry a usage
        // object - see chatCompletion's own onUsage doc comment.
        usage,
      },
      "AI call succeeded"
    );
  } catch (error) {
    // Sanitized params only - rawInput is the user's pasted bank-SMS/typed
    // financial text, never logged/reported verbatim (Phase 12.4.1).
    reportError({
      errorType: ERROR_TYPES.AI_ERROR,
      route: "ai/parse-transaction",
      userId,
      duration: Date.now() - aiCallStartedAt,
      message: error instanceof Error ? error.message : "AI call failed",
      error,
      context: { provider: AI_PROVIDER, rawInputLength: rawInput.length, categoryCount: categories.length },
    });
    // Re-thrown unchanged - this function has no existing fallback around
    // this call (parseTransactionWithAI's two callers, transactions/parse's
    // route handler and chat's trySuggestTransaction, already handle a
    // thrown error exactly as before this sub-task).
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch (extractError) {
    // Sanitized input only - `content` is the AI's own response text,
    // which can echo fragments of the user's financial text back (e.g. in
    // a `description` field) - logged as shape (length), not verbatim.
    // No parser-version field: this codebase has no such concept anywhere
    // (checked), so none is invented here per the Phase 12 spec.
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "ai/parse-transaction",
      userId,
      message: extractError instanceof Error ? extractError.message : "Failed to extract JSON from AI response",
      error: extractError,
      context: { contentLength: content.length },
    });
    throw new Error("متوجه متن تراکنش نشدم. لطفاً واضح‌تر بنویسید.");
  }

  if (!isRawParsedTransaction(parsed) || parsed.amount <= 0) {
    const validationError = new Error("AI response failed transaction-shape validation");
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "ai/parse-transaction",
      userId,
      message: validationError.message,
      error: validationError,
      context: { contentLength: content.length },
    });
    throw new Error("پاسخ هوش مصنوعی ساختار نامعتبری داشت. دوباره تلاش کنید.");
  }

  const assetResolution = await resolveAssetPurchase(userId, parsed.assetPurchase);
  // Buying an asset is always cash going out, regardless of what the AI put
  // in `type` (the prompt's own default is already "expense" when unclear,
  // so this only ever overrides a stray/wrong "income" guess) - the whole
  // downstream flow (trySuggestTransaction's expense-only gate, the account
  // balance the matching Transaction row affects) assumes expense.
  const type = (assetResolution.assetSuggestion ? "expense" : parsed.type) as CategoryType;
  const overrideCategory = resolveCategoryOverride(merchantMatch, type, categories);
  const suggestedCategory = sanitizeNewCategorySuggestion(parsed.newCategorySuggestion);

  const base = {
    // tomanAmountOverride (the real, live-priced cost) always wins over the
    // AI's own `amount` guess once an asset purchase resolves - see
    // buildSystemPrompt's note that amount is a mere placeholder in that
    // case and AssetPurchaseResolution's own comment.
    amount: assetResolution.tomanAmountOverride ?? Math.round(parsed.amount),
    type,
    description: parsed.description?.trim() || rawInput.slice(0, 40),
    date:
      typeof parsed.date === "string" && isValidIsoDateString(parsed.date)
        ? parsed.date
        : new Date().toISOString().slice(0, 10),
    ...(assetResolution.assetSuggestion ? { assetSuggestion: assetResolution.assetSuggestion } : {}),
  };

  // A merchant match still wins deterministically even when the AI ran
  // (e.g. it was only needed for amount/date) - confidence gating is only
  // for when the AI's own category guess is actually being used.
  if (overrideCategory) {
    // resolveCategoryOverride only ever returns non-null past its own
    // `match.source === "none"` check, so merchantMatch.source is
    // guaranteed to be a real merchant source here even though TS can't
    // narrow that through the truthiness of `overrideCategory` alone.
    const categorizationConfidence = categorizationConfidenceForMerchantMatch(
      merchantMatch.source as "userMapping" | "globalMerchant" | "keyword",
      merchantMatch.matchTier
    );
    return {
      ...base,
      category: overrideCategory,
      source: merchantMatch.source,
      confidence: 1,
      needsConfirmation: false,
      // amount/date came from the AI's own JSON here (this branch is only
      // reachable past the real chatCompletion() call), not a regex - see
      // EXTRACTION_CONFIDENCE_AI's own comment.
      extractionConfidence: EXTRACTION_CONFIDENCE_AI,
      categorizationConfidence,
      confidenceLevel: combineConfidence(EXTRACTION_CONFIDENCE_AI, categorizationConfidence),
    };
  }

  const aiResolution = resolveAiCategory(parsed, type, categories);
  let finalCategory = aiResolution.category;
  let finalNeedsConfirmation = aiResolution.needsConfirmation;
  let finalCategorizationConfidence = aiResolution.categorizationConfidence;
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
      // The category actually shown is now a name-similarity match to an
      // existing category, not literally the AI's own high-confidence
      // pick anymore (even if aiResolution.categorizationConfidence was
      // "high") - "medium" honestly reflects that, and matches
      // finalNeedsConfirmation being forced true right above regardless.
      finalCategorizationConfidence = "medium";
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
    extractionConfidence: EXTRACTION_CONFIDENCE_AI,
    categorizationConfidence: finalCategorizationConfidence,
    confidenceLevel: combineConfidence(EXTRACTION_CONFIDENCE_AI, finalCategorizationConfidence),
  };
}
