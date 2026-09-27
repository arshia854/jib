/**
 * Throwaway latency/cost benchmark: DeepSeek-V4-Flash vs. GLM-5.3-Flash on
 * ArvanCloud AIaaS, for the specific call shape production actually makes
 * during transaction parsing (lib/ai/parse-transaction.ts's
 * parseTransactionWithAI).
 *
 * This is a standalone script. It does NOT modify lib/nvidia-ai.ts,
 * app/api/chat/route.ts, or any other production file, and it does NOT
 * touch the live Turso database - the only network call this makes is the
 * same ArvanCloud chat/completions HTTP call production already makes.
 *
 * Reuse, not reinvention:
 * - The HTTP client is the real, exported `chatCompletion()` from
 *   lib/nvidia-ai.ts - same base URL, auth header, retry/timeout behavior,
 *   and `onUsage` callback as every production caller. Not reimplemented
 *   here.
 * - The prompt is production's real transaction-parsing prompt: the system
 *   prompt is copied verbatim from lib/ai/parse-transaction.ts's
 *   buildSystemPrompt()/formatCategoryTree() (private, unexported functions
 *   - copying is the only option that doesn't touch that file) and built
 *   from prisma/default-categories.ts's DEFAULT_CATEGORIES (pure data, no
 *   I/O, same source production seeds real users' categories from) rather
 *   than a synthetic category list. The user message is a realistic sample
 *   Persian transaction description.
 *
 * Limitation found and NOT worked around (per this script's own brief):
 * parseTransactionWithAI calls `chatCompletion()`, which is NON-STREAMING
 * (no `stream: true`, no SSE handling) - only `streamChatCompletion()`
 * (used exclusively by app/api/chat/route.ts's free-form chat replies, a
 * different prompt entirely) streams, and it has no `onUsage` support at
 * all. So for the actual transaction-parsing call shape this benchmarks,
 * there is no first-chunk event to time - TTFB is not applicable and is
 * reported as such below, rather than substituted with a number from an
 * unrelated code path.
 *
 * Model selection: chatCompletion() always reads its model from
 * process.env.ARVAN_AI_MODEL via getModel() (fresh on every call, never
 * cached) - there is no per-call model parameter to plumb through. This
 * script benchmarks two models by setting that env var immediately before
 * each call, which exercises the exact same getModel() -> callNvidiaAI()
 * path production uses, just re-pointed per iteration.
 *
 * Usage:
 *   npx tsx scripts/benchmark-model-latency.ts
 *
 * Requires ARVAN_AI_API_KEY and ARVAN_AI_BASE_URL in .env (same as
 * production - loaded via `dotenv/config`, same pattern as other one-off
 * scripts in this repo, e.g. scripts/audit-mistyped-transactions.ts).
 *
 * Cost: this makes 10 real sequential API calls per model (20 total). Each
 * run has a real, non-zero cost against the ArvanCloud account - do not
 * run this without confirming the exact GLM-5.3-Flash model string from
 * the ArvanCloud panel's "مدل‌ها" tab first (see MODELS below).
 */
import "dotenv/config";
import { chatCompletion, type TokenUsage } from "@/lib/nvidia-ai";
import { DEFAULT_CATEGORIES } from "@/prisma/default-categories";

// ---------------------------------------------------------------------------
// Real category tree, from the same source production seeds from - not a
// synthetic/simplified list. Mirrors the shape parseTransactionWithAI's
// callers pass in (CategoryOption[] from lib/ai/parse-transaction.ts),
// rebuilt here since DEFAULT_CATEGORIES' own shape (nested `children`) isn't
// the flat (name, type, parentName) shape the prompt builder expects.
// ---------------------------------------------------------------------------
interface CategoryOption {
  name: string;
  type: "income" | "expense";
  parentName?: string;
}

const categories: CategoryOption[] = DEFAULT_CATEGORIES.flatMap((cat) => [
  { name: cat.name, type: cat.type },
  ...(cat.children ?? []).map((child) => ({ name: child.name, type: cat.type, parentName: cat.name })),
]);

