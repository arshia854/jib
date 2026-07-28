import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamChatCompletion, type ChatMessageInput } from "@/lib/openrouter";
import { getFinancialContextSummary } from "@/lib/data/chat-context";

function buildSystemPrompt(context: string): string {
  return `شما «جیب‌یار»، دستیار مالی هوشمند اپلیکیشن «جیب» هستید. به زبان فارسی، دوستانه، مختصر و کاربردی پاسخ بده. پاسخ‌هایت را بر اساس اطلاعات مالی واقعی زیر (استخراج‌شده از حساب کاربر) بنا کن و در صورت لزوم توصیه عملی برای مدیریت بهتر مالی بده. اگر داده کافی برای پاسخ دقیق نیست، صادقانه بگو و حدس نزن.

اطلاعات مالی فعلی کاربر:
${context}`;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) {
    return Response.json({ error: "پیام نمی‌تواند خالی باشد." }, { status: 400 });
  }

  await prisma.chatMessage.create({ data: { role: "user", content: message } });

  const [context, history] = await Promise.all([
    getFinancialContextSummary(),
    prisma.chatMessage.findMany({ orderBy: { timestamp: "desc" }, take: 16 }),
  ]);

  const orderedHistory = history.reverse();
  const messages: ChatMessageInput[] = [
    { role: "system", content: buildSystemPrompt(context) },
    ...orderedHistory.map(
      (m): ChatMessageInput => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })
    ),
  ];

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamChatCompletion(messages);
  } catch (error) {
    const text = error instanceof Error ? error.message : "خطا در ارتباط با هوش مصنوعی.";
    return Response.json({ error: text }, { status: 502 });
  }

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let fullResponse = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (fullResponse.trim()) {
          await prisma.chatMessage.create({ data: { role: "assistant", content: fullResponse } });
        }
        controller.close();
        return;
      }
      fullResponse += decoder.decode(value, { stream: true });
      controller.enqueue(value);
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
