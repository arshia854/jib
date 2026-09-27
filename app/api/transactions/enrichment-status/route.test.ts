import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET } from "@/app/api/transactions/enrichment-status/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(ids: string): NextRequest {
  return new NextRequest(`http://localhost/api/transactions/enrichment-status?ids=${ids}`);
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("GET /api/transactions/enrichment-status", () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;
  let categoryId: number;
  let pendingId: number;
  let doneId: number;
  let otherUsersPendingId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ENRICH-STATUS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-ENRICH-STATUS-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    otherUserId = otherUser.id;

    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;
    const category = await prisma.category.create({
      data: { userId, name: "دسته تست", icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    categoryId = category.id;

    const pending = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId,
        amount: 10000,
        type: "expense",
        rawInput: "در حال پردازش",
        enrichmentStatus: "pending",
      },
    });
    pendingId = pending.id;

    const done = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId,
        amount: 5000,
        type: "expense",
        rawInput: "پردازش شده",
        enrichmentStatus: "done",
      },
    });
    doneId = done.id;

    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUserId, name: "حساب دیگر", type: "cash" },
    });
    const otherCategory = await prisma.category.create({
      data: { userId: otherUserId, name: "دسته دیگر", icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    const otherPending = await prisma.transaction.create({
      data: {
        userId: otherUserId,
        accountId: otherAccount.id,
        categoryId: otherCategory.id,
        amount: 7000,
        type: "expense",
        rawInput: "تراکنش کاربر دیگر",
        enrichmentStatus: "pending",
      },
    });
    otherUsersPendingId = otherPending.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.category.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("returns 401 without a session", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await GET(makeRequest("1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when ids is missing", async () => {
    const res = await GET(new NextRequest("http://localhost/api/transactions/enrichment-status"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-numeric ids", async () => {
    const res = await GET(makeRequest("1,abc"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on zero/negative ids", async () => {
    const res = await GET(makeRequest("0"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when over the 50-id cap", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
    const res = await GET(makeRequest(ids));
    expect(res.status).toBe(400);
  });

  it("returns only still-pending ids, scoped to the current user", async () => {
    const res = await GET(makeRequest(`${pendingId},${doneId},${otherUsersPendingId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pendingIds).toEqual([pendingId]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("dedupes repeated ids in the query", async () => {
    const res = await GET(makeRequest(`${pendingId},${pendingId}`));
    const body = await res.json();
    expect(body.pendingIds).toEqual([pendingId]);
  });
});
