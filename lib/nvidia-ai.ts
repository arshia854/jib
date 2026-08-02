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

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageInput {
  role: ChatRole;
  content: string;
}

async function callNvidiaAI(body: Record<string, unknown>): Promise<Response> {
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: getModel(), ...body }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`درخواست به NVIDIA NIM ناموفق بود (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response;
}

export async function chatCompletion(
  messages: ChatMessageInput[],
  options?: { json?: boolean }
): Promise<string> {
  const response = await callNvidiaAI({
    messages,
    ...(options?.json ? { response_format: { type: "json_object" } } : {}),
  });

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("پاسخ نامعتبر از NVIDIA NIM دریافت شد.");
  }
  return content;
}

/** Streams raw text deltas (already extracted from SSE `data:` chunks). */
export async function streamChatCompletion(
  messages: ChatMessageInput[]
): Promise<ReadableStream<Uint8Array>> {
  const response = await callNvidiaAI({ messages, stream: true });
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
