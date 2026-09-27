/**
 * One-off diagnostic: empirically test which request-body shape
 * ArvanCloud's gateway currently accepts for disabling DeepSeek-V4-Flash's
 * default "thinking" behavior. NOT production code - do not import this
 * from app code, no test coverage needed.
 *
 * lib/nvidia-ai.ts's chatCompletion()/streamChatCompletion() previously
 * sent `reasoning: { exclude: true }` / `thinking: { type: "disabled" }`,
 * both of which ArvanCloud started rejecting with 400 "Unrecognized
 * request argument supplied" (see that file's 2026-09-23 TEMPORARY
 * ROLLBACK comments) - this script tries other candidate shapes against
 * the real gateway so we know which (if any) is actually accepted before
 * touching lib/nvidia-ai.ts again.
 *
 * v2: the first run's trivial one-word-answer prompt with max_tokens=50
 * never triggered real thinking behavior in production either (baseline
 * came back in 6.5s / 2 completion_tokens, nowhere near the ~17-20s /
 * large-completion signature actually seen in production), so it couldn't
 * distinguish the candidates. This version uses detectTransactionIntent's
 * actual system prompt (buildSystemPrompt() in
 * lib/ai/detect-transaction-intent.ts - copied verbatim below since it's
 * not exported from that module) paired with a deliberately ambiguous
 * user message, at production's real max_tokens (JSON_EXTRACTION_MAX_TOKENS
 * in lib/nvidia-ai.ts - also copied verbatim below since it's a
 * module-private const), and runs each candidate 4x to get past
 * request-to-request noise. `reasoning_effort: "minimal"` is dropped -
 * already confirmed to hang/timeout in the first run.
 *
 * Usage:
 *   npx tsx scripts/probe-arvan-thinking.ts
 */
import "dotenv/config";

function getApiKey(): string {
  const key = process.env.ARVAN_AI_API_KEY;
  if (!key) throw new Error("ARVAN_AI_API_KEY تنظیم نشده است. آن را در فایل .env قرار دهید.");
  return key;
}

