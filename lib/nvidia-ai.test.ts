import { describe, it, expect, vi, afterEach } from "vitest";
import { chatCompletion, streamChatCompletion, NVIDIA_REQUEST_TIMEOUT_MS, type ChatMessageInput } from "@/lib/nvidia-ai";

function stubEnv() {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_BASE_URL", "https://example.test/v1");
  vi.stubEnv("OPENROUTER_MODEL", "test-model");
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

  it("aborts the request and surfaces a clear error if OpenRouter never responds within the timeout", async () => {
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

    await expect(chatCompletion(MESSAGES)).rejects.toThrow(/ارتباط با OpenRouter برقرار نشد/);
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
