import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET, POST } from "@/app/api/chat/conversations/route";

const mockedGetSession = vi.mocked(getSession);

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-CONVERSATIONS-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return user.id;
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("/api/chat/conversations", () => {
  let userId: number;
  let otherUserId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");
    otherUserId = await createTestUser("other");
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
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("POST returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);

    expect(await prisma.conversation.count({ where: { userId } })).toBe(0);
  });

  it("POST creates an untitled conversation owned by the session user (201)", async () => {
    const res = await POST();
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.conversation.title).toBeNull();
    expect(data.conversation.userId).toBe(userId);

    const stored = await prisma.conversation.findUnique({ where: { id: data.conversation.id } });
    expect(stored?.userId).toBe(userId);
  });

  it("GET lists the session user's conversations, newest activity first", async () => {
    const older = await prisma.conversation.create({
      data: { userId, title: "قدیمی", lastMessageAt: new Date("2026-07-01T00:00:00Z") },
    });
    const newer = await prisma.conversation.create({
      data: { userId, title: "جدید", lastMessageAt: new Date("2026-07-20T00:00:00Z") },
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    const ids = data.conversations.map((c: { id: number }) => c.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it("GET never includes another user's conversations", async () => {
    const foreign = await prisma.conversation.create({ data: { userId: otherUserId, title: "مال دیگری" } });

    const res = await GET();
    const data = await res.json();

    expect(data.conversations.some((c: { id: number }) => c.id === foreign.id)).toBe(false);
    expect(data.conversations.every((c: { title: string | null }) => c.title !== "مال دیگری")).toBe(true);
  });
});
