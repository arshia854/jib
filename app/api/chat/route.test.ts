import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
  streamChatCompletion: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { chatCompletion, streamChatCompletion } from "@/lib/nvidia-ai";
import { POST } from "@/app/api/chat/route";

const mockedGetSession = vi.mocked(getSession);
const mockedChatCompletion = vi.mocked(chatCompletion);
const mockedStreamChatCompletion = vi.mocked(streamChatCompletion);

function makeRequest(message: string): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-CHAT-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return user.id;
}

describe("POST /api/chat - suggest_transaction flow", () => {
  let userId: number;
  let parentCategoryId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");

    // Matches lib/merchants.ts's "اسنپ" DEFAULT_MERCHANTS entry exactly
    // (defaultCategory: "حمل‌ونقل", defaultSubcategory: "تاکسی و اسنپ") - so
    // parseTransactionWithAI resolves this message through its fully
    // deterministic merchant-match path and never itself calls
    // chatCompletion, keeping these tests' only AI mock the intent-detection
    // call under test.
    const parent = await prisma.category.create({
      data: { userId, name: "حمل‌ونقل", icon: "🚕", color: "#123456", type: "expense" },
    });
    parentCategoryId = parent.id;
    await prisma.category.create({
      data: { userId, name: "تاکسی و اسنپ", icon: "🚕", color: "#123456", type: "expense", parentId: parentCategoryId },
    });
  });

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    mockedGetSession.mockResolvedValue({ userId, onboarded: true, role: "user" });
    mockedChatCompletion.mockReset();
    mockedStreamChatCompletion.mockReset();
  });

  it("returns a transaction_suggestion JSON response for a confident past-expense message, without writing a Transaction", async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": true}');

    const countBefore = await prisma.transaction.count({ where: { userId } });
    const res = await POST(makeRequest("دیروز ۸۰ تومن اسنپ گرفتم یادم رفت ثبت کنم"));
    const countAfter = await prisma.transaction.count({ where: { userId } });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const data = await res.json();
    expect(data.type).toBe("transaction_suggestion");
    expect(data.transaction.category).toBe("تاکسی و اسنپ");
    expect(data.transaction.type).toBe("expense");
    expect(data.transaction.needsConfirmation).toBe(false);
    expect(typeof data.message).toBe("string");
    expect(data.message).toContain("می‌خواید ثبتش کنم؟");

    // No DB write happens before explicit user confirmation - the chat
    // route only ever surfaces a suggestion, it never calls
    // createTransaction/prisma.transaction.create itself.
    expect(countAfter).toBe(countBefore);
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();

    // The confirmation text itself is logged as a normal assistant chat
    // message, same as any other reply, so history/context stays coherent.
    const savedAssistantMsg = await prisma.chatMessage.findFirst({
      where: { userId, role: "assistant" },
      orderBy: { timestamp: "desc" },
    });
    expect(savedAssistantMsg?.content).toBe(data.message);
  });

  it("falls back to normal streamed chat when intent detection says this isn't a transaction", async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion.mockResolvedValueOnce(textStream("سلام! چطور می‌تونم کمکتون کنم؟"));

    const res = await POST(makeRequest("این ماه بیشتر کجا خرج کردم؟"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(mockedStreamChatCompletion).toHaveBeenCalledTimes(1);
    // Intent detection is the only chatCompletion call in this path -
    // parseTransactionWithAI is never reached at all.
    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal streamed chat (with a clarifying-question nudge) when extraction can't resolve amount/category confidently, and still writes nothing", async () => {
    mockedChatCompletion
      .mockResolvedValueOnce('{"isPastUnloggedTransaction": true}') // intent detection
      .mockResolvedValueOnce("this is not valid json"); // parseTransactionWithAI's own AI call, forced to fail
    mockedStreamChatCompletion.mockResolvedValueOnce(textStream("دقیقاً چقدر بود و برای چی؟"));

    const countBefore = await prisma.transaction.count({ where: { userId } });
    const res = await POST(makeRequest("یه چیزی خریدم یادم نیست چقدر بود"));
    const countAfter = await prisma.transaction.count({ where: { userId } });

    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(countAfter).toBe(countBefore);
    expect(mockedStreamChatCompletion).toHaveBeenCalledTimes(1);

    const messagesSent = mockedStreamChatCompletion.mock.calls[0][0];
    const systemMessage = messagesSent.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("سؤال کوتاه و دقیق بپرس");
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest("سلام"));
    expect(res.status).toBe(401);
  });
});