// Copied verbatim from lib/ai/parse-transaction.ts (both are private,
// unexported functions there - this is a read-only script, so copying is
// the only way to reuse the real prompt without touching that file). Keep
// these two in sync with the source by hand if that file's prompt changes;
// this script is throwaway, not a long-lived duplicate to maintain.
function formatCategoryTree(cats: CategoryOption[], type: "income" | "expense"): string {
  return cats
    .filter((c) => c.type === type && !c.parentName)
    .map((top) => {
      const children = cats.filter((c) => c.type === type && c.parentName === top.name).map((c) => c.name);
      return children.length ? `${top.name}: ${children.join("، ")}` : top.name;
    })
    .join("\n");
}

function buildSystemPrompt(cats: CategoryOption[]): string {
  const expenseTree = formatCategoryTree(cats, "expense");
  const incomeTree = formatCategoryTree(cats, "income");
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
- «بیمه ماشین رو تمدید کردم» → category: «بیمه»، subcategory: «بیمه خودرو» (نه «حمل‌ونقل»، چون این پوشش بیمه‌ای است نه هزینه‌ی تعمیر یا سوخت خودرو)
- «غذای گربه خریدم» → category: «حیوان خانگی»، subcategory: «غذای حیوان خانگی» (نه «سوپرمارکت»، چون کالای خریداری‌شده مخصوص حیوان خانگی است، صرف‌نظر از محل خرید)
- «قسط وام رو پرداخت کردم» → category: «اقساط و بدهی»، subcategory: «قسط وام شخصی» (نه «قسط وام مسکن»، مگر اینکه متن صریحاً به «خانه»/«مسکن» اشاره کند)
- «ده گرم طلا خریدم برای پس‌انداز» → category: «پس‌انداز و سرمایه‌گذاری»، subcategory: «خرید طلا و ارز» (چون قصد نگهداری به‌عنوان سرمایه‌گذاری است، assetPurchase هم طبق قانون خودش جداگانه پر می‌شود؛ این با تعیین category تداخلی ندارد)
- «رفتم آرایشگاه» → category: «خدمات شخصی و زیبایی»، subcategory: «آرایشگاه و سالن زیبایی» (نه «تفریح و سرگرمی»، چون این یک خدمت شخصی/بهداشتی است نه سرگرمی)
- «ترمیم ناخن کردم» / «مانیکور کردم» → category: «خدمات شخصی و زیبایی»، subcategory: «آرایشگاه و سالن زیبایی» (نه «لوازم آرایشی و بهداشتی»، چون این یک خدمت است نه خرید لوازم آرایشی)
- «برای مامانم پول فرستادم» → category: «هدیه و خیریه»، subcategory: «کمک مالی به خانواده» (نه «هدیه تولد و مناسبت»، مگر اینکه متن یک مناسبت خاص مثل تولد را ذکر کند)

نمونه برای assetPurchase:
- «صد دلار خریدم برای سرمایه‌گذاری» → type: expense، assetPurchase: {"assetType": "usd", "quantity": 100, "tomanAmount": null}
- «ده گرم طلا خریدم» → type: expense، assetPurchase: {"assetType": "gold", "quantity": 10, "tomanAmount": null}
- «دو میلیون تومن دلار خریدم برای سرمایه‌گذاری» → type: expense، assetPurchase: {"assetType": "usd", "quantity": null, "tomanAmount": 2000000}
- «قسط ماشین رو با دلار حساب کردم» → assetPurchase: null (خرج‌کردن دلار برای پرداخت است، نه خرید و نگهداری دارایی)`;
}

// Realistic sample Persian transaction description - same shape/register as
// the example in buildSystemPrompt's own docstring and this task's brief.
const SAMPLE_INPUT = "50 تومن قهوه خریدم";

const SYSTEM_PROMPT = buildSystemPrompt(categories);

// ---------------------------------------------------------------------------
// Models under test. GLM-5.3-Flash's exact model string is to be confirmed
// against ArvanCloud's panel ("مدل‌ها" tab) before running - left as a
// placeholder-shaped constant so it's obvious to check/replace, not guessed.
// ---------------------------------------------------------------------------
const MODELS = ["Xerxes-1"] as const;

const RUNS_PER_MODEL = 10;

// Toman rates per token, from ArvanCloud AIaaS's panel pricing page as of
// this benchmark's writing (2026-09-12) - confirm against the panel before
// trusting the cost column for a decision, since provider pricing pages
// change without notice.

const COST_RATES: Record<(typeof MODELS)[number], { inputPerToken: number; outputPerToken: number }> = {
  "Xerxes-1": { inputPerToken: 0.02625, outputPerToken: 0.105 },
};
interface RunResult {
  totalLatencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values: number[]): { avg: number; min: number; max: number; p95: number } {
  if (values.length === 0) return { avg: NaN, min: NaN, max: NaN, p95: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { avg, min: sorted[0], max: sorted[sorted.length - 1], p95: percentile(sorted, 95) };
}

async function runOnce(model: string): Promise<RunResult> {
  // chatCompletion() reads its model from process.env.ARVAN_AI_MODEL fresh
  // on every call (getModel() in lib/nvidia-ai.ts) - no per-call override
  // exists, so this is how a throwaway script exercises two different
  // models through the one real client function without touching it.
  process.env.ARVAN_AI_MODEL = model;

  let usage: TokenUsage | undefined;
  const startedAt = Date.now();
  await chatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: SAMPLE_INPUT },
    ],
    { json: true, onUsage: (u) => { usage = u; } }
  );
  const totalLatencyMs = Date.now() - startedAt;

  return { totalLatencyMs, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens };
}

async function benchmarkModel(model: string): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (let i = 0; i < RUNS_PER_MODEL; i++) {
    try {
      const result = await runOnce(model);
      results.push(result);
      console.error(`  [${model}] run ${i + 1}/${RUNS_PER_MODEL}: ${result.totalLatencyMs}ms`);
    } catch (error) {
      console.error(`  [${model}] run ${i + 1}/${RUNS_PER_MODEL} FAILED: ${error instanceof Error ? error.message : error}`);
    }
    // Sequential by design (task requirement) - small gap between requests
    // to further avoid rate-limit noise skewing later runs in the sequence.
    await sleep(250);
  }
  return results;
}

function avgDefined(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => typeof v === "number");
  if (defined.length === 0) return undefined;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}

function fmt(n: number | undefined, digits = 0): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}

async function main() {
  console.error(
    "NOTE: TTFB is not applicable here - parseTransactionWithAI (lib/ai/parse-transaction.ts) calls " +
      "chatCompletion(), which is non-streaming (see lib/nvidia-ai.ts). Only streamChatCompletion() " +
      "(a different call site, app/api/chat/route.ts's free-form chat replies, different prompt, no " +
      "onUsage support) streams. Reporting total wall-clock latency only, per this call shape's real behavior.\n"
  );

  const rowsByModel = new Map<string, RunResult[]>();
  for (const model of MODELS) {
    console.error(`Benchmarking ${model}...`);
    const results = await benchmarkModel(model);
    rowsByModel.set(model, results);
  }

  const lines: string[] = [];
  lines.push("| Model | Avg latency (ms) | Min (ms) | Max (ms) | p95 (ms) | Avg input tok | Avg output tok | Avg cost/call (Toman) | Successful runs |");
  lines.push("|---|---|---|---|---|---|---|---|---|");

  for (const model of MODELS) {
    const results = rowsByModel.get(model) ?? [];
    const latencyStats = stats(results.map((r) => r.totalLatencyMs));
    const avgInputTokens = avgDefined(results.map((r) => r.promptTokens));
    const avgOutputTokens = avgDefined(results.map((r) => r.completionTokens));
    const rates = COST_RATES[model as (typeof MODELS)[number]];
    const avgCost =
      avgInputTokens !== undefined && avgOutputTokens !== undefined
        ? avgInputTokens * rates.inputPerToken + avgOutputTokens * rates.outputPerToken
        : undefined;

    lines.push(
      `| ${model} | ${fmt(latencyStats.avg)} | ${fmt(latencyStats.min)} | ${fmt(latencyStats.max)} | ${fmt(latencyStats.p95)} | ${fmt(avgInputTokens, 1)} | ${fmt(avgOutputTokens, 1)} | ${fmt(avgCost, 2)} | ${results.length}/${RUNS_PER_MODEL} |`
    );
  }

  lines.push("");
  lines.push("TTFB: N/A for both models - see note above (real transaction-parsing call path is non-streaming).");

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
