const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY تنظیم نشده است. آن را در فایل .env قرار دهید.");
  }
  return key;
}

function getModel(): string {
  return process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageInput {
  role: ChatRole;
  content: string;
}

async function callOpenRouter(body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://jeeb.app",
      "X-Title": "Jeeb",
    },
    body: JSON.stringify({ model: getModel(), ...body }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`درخواست به OpenRouter ناموفق بود (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response;
}

export async function chatCompletion(
  messages: ChatMessageInput[],
  options?: { json?: boolean }
): Promise<string> {
  const response = await callOpenRouter({
    messages,
    ...(options?.json ? { response_format: { type: "json_object" } } : {}),
  });

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("پاسخ نامعتبر از OpenRouter دریافت شد.");
  }
  return content;
}

/** Streams raw text deltas (already extracted from SSE `data:` chunks). */
export async function streamChatCompletion(
  messages: ChatMessageInput[]
): Promise<ReadableStream<Uint8Array>> {
  const response = await callOpenRouter({ messages, stream: true });
  if (!response.body) {
    throw new Error("پاسخ جریانی از OpenRouter دریافت نشد.");
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
