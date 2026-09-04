import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  listConversations,
  createConversation,
  getConversation,
  listMessages,
  deleteConversation,
  touchConversation,
  maybeAutoTitle,
  ConversationNotFoundError,
} from "@/lib/data/conversations";

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-CONVERSATIONS-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return user.id;
}

async function addMessage(userId: number, conversationId: number, role: string, content: string, timestamp: Date) {
  return prisma.chatMessage.create({ data: { userId, conversationId, role, content, timestamp } });
}

describe("lib/data/conversations - CRUD", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("crud");
  }, 20000);

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId } });
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }, 20000);

  it("creates an untitled conversation", async () => {
    const conversation = await createConversation(userId);
    expect(conversation.title).toBeNull();
    expect(conversation.userId).toBe(userId);

    const fetched = await getConversation(userId, conversation.id);
    expect(fetched.id).toBe(conversation.id);

    await deleteConversation(userId, conversation.id);
  });

  it("orders listConversations by lastMessageAt descending, newest activity first", async () => {
    const older = await createConversation(userId);
    const newer = await createConversation(userId);

    // Set explicitly rather than relying on creation order - lastMessageAt
    // is what the history list sorts by, and it moves independently of id.
    await prisma.conversation.update({
      where: { id: older.id },
      data: { lastMessageAt: new Date("2026-08-01T10:00:00Z") },
    });
    await prisma.conversation.update({
      where: { id: newer.id },
      data: { lastMessageAt: new Date("2026-08-20T10:00:00Z") },
    });

    const list = await listConversations(userId);
    const ids = list.map((c) => c.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));

    await deleteConversation(userId, older.id);
    await deleteConversation(userId, newer.id);
  });

  it("touchConversation moves a conversation to the top of the list", async () => {
    const first = await createConversation(userId);
    const second = await createConversation(userId);
    await prisma.conversation.update({
      where: { id: first.id },
      data: { lastMessageAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.conversation.update({
      where: { id: second.id },
      data: { lastMessageAt: new Date("2026-01-02T00:00:00Z") },
    });
    expect((await listConversations(userId))[0].id).toBe(second.id);

    await touchConversation(first.id);
    expect((await listConversations(userId))[0].id).toBe(first.id);

    await deleteConversation(userId, first.id);
    await deleteConversation(userId, second.id);
  });

  it("deleteConversation cascades its messages", async () => {
    const conversation = await createConversation(userId);
    const message = await addMessage(userId, conversation.id, "user", "سلام", new Date());

    await deleteConversation(userId, conversation.id);

    expect(await prisma.conversation.findUnique({ where: { id: conversation.id } })).toBeNull();
    expect(await prisma.chatMessage.findUnique({ where: { id: message.id } })).toBeNull();
  });

  it("throws ConversationNotFoundError for an id that doesn't exist at all", async () => {
    await expect(getConversation(userId, 999_999_999)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(listMessages(userId, 999_999_999)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(deleteConversation(userId, 999_999_999)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("lib/data/conversations - listMessages", () => {
  let userId: number;
  let conversationId: number;

  beforeAll(async () => {
    userId = await createTestUser("messages");
    const conversation = await createConversation(userId);
    conversationId = conversation.id;

    // 60 messages, oldest first - more than the default take of 50, so the
    // asc/take bug this replaces (which returned the OLDEST 50) would be
    // visible as message #1 appearing and #60 missing.
    for (let i = 1; i <= 60; i++) {
      await addMessage(
        userId,
        conversationId,
        i % 2 === 1 ? "user" : "assistant",
        `پیام ${i}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i))
      );
    }
  }, 30000);

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId } });
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }, 20000);

  it("returns the most recent `take` messages, oldest-first (not the oldest N)", async () => {
    const messages = await listMessages(userId, conversationId);

    expect(messages).toHaveLength(50);
    // Newest 50 of 60 = #11..#60, in reading order.
    expect(messages[0].content).toBe("پیام 11");
    expect(messages[messages.length - 1].content).toBe("پیام 60");
    expect(messages.some((m) => m.content === "پیام 1")).toBe(false);

    const timestamps = messages.map((m) => m.timestamp.getTime());
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it("honours an explicit smaller take, still newest-window/oldest-first", async () => {
    const messages = await listMessages(userId, conversationId, 3);
    expect(messages.map((m) => m.content)).toEqual(["پیام 58", "پیام 59", "پیام 60"]);
  });

  it("returns only this conversation's messages, never the user's other threads", async () => {
    const other = await createConversation(userId);
    await addMessage(userId, other.id, "user", "پیام گفتگوی دیگر", new Date());

    const messages = await listMessages(userId, conversationId, 60);
    expect(messages.some((m) => m.content === "پیام گفتگوی دیگر")).toBe(false);

    const otherMessages = await listMessages(userId, other.id);
    expect(otherMessages.map((m) => m.content)).toEqual(["پیام گفتگوی دیگر"]);

    await deleteConversation(userId, other.id);
  });
});

describe("lib/data/conversations - maybeAutoTitle", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("title");
  }, 20000);

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }, 20000);

  it("titles an untitled conversation from the message, and never re-titles it afterwards", async () => {
    const conversation = await createConversation(userId);

    await maybeAutoTitle(conversation.id, "این ماه بیشتر کجا خرج کردم؟");
    expect((await getConversation(userId, conversation.id)).title).toBe("این ماه بیشتر کجا خرج کردم؟");

    await maybeAutoTitle(conversation.id, "یک پیام کاملاً متفاوت بعدی");
    expect((await getConversation(userId, conversation.id)).title).toBe("این ماه بیشتر کجا خرج کردم؟");
  });

  it("truncates a long message to 40 characters plus an ellipsis", async () => {
    const conversation = await createConversation(userId);
    const long =
      "سلام می‌خواستم بدونم این ماه بیشترین هزینه من در کدام دسته بوده و چطور می‌تونم کمترش کنم";

    await maybeAutoTitle(conversation.id, long);

    const title = (await getConversation(userId, conversation.id)).title!;
    expect([...title]).toHaveLength(41);
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, -1)).toBe([...long].slice(0, 40).join(""));
  });

  it("trims surrounding whitespace and leaves the conversation untitled for an all-whitespace message", async () => {
    const trimmed = await createConversation(userId);
    await maybeAutoTitle(trimmed.id, "   موجودیم چقدره؟   ");
    expect((await getConversation(userId, trimmed.id)).title).toBe("موجودیم چقدره؟");

    const blank = await createConversation(userId);
    await maybeAutoTitle(blank.id, "    ");
    expect((await getConversation(userId, blank.id)).title).toBeNull();
  });

  it("never splits a multi-codepoint character in half at the cut", async () => {
    const conversation = await createConversation(userId);
    // 39 plain characters then an astral-plane emoji, so the 40th
    // character is exactly the one at the boundary - a UTF-16 `.slice(40)`
    // would cut its surrogate pair and produce a lone surrogate.
    const message = `${"ا".repeat(39)}😀${"ب".repeat(20)}`;

    await maybeAutoTitle(conversation.id, message);

    const title = (await getConversation(userId, conversation.id)).title!;
    expect(title).toBe(`${"ا".repeat(39)}😀…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(title)).toBe(false);
  });
});

describe("lib/data/conversations - cross-user ownership", () => {
  let userAId: number;
  let userBId: number;
  let conversationAId: number;
  let messageAId: number;

  beforeAll(async () => {
    userAId = await createTestUser("owner-a");
    userBId = await createTestUser("owner-b");

    const conversationA = await createConversation(userAId);
    conversationAId = conversationA.id;
    const message = await addMessage(userAId, conversationAId, "user", "پیام خصوصی الف", new Date());
    messageAId = message.id;
  }, 20000);

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  }, 20000);

  it("listConversations never returns another user's conversations", async () => {
    const listB = await listConversations(userBId);
    expect(listB.some((c) => c.id === conversationAId)).toBe(false);

    const listA = await listConversations(userAId);
    expect(listA.some((c) => c.id === conversationAId)).toBe(true);
  });

  it("getConversation throws for another user's conversation", async () => {
    await expect(getConversation(userBId, conversationAId)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("listMessages throws for another user's conversation, leaking no message content", async () => {
    await expect(listMessages(userBId, conversationAId)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("deleteConversation throws for another user's conversation and leaves it (and its messages) intact", async () => {
    await expect(deleteConversation(userBId, conversationAId)).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(await prisma.conversation.findUnique({ where: { id: conversationAId } })).not.toBeNull();
    const message = await prisma.chatMessage.findUnique({ where: { id: messageAId } });
    expect(message?.content).toBe("پیام خصوصی الف");
  });
});
