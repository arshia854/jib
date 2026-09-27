// Provider name attached to AI-call log lines/Sentry reports by every
// caller of chatCompletion()/streamChatCompletion() (Phase 12.4) - shared
// here rather than each call site hardcoding its own copy, so it can't
// drift if this ever needs to change (e.g. .env.example already keeps
// NVIDIA/OpenRouter around "in case we switch back").
export const AI_PROVIDER = "arvan";

function getApiKey(): string {
  const key = process.env.ARVAN_AI_API_KEY;
  if (!key) {
    throw new Error("ARVAN_AI_API_KEY تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return key;
}

function getBaseUrl(): string {
  const url = process.env.ARVAN_AI_BASE_URL;
  if (!url) {
    throw new Error("ARVAN_AI_BASE_URL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return url.replace(/\/+$/, "");
}

function getModel(): string {
  const model = process.env.ARVAN_AI_MODEL;
  if (!model) {
    throw new Error("ARVAN_AI_MODEL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return model;
}

// Output-side cost/abuse cap (SEC-6) - ArvanCloud's chat/completions
// endpoint is OpenAI-compatible and, per NIM's own quickstart/model-card
// curl examples (build on vLLM's OpenAI-compatible server), takes this as
// `max_tokens`; `max_completion_tokens` is an OpenAI-specific alias for
// their newer reasoning-model line that NIM/vLLM doesn't use. Two different
// values below, not one shared number, because the two call sites' expected
// output shapes genuinely differ:
//
// - chatCompletion() is only ever asked for compact structured JSON - the
//   full transaction-extraction schema (amount/type/description/date/
//   category/subcategory/confidence/reason/newCategorySuggestion, see
//   lib/ai/parse-transaction.ts's buildSystemPrompt) with every field
//   individually short (description capped at ~5 words by the prompt
//   itself, category/subcategory are single existing category names,
//   reason is "one short sentence"), or detect-transaction-intent.ts's
//   much tinier {"isPastUnloggedTransaction": boolean}. 500 is well above
//   any legitimate response in either shape, while still actually bounding
//   a pathological/runaway completion.
// - streamChatCompletion() produces a free-form Persian conversational
//   reply (app/api/chat/route.ts's system prompt explicitly asks for
//   "دوستانه، مختصر و کاربردی" - friendly, concise, practical - but prose
//   naturally still runs longer than a JSON object with 5-word fields).
//   1000 leaves comfortable room for a multi-sentence answer (including a
//   short spending breakdown) without leaving the cap so high it stops
//   meaningfully bounding a single reply's cost.
const JSON_EXTRACTION_MAX_TOKENS = 1500;
const CHAT_REPLY_MAX_TOKENS = 2500;

// Phase 9.1/9.3 gateway timeout - callNvidiaAI() previously had no
// AbortController/signal at all, so a stalled provider connection (network
// stall, provider-side hang) would leave the request pending indefinitely,
// with no bound on it beyond whatever timeout Next.js's own hosting
// platform enforces at the function level (not something this module can
// rely on for a responsive UX). This is the *default* for every caller
// (chatCompletion/streamChatCompletion): for streamChatCompletion, fetch()'s
// promise resolves once the response headers/first SSE bytes arrive (well
// before the full generation completes), so this bounds time-to-first-byte,
// not the whole stream; for chatCompletion's non-streaming call, the
// provider typically doesn't send the response until the full completion is
// ready, so this bounds the whole generation. 30s was sized as generous
// headroom against JSON_EXTRACTION_MAX_TOKENS/CHAT_REPLY_MAX_TOKENS's
// *original* (smaller) values.
//
// It is now overridable per call via chatCompletion's `timeoutMs` option -
// same reason maxTokens became overridable (see JSON_EXTRACTION_MAX_TOKENS's
// own comment): lib/goals/strategy.ts's generateGoalStrategy raised its own
// output budget from 1500 to 3000 tokens to fix the "استراتژی ساخته نشد"
// truncation bug, but that call is non-streaming, so a bigger completion
// also means fetch() itself takes longer to resolve - this shared 30s
// default was never reconsidered for that, and production then hit it
// directly (AI_ERROR logs with duration: 30002 - the exact timeout value -
// for goals/strategy). Left unchanged here as the default for every other
// caller (transaction parsing, intent detection, chat), which don't need
// more room and shouldn't fail slower just because one caller's completions
// got bigger - see GOAL_STRATEGY_TIMEOUT_MS in lib/goals/strategy.ts for the
// dedicated override.
export const NVIDIA_REQUEST_TIMEOUT_MS = 30_000;

// Phase 9.1 retry policy - deliberately narrow. Only a *connection-level*
// failure (fetch() itself rejecting - DNS failure, connection refused, TLS
// handshake failure; surfaces as a TypeError, see isConnectionLevelFailure)
// is retried, and only once. Explicitly NOT retried: an HTTP-level error
// response (4xx/5xx - the request reached the server and was processed
// some way, so blindly retrying risks double-billing/duplicating a
// partially-succeeded completion, the same risk this task's own guidance
// warns against for a POST), and our own timeout abort (AbortError - the
// provider may already be mid-generation when that fires, so it carries
// the same "maybe already partially succeeded server-side" risk as a 5xx,
// even though it never got as far as returning a response).
const CONNECTION_RETRY_ATTEMPTS = 1;

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageInput {
  role: ChatRole;
  content: string;
}

// ArvanCloud's OpenAI-compatible chat/completions response includes a
// standard `usage` object (prompt_tokens/completion_tokens/total_tokens) on
// every non-streaming response - part of the OpenAI schema itself, not
// something specific to this model. Re-cased to camelCase for consistency
// with the rest of this codebase's naming convention.
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

function isConnectionLevelFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

function wrapFetchError(error: unknown, timeoutMs: number): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error(`درخواست به آروان کلاد به دلیل کندی پاسخ لغو شد (بیش از ${timeoutMs / 1000} ثانیه).`);
  }
  return new Error(`ارتباط با آروان کلاد برقرار نشد: ${error instanceof Error ? error.message : String(error)}`);
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

// timeoutMs defaults to NVIDIA_REQUEST_TIMEOUT_MS - only lib/goals/strategy.ts
// currently passes its own (larger) value through chatCompletion's
// `timeoutMs` option; see that constant's own comment for why.
async function callNvidiaAI(body: Record<string, unknown>, timeoutMs: number = NVIDIA_REQUEST_TIMEOUT_MS): Promise<Response> {
  const url = `${getBaseUrl()}/chat/completions`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: getModel(), ...body }),
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (firstError) {
    if (!isConnectionLevelFailure(firstError) || CONNECTION_RETRY_ATTEMPTS < 1) {
      throw wrapFetchError(firstError, timeoutMs);
    }
    try {
      response = await fetchWithTimeout(url, init, timeoutMs);
    } catch (secondError) {
      throw wrapFetchError(secondError, timeoutMs);
    }
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`درخواست به آروان کلاد ناموفق بود (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response;
}

// Why generation stopped ("stop", or "length" when it ran into max_tokens)
// and how much hidden reasoning text came back alongside the answer, if
// any. A json:true call that hits "length" returns cut-off JSON; if most of
// its completion_tokens went to reasoning rather than `content`, the
// thinking phase wasn't actually disabled for that request.
export interface ResponseMeta {
  finishReason?: string;
  reasoningChars?: number;
}

export async function chatCompletion(
  messages: ChatMessageInput[],
  options?: {
    json?: boolean;
    onUsage?: (usage: TokenUsage) => void;
    onResponseMeta?: (meta: ResponseMeta) => void;
    maxTokens?: number;
    timeoutMs?: number;
  }
): Promise<string> {
  const response = await callNvidiaAI(
    {
      messages,
      // Overridable per call (see GOAL_STRATEGY_JSON_MAX_TOKENS in
      // lib/goals/strategy.ts) - JSON_EXTRACTION_MAX_TOKENS alone was sized
      // for the two small schemas listed in its own comment above
      // (single-transaction parse, one-boolean intent-detection) and was too
      // tight for generateGoalStrategy's much larger 3-5 action + summary +
      // monthlyAction + inflationNote schema, causing the model's JSON to be
      // cut off mid-object and fail JSON.parse in extractJson() - the actual
      // cause behind goal-strategy generation intermittently failing with
      // "استراتژی ساخته نشد" in production. Left as the default for every
      // other caller, which don't need more room.
      max_tokens: options?.maxTokens ?? JSON_EXTRACTION_MAX_TOKENS,
      // Disables DeepSeek-V4-Flash's default thinking phase. ArvanCloud's
      // gateway rejects top-level `reasoning: { exclude: true }` and
      // `thinking: { type: "disabled" }` with 400 "Unrecognized request
      // argument supplied" (as of 2026-09-23), but accepts vLLM's standard
      // `chat_template_kwargs.thinking` passthrough. Measured with
      // scripts/probe-arvan-thinking.ts against detectTransactionIntent's
      // real prompt: 4/4 accepted, median ~3.4s vs ~7.0s with no field.
      // Re-run that script if the gateway's accepted parameters change again.
      // Caveat (2026-09-27): accepted, but it does NOT reliably stop the
      // reasoning phase. On goal-strategy's prompt every probed call, with
      // this field, with `enable_thinking: false`, or with neither, still
      // returned reasoning_content and 1671-3000 reasoning_tokens. Size
      // maxTokens for reasoning plus the answer (see
      // GOAL_STRATEGY_JSON_MAX_TOKENS in lib/goals/strategy.ts).
      chat_template_kwargs: { thinking: false },
      ...(options?.json ? { response_format: { type: "json_object" } } : {}),
    },
    // Overridable per call for the same reason maxTokens is (see
    // NVIDIA_REQUEST_TIMEOUT_MS's own comment) - a caller that raises its
    // token budget on a non-streaming call may also need more wall-clock
    // time for fetch() to resolve.
    options?.timeoutMs
  );

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("پاسخ نامعتبر از آروان کلاد دریافت شد.");
  }

  // Phase 9.4 - previously parsed and immediately discarded. Passed back
  // via an optional callback rather than changing this function's return
  // shape from a plain string to e.g. {content, usage}: chatCompletion() is
  // mocked directly (as a plain string-returning function) across ~30 call
  // sites in lib/ai/parse-transaction.test.ts and
  // lib/ai/detect-transaction-intent.test.ts, and none of that existing
  // coverage needs to change for a purely additive observability signal -
  // only the (few) callers that actually want usage opt in via this
  // callback. Only invoked when the response actually carries a `usage`
  // object, so a caller's log line doesn't gain a spurious
  // `usage: {}`/all-undefined field when the provider omits it.
  if (options?.onUsage && data?.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    options.onUsage({
      promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
      completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
      totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
    });
  }

  if (options?.onResponseMeta) {
    const choice = data.choices[0];
    // vLLM-based gateways return a thinking model's reasoning as
    // `reasoning_content`; some OpenAI-compatible ones call it `reasoning`.
    const reasoning = choice.message.reasoning_content ?? choice.message.reasoning;
    options.onResponseMeta({
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
      reasoningChars: typeof reasoning === "string" ? reasoning.length : undefined,
    });
  }

  return content;
}

// Phase 1 chat-pipeline-instrumentation addition: same shape as
// chatCompletion's onUsage (TokenUsage), plus `model` - the streaming
// SSE chunks each carry their own top-level `model` field per the
// OpenAI-compatible schema (same as the non-streaming response's
// top-level `model`), so it's surfaced here alongside usage rather than
// invented as a separate lookup. Deliberately its own type/callback,
// not a reuse of chatCompletion's `onUsage` option - chatCompletion's
// existing `(usage: TokenUsage) => void` contract is mocked directly
// across ~30 call sites (see this file's own onUsage comment above) and
// isn't touched by this addition.
export interface StreamUsageInfo extends TokenUsage {
  model?: string;
}

// Only requested when a caller actually wants it: `stream_options.
// include_usage` is what makes an OpenAI-compatible streaming endpoint
// emit one extra final SSE chunk (empty `choices`, populated `usage`) -
// asking for it unconditionally would add that chunk to every stream
// whether or not anything reads it.
export async function streamChatCompletion(
  messages: ChatMessageInput[],
  options?: { onUsage?: (info: StreamUsageInfo) => void }
): Promise<ReadableStream<Uint8Array>> {
  const response = await callNvidiaAI({
    messages,
    stream: true,
    max_tokens: CHAT_REPLY_MAX_TOKENS,
    // See chatCompletion()'s matching comment for why this field, and not
    // top-level `reasoning`/`thinking`.
    chat_template_kwargs: { thinking: false },
    ...(options?.onUsage ? { stream_options: { include_usage: true } } : {}),
  });
  if (!response.body) {
    throw new Error("پاسخ جریانی از آروان کلاد دریافت نشد.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                controller.enqueue(encoder.encode(delta));
              }
              // The final usage chunk (only sent when stream_options.
              // include_usage was requested above) carries `usage` with an
              // empty/absent `choices` array, not a text delta - handled as
              // its own branch here rather than folded into the delta check.
              if (options?.onUsage && json?.usage && typeof json.usage === "object") {
                const u = json.usage as Record<string, unknown>;
                options.onUsage({
                  promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
                  completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
                  totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
                  model: typeof json.model === "string" ? json.model : undefined,
                });
              }
            } catch {
              // Ignore incomplete/malformed SSE chunks; buffer continues on next read.
            }
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
