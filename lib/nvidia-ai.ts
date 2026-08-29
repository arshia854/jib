// Provider name attached to AI-call log lines/Sentry reports by every
// caller of chatCompletion()/streamChatCompletion() (Phase 12.4) - shared
// here rather than each call site hardcoding its own copy, so it can't
// drift if this ever needs to change (e.g. .env.example already keeps
// OpenRouter/ArvanCloud around "in case we switch back").
export const AI_PROVIDER = "nvidia-nim";

function getApiKey(): string {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    throw new Error("NVIDIA_API_KEY تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return key;
}

function getBaseUrl(): string {
  const url = process.env.NVIDIA_BASE_URL;
  if (!url) {
    throw new Error("NVIDIA_BASE_URL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return url.replace(/\/+$/, "");
}

function getModel(): string {
  const model = process.env.NVIDIA_MODEL;
  if (!model) {
    throw new Error("NVIDIA_MODEL تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return model;
}

// Output-side cost/abuse cap (SEC-6) - NVIDIA NIM's chat/completions
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
const JSON_EXTRACTION_MAX_TOKENS = 500;
const CHAT_REPLY_MAX_TOKENS = 1000;

// Phase 9.1/9.3 gateway timeout - callNvidiaAI() previously had no
// AbortController/signal at all, so a stalled provider connection (network
// stall, provider-side hang) would leave the request pending indefinitely,
// with no bound on it beyond whatever timeout Next.js's own hosting
// platform enforces at the function level (not something this module can
// rely on for a responsive UX). One shared value for both call sites
// (chatCompletion/streamChatCompletion), sized against the larger of the
// two output caps above (CHAT_REPLY_MAX_TOKENS = 1000): for
// streamChatCompletion, fetch()'s promise resolves once the response
// headers/first SSE bytes arrive (well before the full 1000-token
// generation completes), so this bounds time-to-first-byte, not the whole
// stream; for chatCompletion's non-streaming call, the provider typically
// doesn't send the response until the full completion (up to 500 tokens
// here) is ready, so this bounds the whole generation. 30s is generous
// headroom (multiple times a realistic generation time for either cap on a
// hosted 70B-class model) while still failing a genuinely stuck request in
// a bounded, user-visible time instead of hanging.
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

// NVIDIA NIM's OpenAI-compatible chat/completions response includes a
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

function wrapFetchError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error(
      `درخواست به NVIDIA NIM به دلیل کندی پاسخ لغو شد (بیش از ${NVIDIA_REQUEST_TIMEOUT_MS / 1000} ثانیه).`
    );
  }
  return new Error(`ارتباط با NVIDIA NIM برقرار نشد: ${error instanceof Error ? error.message : String(error)}`);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NVIDIA_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callNvidiaAI(body: Record<string, unknown>): Promise<Response> {
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
    response = await fetchWithTimeout(url, init);
  } catch (firstError) {
    if (!isConnectionLevelFailure(firstError) || CONNECTION_RETRY_ATTEMPTS < 1) {
      throw wrapFetchError(firstError);
    }
    try {
      response = await fetchWithTimeout(url, init);
    } catch (secondError) {
      throw wrapFetchError(secondError);
    }
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`درخواست به NVIDIA NIM ناموفق بود (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response;
}

export async function chatCompletion(
  messages: ChatMessageInput[],
  options?: { json?: boolean; onUsage?: (usage: TokenUsage) => void }
): Promise<string> {
  const response = await callNvidiaAI({
    messages,
    max_tokens: JSON_EXTRACTION_MAX_TOKENS,
    ...(options?.json ? { response_format: { type: "json_object" } } : {}),
  });

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("پاسخ نامعتبر از NVIDIA NIM دریافت شد.");
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

  return content;
}

/** Streams raw text deltas (already extracted from SSE `data:` chunks). */
export async function streamChatCompletion(
  messages: ChatMessageInput[]
): Promise<ReadableStream<Uint8Array>> {
  const response = await callNvidiaAI({ messages, stream: true, max_tokens: CHAT_REPLY_MAX_TOKENS });
  if (!response.body) {
    throw new Error("پاسخ جریانی از NVIDIA NIM دریافت نشد.");
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
