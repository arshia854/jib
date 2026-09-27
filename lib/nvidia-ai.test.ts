import { describe, it, expect, vi, afterEach } from "vitest";
import { chatCompletion, streamChatCompletion, NVIDIA_REQUEST_TIMEOUT_MS, type ChatMessageInput } from "@/lib/nvidia-ai";

function stubEnv() {
  vi.stubEnv("ARVAN_AI_API_KEY", "test-key");
  vi.stubEnv("ARVAN_AI_BASE_URL", "https://example.test/v1");
  vi.stubEnv("ARVAN_AI_MODEL", "test-model");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const MESSAGES: ChatMessageInput[] = [{ role: "user", content: "سلام" }];

// Regression coverage for SEC-6: callNvidiaAI() itself has no hardcoded
// max_tokens, so this only ever holds true if both call sites keep setting
// their own - a silently dropped field here would reopen the uncapped-cost
// gap without any type error to catch it.
describe("chatCompletion", () => {
  it("caps output at a size sized for compact structured JSON (parse-transaction / detect-transaction-intent)", async () => {
    stubEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion(MESSAGES, { json: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(1500);
    // Confirms max_tokens is additive, not a replacement for the existing
    // json-mode request_format wiring.
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("still sets max_tokens on the plain (non-json) call path", async () => {
    stubEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "isPastUnloggedTransaction" } }] }), {
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion(MESSAGES);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).max_tokens).toBe(1500);
  });

  // A caller with a larger structured-JSON schema than the default was
  // sized for (e.g. lib/goals/strategy.ts's generateGoalStrategy) can
  // request more room via options.maxTokens instead of being stuck with
  // the shared 1500 default - see that module's own GOAL_STRATEGY_JSON_MAX_TOKENS.
  it("honors an explicit maxTokens override instead of the shared JSON-extraction default", async () => {
    stubEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion(MESSAGES, { json: true, maxTokens: 3000 });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(3000);
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

describe("streamChatCompletion", () => {
  it("caps output at a larger size than chatCompletion's, sized for a conversational reply", async () => {
    stubEnv();
    const sse = `data: {"choices":[{"delta":{"content":"سلام"}}]}\n\ndata: [DONE]\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await streamChatCompletion(MESSAGES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(2500);
    expect(body.max_tokens).toBeGreaterThan(500); // strictly larger than chatCompletion's JSON-extraction cap
    // Confirms max_tokens is additive, not a replacement for the existing
    // stream:true wiring.
    expect(body.stream).toBe(true);
  });
});

// Phase 9.1 - callNvidiaAI() gateway timeout, shared by both call sites
// above (they both go through it), so exercised once here via
// chatCompletion rather than duplicated against streamChatCompletion too.
describe("gateway timeout (Phase 9.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the request and surfaces a clear error if ArvanCloud never responds within the timeout", async () => {
    stubEnv();
    vi.useFakeTimers();
    // Never resolves on its own - only reacts to the AbortController's
    // signal, exactly like a real stalled fetch() would once aborted.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = chatCompletion(MESSAGES);
    const expectation = expect(promise).rejects.toThrow(/کندی/);
    await vi.advanceTimersByTimeAsync(NVIDIA_REQUEST_TIMEOUT_MS);
    await expectation;

    // A timeout abort is not retried (see isConnectionLevelFailure's own
    // comment - it may already be mid-generation server-side) - exactly one
    // fetch call, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression coverage for the goals/strategy production timeout: raising
  // GOAL_STRATEGY_JSON_MAX_TOKENS to 3000 without a matching timeout meant
  // the shared 30s default fired on legitimately-longer completions (AI_ERROR
  // logs with duration: 30002, twice, for that route). A caller with a
  // larger token budget can now request its own longer timeout via
  // chatCompletion's `timeoutMs` option, the same way `maxTokens` already
  // works. The abort fires only once, at the overridden delay (not the
  // shared default), and the error message reports that overridden value -
  // if the override weren't actually reaching the abort timer/message, this
  // would either time out waiting for the promise to settle or report "30"
  // instead of "60".
  it("honors an explicit timeoutMs override instead of the shared default", async () => {
    stubEnv();
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const overrideMs = 60_000;
    const promise = chatCompletion(MESSAGES, { timeoutMs: overrideMs });
    const expectation = expect(promise).rejects.toThrow(/بیش از 60 ثانیه/);
    await vi.advanceTimersByTimeAsync(overrideMs);
    await expectation;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a connection-level failure (fetch() itself rejecting) and succeeds on the retry", async () => {
    stubEnv();
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletion(MESSAGES);

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after a second connection-level failure (only one retry, not unbounded)", async () => {
    stubEnv();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(MESSAGES)).rejects.toThrow(/ارتباط با آروان کلاد برقرار نشد/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original attempt + exactly one retry
  });

  it("does not retry an HTTP-level error response (4xx/5xx) - only connection-level failures are retried", async () => {
    stubEnv();
    const fetchMock = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(MESSAGES)).rejects.toThrow(/ناموفق بود/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Phase 9.4 - token usage, previously parsed by callNvidiaAI's caller and
// discarded.
describe("chatCompletion onUsage (Phase 9.4)", () => {
  it("passes usage through to an onUsage callback when the response carries one, without changing the return value", async () => {
    stubEnv();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const onUsage = vi.fn();
    const content = await chatCompletion(MESSAGES, { json: true, onUsage });

    expect(content).toBe("{}");
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 120, completionTokens: 40, totalTokens: 160 });
  });

  it("does not call onUsage when the response has no usage field", async () => {
    stubEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const onUsage = vi.fn();
    await chatCompletion(MESSAGES, { onUsage });

    expect(onUsage).not.toHaveBeenCalled();
  });
});

describe("chatCompletion onResponseMeta", () => {
  it("reports finish_reason and the length of any reasoning text returned alongside the content", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "length", message: { content: '{"summary": "ناتما', reasoning_content: "x".repeat(900) } }],
          }),
          { status: 200 }
        )
      )
    );

    const onResponseMeta = vi.fn();
    const content = await chatCompletion(MESSAGES, { json: true, onResponseMeta });

    expect(content).toBe('{"summary": "ناتما');
    expect(onResponseMeta).toHaveBeenCalledWith({ finishReason: "length", reasoningChars: 900 });
  });

  it("leaves both fields undefined when the provider sends neither", async () => {
    stubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }))
    );

    const onResponseMeta = vi.fn();
    await chatCompletion(MESSAGES, { json: true, onResponseMeta });

    expect(onResponseMeta).toHaveBeenCalledWith({ finishReason: undefined, reasoningChars: undefined });
  });
});
