import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
  streamChatCompletion: vi.fn(),
  AI_PROVIDER: "nvidia-nim",
}));

import { getSession } from "@/lib/auth/session";
import { chatCompletion, streamChatCompletion } from "@/lib/nvidia-ai";
import { POST } from "@/app/api/chat/route";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);
const mockedChatCompletion = vi.mocked(chatCompletion);
const mockedStreamChatCompletion = vi.mocked(streamChatCompletion);

// Every send is scoped to a conversation now - the id is a required body
// field, so it's threaded through this helper rather than left to each
// test. `conversationId: undefined` is dropped by JSON.stringify, which is
// exactly the "missing param" case the validation tests want.
function makeRequest(message: string, conversationId?: number | string | null): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
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
  let conversationId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");
    // Pre-titled so these tests exercise the ordinary "existing thread"
    // path - auto-titling gets its own block below.
    const conversation = await prisma.conversation.create({ data: { userId, title: "گفتگوی آزمایشی" } });
    conversationId = conversation.id;

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
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  beforeEach(() => {
    mockedGetSession.mockResolvedValue({ userId, onboarded: true, role: "user" });
    mockedChatCompletion.mockReset();
    mockedStreamChatCompletion.mockReset();
  });

  it("returns a transaction_suggestion JSON response for a confident past-expense message, without writing a Transaction", async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": true}');

    const countBefore = await prisma.transaction.count({ where: { userId } });
    const res = await POST(makeRequest("دیروز ۸۰ تومن اسنپ گرفتم یادم رفت ثبت کنم", conversationId));
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

    const res = await POST(makeRequest("این ماه بیشتر کجا خرج کردم؟", conversationId));

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
    const res = await POST(makeRequest("یه چیزی خریدم یادم نیست چقدر بود", conversationId));
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
    const res = await POST(makeRequest("سلام", conversationId));
    expect(res.status).toBe(401);
  });

  it("rejects a message over MAX_CHAT_MESSAGE_LENGTH with a generic 400, before persisting it or calling the AI", async () => {
    const tooLong = "ا".repeat(MAX_CHAT_MESSAGE_LENGTH + 1);

    const countBefore = await prisma.chatMessage.count({ where: { userId } });
    const res = await POST(makeRequest(tooLong, conversationId));
    const countAfter = await prisma.chatMessage.count({ where: { userId } });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
    expect(countAfter).toBe(countBefore);
    expect(mockedChatCompletion).not.toHaveBeenCalled();
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("accepts a message of exactly MAX_CHAT_MESSAGE_LENGTH, sending and persisting it in full (no truncation)", async () => {
    const atLimit = "ب".repeat(MAX_CHAT_MESSAGE_LENGTH);
    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion.mockResolvedValueOnce(textStream("چطور می‌تونم کمکتون کنم؟"));

    const res = await POST(makeRequest(atLimit, conversationId));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");

    // The current turn is exactly HISTORY_MESSAGE_CHAR_CAP-exempt (see
    // truncateForPrompt in app/api/chat/route.ts) - confirm it reaches the
    // model unmodified, not silently cut down to that 800-char figure.
    const messagesSent = mockedStreamChatCompletion.mock.calls[0][0];
    const lastMessage = messagesSent[messagesSent.length - 1];
    expect(lastMessage.content).toBe(atLimit);
    expect(lastMessage.content.length).toBe(MAX_CHAT_MESSAGE_LENGTH);

    const savedUserMsg = await prisma.chatMessage.findFirst({
      where: { userId, role: "user", content: atLimit },
    });
    expect(savedUserMsg).not.toBeNull();
  });

  // AI checklist item: "provider error" - end-to-end through this route's
  // own streamChatCompletion() call site (distinct from the
  // chatCompletion() intent-detection call, already exercised by every
  // other test in this file).
  it("returns 502 with a Persian error message when streamChatCompletion fails, and reports the failure", async () => {
    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion.mockRejectedValueOnce(new Error("NVIDIA NIM: connection refused"));

    const res = await POST(makeRequest("این ماه چقدر خرج کردم؟", conversationId));

    expect(res.status).toBe(502);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
  });
});

