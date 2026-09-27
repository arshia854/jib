import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET, DELETE } from "@/app/api/chat/conversations/[id]/route";

const mockedGetSession = vi.mocked(getSession);

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-CONVERSATION-ID-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return user.id;
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/chat/conversations/1");
}

function paramsFor(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

describe("/api/chat/conversations/[id]", () => {
  let userId: number;
  let otherUserId: number;
  let conversationId: number;
  let foreignConversationId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");
    otherUserId = await createTestUser("other");

    const conversation = await prisma.conversation.create({ data: { userId, title: "گفتگوی من" } });
    conversationId = conversation.id;
    await prisma.chatMessage.createMany({
      data: [
        {
          userId,
          conversationId,
          role: "user",
          content: "پیام اول",
          timestamp: new Date("2026-08-01T10:00:00Z"),
        },
        {
          userId,
          conversationId,
          role: "assistant",
          content: "پاسخ اول",
          timestamp: new Date("2026-08-01T10:00:05Z"),
        },
      ],
    });

    const foreign = await prisma.conversation.create({ data: { userId: otherUserId, title: "مال دیگری" } });
    foreignConversationId = foreign.id;
    await prisma.chatMessage.create({
      data: { userId: otherUserId, conversationId: foreignConversationId, role: "user", content: "راز دیگری" },
    });
  }, 20000);

  afterAll(async () => {
    await prisma.chatMessage.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  }, 20000);

  beforeEach(() => {
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  it("GET returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET(makeRequest(), paramsFor(conversationId));
    expect(res.status).toBe(401);
  });

  it("DELETE returns 401 when there is no session, and deletes nothing", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await DELETE(makeRequest(), paramsFor(conversationId));
    expect(res.status).toBe(401);
    expect(await prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
  });

  it("GET returns the conversation's messages, oldest-first", async () => {
    const res = await GET(makeRequest(), paramsFor(conversationId));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.messages.map((m: { content: string }) => m.content)).toEqual(["پیام اول", "پاسخ اول"]);
    expect(data.messages[0].role).toBe("user");
  });

  it("GET rejects a non-numeric id with 400", async () => {
    const res = await GET(makeRequest(), paramsFor("abc"));
    expect(res.status).toBe(400);
  });

  it("GET returns 404 for another user's conversation, leaking none of its messages", async () => {
    const res = await GET(makeRequest(), paramsFor(foreignConversationId));
    expect(res.status).toBe(404);

    const body = await res.text();
    expect(body).not.toContain("راز دیگری");
  });

  it("GET returns 404 for a conversation that doesn't exist", async () => {
    const res = await GET(makeRequest(), paramsFor(999_999_999));
    expect(res.status).toBe(404);
  });

  it("DELETE returns 404 for another user's conversation and leaves it intact", async () => {
    const res = await DELETE(makeRequest(), paramsFor(foreignConversationId));
    expect(res.status).toBe(404);

    expect(await prisma.conversation.findUnique({ where: { id: foreignConversationId } })).not.toBeNull();
    expect(await prisma.chatMessage.count({ where: { conversationId: foreignConversationId } })).toBe(1);
  });

  it("DELETE rejects a non-numeric id with 400", async () => {
    const res = await DELETE(makeRequest(), paramsFor("abc"));
    expect(res.status).toBe(400);
  });

  it("DELETE removes the user's own conversation and cascades its messages", async () => {
    const doomed = await prisma.conversation.create({ data: { userId, title: "برای حذف" } });
    const message = await prisma.chatMessage.create({
      data: { userId, conversationId: doomed.id, role: "user", content: "این هم می‌رود" },
    });

    const res = await DELETE(makeRequest(), paramsFor(doomed.id));
    expect(res.status).toBe(200);

    expect(await prisma.conversation.findUnique({ where: { id: doomed.id } })).toBeNull();
    expect(await prisma.chatMessage.findUnique({ where: { id: message.id } })).toBeNull();
  });
});