function getBaseUrl(): string {
  const url = process.env.ARVAN_AI_BASE_URL;
  if (!url) throw new Error("ARVAN_AI_BASE_URL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  return url.replace(/\/+$/, "");
}

function getModel(): string {
  const model = process.env.ARVAN_AI_MODEL;
  if (!model) throw new Error("ARVAN_AI_MODEL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  return model;
}

// Copied verbatim from buildSystemPrompt() in
// lib/ai/detect-transaction-intent.ts (not exported from that module, so
// can't be imported directly). Keep in sync if that prompt changes.
function buildSystemPrompt(): string {
  return `شما بخشی از دستیار مالی «جیب» هستید. فقط یک وظیفه دارید: تشخیص اینکه آیا آخرین پیام کاربر توصیف یک تراکنش مالی گذشته و هنوز ثبت‌نشده است (چیزی که کاربر می‌خواهد در جیب ثبت شود) یا نه. فقط یک شیء JSON با دقیقاً همین کلید برگردان، بدون هیچ متن یا توضیح اضافه و بدون markdown:

{"isPastUnloggedTransaction": boolean}

قوانین:
- فقط وقتی true بگذار که پیام صراحتاً یک خرج یا دریافت مشخص با مبلغ را توصیف می‌کند که قبلاً اتفاق افتاده و در جیب ثبت نشده (مثلاً «دیروز ۲۰۰ تومن آبمیوه خوردم یادم رفت ثبت کنم» یا «هفته پیش ۵۰۰ تومن برای تعمیر ماشین دادم، ننوشتمش»).
- اگر پیام صرفاً یک سؤال درباره‌ی وضعیت مالی، تحلیل، مقایسه، یا گفتگوی عمومی است (مثلاً «این ماه چقدر خرج کردم؟» یا «چطور بیشتر پس‌انداز کنم؟»)، false بگذار.
- اگر پیام مبهم است، مبلغ مشخصی ندارد، یا معلوم نیست تراکنش قبلاً ثبت نشده، false بگذار - چنین پیامی باید مثل گفتگوی عادی پاسخ داده شود.
- اگر کاربر توضیح می‌دهد که تراکنشی را همین الان (نه در گذشته) می‌خواهد اضافه کند از طریق فرم ثبت تراکنش، false بگذار - این تشخیص فقط برای تراکنش‌های گذشته و فراموش‌شده است.`;
}

const USER_MESSAGE = "دیروز یه چیزی خریدم ولی یادم نیست دقیقاً چقدر بود";

// Copied verbatim from JSON_EXTRACTION_MAX_TOKENS in lib/nvidia-ai.ts
// (module-private const, not exported). Keep in sync if that value changes.
const MAX_TOKENS = 1500;

const TIMEOUT_MS = 15_000;
const RUNS_PER_CANDIDATE = 4;

interface Candidate {
  label: string;
  extraBody: Record<string, unknown>;
}

// reasoning_effort: "minimal" dropped - confirmed non-viable (timed out
// every time) in the first run of this script.
const CANDIDATES: Candidate[] = [
  { label: "a. baseline (no thinking-control field)", extraBody: {} },
  { label: "b. chat_template_kwargs: { thinking: false }", extraBody: { chat_template_kwargs: { thinking: false } } },
  {
    label: "c. chat_template_kwargs: { enable_thinking: false }",
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
];

interface RunResult {
  ok: boolean;
  elapsedMs: number;
  note: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runOnce(candidate: Candidate, runIndex: number): Promise<RunResult> {
  const url = `${getBaseUrl()}/chat/completions`;
  const body = {
    model: getModel(),
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: USER_MESSAGE },
    ],
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    ...candidate.extraBody,
  };

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      TIMEOUT_MS
    );
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (error instanceof Error && error.name === "AbortError") {
      console.log(`  run ${runIndex + 1}: TIMEOUT after ${elapsedMs}ms (limit ${TIMEOUT_MS}ms)`);
      return { ok: false, elapsedMs, note: "timeout" };
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  run ${runIndex + 1}: FETCH ERROR after ${elapsedMs}ms - ${msg}`);
    return { ok: false, elapsedMs, note: `fetch error: ${msg}` };
  }
  const elapsedMs = Date.now() - started;

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    console.log(`  run ${runIndex + 1}: HTTP ${response.status} after ${elapsedMs}ms - ${text.slice(0, 300)}`);
    return { ok: false, elapsedMs, note: `HTTP ${response.status}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`  run ${runIndex + 1}: 200 after ${elapsedMs}ms, non-JSON body: ${text.slice(0, 300)}`);
    return { ok: true, elapsedMs, note: "non-JSON body" };
  }

  const usage = (json as Record<string, unknown>)?.usage;
  console.log(`  run ${runIndex + 1}: 200 after ${elapsedMs}ms, usage: ${usage ? JSON.stringify(usage) : "(none)"}`);
  return { ok: true, elapsedMs, note: usage ? JSON.stringify(usage) : "no usage block" };
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runCandidate(candidate: Candidate): Promise<void> {
  console.log(`\n--- ${candidate.label} ---`);
  const results: RunResult[] = [];
  for (let i = 0; i < RUNS_PER_CANDIDATE; i++) {
    results.push(await runOnce(candidate, i));
  }

  const times = results.map((r) => r.elapsedMs);
  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `  summary: ${okCount}/${RUNS_PER_CANDIDATE} ok - min ${Math.min(...times)}ms, max ${Math.max(...times)}ms, median ${median(times)}ms`
  );
}

async function main() {
  console.log(`Base URL: ${getBaseUrl()}`);
  console.log(`Model: ${getModel()}`);
  console.log(`System prompt: buildSystemPrompt() (detectTransactionIntent, copied verbatim)`);
  console.log(`User message: "${USER_MESSAGE}"`);
  console.log(`max_tokens: ${MAX_TOKENS}, timeout: ${TIMEOUT_MS}ms, runs per candidate: ${RUNS_PER_CANDIDATE}`);

  for (const candidate of CANDIDATES) {
    await runCandidate(candidate);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