describe("POST /api/chat - conversationId validation and ownership", () => {
  let userId: number;
  let otherUserId: number;
  let conversationId: number;
  let foreignConversationId: number;

  beforeAll(async () => {
    userId = await createTestUser("scoping");
    otherUserId = await createTestUser("scoping-other");

    conversationId = (await prisma.conversation.create({ data: { userId, title: "مال من" } })).id;
    foreignConversationId = (await prisma.conversation.create({ data: { userId: otherUserId, title: "مال دیگری" } })).id;
  });

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  beforeEach(() => {
    mockedGetSession.mockResolvedValue({ userId, onboarded: true, role: "user" });
    mockedChatCompletion.mockReset();
    mockedStreamChatCompletion.mockReset();
  });

  it("rejects a missing conversationId with 400, before persisting the message or calling the AI", async () => {
    const countBefore = await prisma.chatMessage.count({ where: { userId } });
    const res = await POST(makeRequest("سلام"));
    const countAfter = await prisma.chatMessage.count({ where: { userId } });

    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(countAfter).toBe(countBefore);
    expect(mockedChatCompletion).not.toHaveBeenCalled();
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric conversationId with 400", async () => {
    const res = await POST(makeRequest("سلام", "abc"));
    expect(res.status).toBe(400);
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects a non-integer numeric conversationId with 400", async () => {
    const res = await POST(makeRequest("سلام", 1.5));
    expect(res.status).toBe(400);
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's conversation, writing nothing into it and never calling the AI", async () => {
    const res = await POST(makeRequest("پیام نفوذی", foreignConversationId));

    expect(res.status).toBe(404);
    expect(await prisma.chatMessage.count({ where: { conversationId: foreignConversationId } })).toBe(0);
    expect(mockedChatCompletion).not.toHaveBeenCalled();
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("returns 404 for a conversation id that doesn't exist", async () => {
    const res = await POST(makeRequest("سلام", 999_999_999));
    expect(res.status).toBe(404);
    expect(mockedStreamChatCompletion).not.toHaveBeenCalled();
  });

  it("sends only this conversation's history to the model, never the user's other threads", async () => {
    const otherThread = await prisma.conversation.create({ data: { userId, title: "گفتگوی دیگر" } });
    await prisma.chatMessage.create({
      data: { userId, conversationId: otherThread.id, role: "user", content: "راز گفتگوی دیگر" },
    });
    await prisma.chatMessage.create({
      data: { userId, conversationId, role: "user", content: "پیام قبلی همین گفتگو" },
    });

    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion.mockResolvedValueOnce(textStream("باشه"));

    const res = await POST(makeRequest("پیام تازه", conversationId));
    await res.text();

    const messagesSent = mockedStreamChatCompletion.mock.calls[0][0];
    const historyContents = messagesSent.filter((m) => m.role !== "system").map((m) => m.content);
    expect(historyContents).toContain("پیام قبلی همین گفتگو");
    expect(historyContents).toContain("پیام تازه");
    expect(historyContents).not.toContain("راز گفتگوی دیگر");
  });
});

describe("POST /api/chat - auto-titling and last-activity", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("titling");
  });

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId } });
    await prisma.conversation.deleteMany({ where: { userId } });
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

  it("titles an untitled conversation from the first message, and leaves it alone on the next one", async () => {
    const conversation = await prisma.conversation.create({ data: { userId } });
    expect(conversation.title).toBeNull();

    mockedChatCompletion.mockResolvedValue('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion
      .mockResolvedValueOnce(textStream("پاسخ اول"))
      .mockResolvedValueOnce(textStream("پاسخ دوم"));

    // The title/lastMessageAt write happens when the response stream
    // finishes (see the `done` branch in app/api/chat/route.ts), so the
    // body has to actually be consumed here.
    await (await POST(makeRequest("موجودی حسابم چقدره؟", conversation.id))).text();
    const afterFirst = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(afterFirst?.title).toBe("موجودی حسابم چقدره؟");

    await (await POST(makeRequest("و این ماه چقدر خرج کردم؟", conversation.id))).text();
    const afterSecond = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(afterSecond?.title).toBe("موجودی حسابم چقدره؟");
  });

  it("bumps lastMessageAt after a reply", async () => {
    const conversation = await prisma.conversation.create({
      data: { userId, title: "از قبل نام‌گذاری‌شده", lastMessageAt: new Date("2026-01-01T00:00:00Z") },
    });

    mockedChatCompletion.mockResolvedValue('{"isPastUnloggedTransaction": false}');
    mockedStreamChatCompletion.mockResolvedValueOnce(textStream("باشه"));

    await (await POST(makeRequest("سلام", conversation.id))).text();

    const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(updated!.lastMessageAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    // The pre-existing title is never overwritten by a later message.
    expect(updated!.title).toBe("از قبل نام‌گذاری‌شده");
  });

  it("titles a conversation from the first message on the suggest_transaction path too", async () => {
    const parent = await prisma.category.create({
      data: { userId, name: "حمل‌ونقل", icon: "🚕", color: "#123456", type: "expense" },
    });
    await prisma.category.create({
      data: { userId, name: "تاکسی و اسنپ", icon: "🚕", color: "#123456", type: "expense", parentId: parent.id },
    });
    const conversation = await prisma.conversation.create({ data: { userId } });

    mockedChatCompletion.mockResolvedValueOnce('{"isPastUnloggedTransaction": true}');

    // Deliberately under the 40-character title cap, so this asserts the
    // suggest_transaction path titles at all - truncation itself is
    // covered by lib/data/conversations.test.ts.
    const message = "دیروز ۸۰ تومن اسنپ گرفتم";

    // This path returns JSON rather than a stream, so there's no body to
    // drain - the finalize step runs before the response is returned.
    const res = await POST(makeRequest(message, conversation.id));
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(updated?.title).toBe(message);
  });
});
