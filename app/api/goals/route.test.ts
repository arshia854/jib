import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET, POST } from "@/app/api/goals/route";
import { MAX_NAME_LENGTH, MAX_GOAL_TARGET_AMOUNT } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

describe("POST /api/goals - validation", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects a name over MAX_NAME_LENGTH (400)", async () => {
    const res = await POST(
      makeRequest({ name: "ا".repeat(MAX_NAME_LENGTH + 1), category: "device", targetAmount: 1000, deadline: daysFromNow(30) })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a category outside the fixed enum (400)", async () => {
    const res = await POST(
      makeRequest({ name: "لپ‌تاپ", category: "not-a-real-category", targetAmount: 1000, deadline: daysFromNow(30) })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a targetAmount over MAX_GOAL_TARGET_AMOUNT (400)", async () => {
    const res = await POST(
      makeRequest({
        name: "لپ‌تاپ",
        category: "device",
        targetAmount: MAX_GOAL_TARGET_AMOUNT + 1,
        deadline: daysFromNow(30),
      })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive targetAmount (400)", async () => {
    const res = await POST(makeRequest({ name: "لپ‌تاپ", category: "device", targetAmount: 0, deadline: daysFromNow(30) }));
    expect(res.status).toBe(400);
  });

  it("rejects a deadline of today (400)", async () => {
    const res = await POST(makeRequest({ name: "لپ‌تاپ", category: "device", targetAmount: 1000, deadline: daysFromNow(0) }));
    expect(res.status).toBe(400);
  });

  it("rejects a deadline in the past (400)", async () => {
    const res = await POST(
      makeRequest({ name: "لپ‌تاپ", category: "device", targetAmount: 1000, deadline: daysFromNow(-5) })
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable deadline (400)", async () => {
    const res = await POST(
      makeRequest({ name: "لپ‌تاپ", category: "device", targetAmount: 1000, deadline: "not-a-date" })
    );
    expect(res.status).toBe(400);
  });

  it("creates a valid goal (201) with initialAmount defaulting to 0", async () => {
    const res = await POST(
      makeRequest({ name: "مک‌بوک", category: "device", targetAmount: 60_000_000, deadline: daysFromNow(180) })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.goal.name).toBe("مک‌بوک");
    expect(data.goal.category).toBe("device");
    expect(data.goal.targetAmount).toBe(60_000_000);
    expect(data.goal.initialAmount).toBe(0);
    expect(data.goal.status).toBe("active");
  });
});

describe("POST /api/goals - savingsAccountId (Phase B1 savings roadmap)", () => {
  let userId: number;
  let accountId: number;
  let otherUserAccountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-ROUTE-SAVINGS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({
      data: { userId, name: "پس‌انداز تست روت", type: "savings", initialBalance: 0 },
    });
    accountId = account.id;

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-ROUTE-SAVINGS-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUser.id, name: "حساب کاربر دیگر", type: "savings", initialBalance: 0 },
    });
    otherUserAccountId = otherAccount.id;
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("creates a goal linked to the caller's own account (201)", async () => {
    const res = await POST(
      makeRequest({
        name: "هدف مرتبط",
        category: "device",
        targetAmount: 1_000_000,
        deadline: daysFromNow(30),
        savingsAccountId: accountId,
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.goal.savingsAccountId).toBe(accountId);
  });

  it("rejects a savingsAccountId that doesn't belong to the caller (404)", async () => {
    const res = await POST(
      makeRequest({
        name: "تلاش نامعتبر",
        category: "device",
        targetAmount: 1_000_000,
        deadline: daysFromNow(30),
        savingsAccountId: otherUserAccountId,
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/goals", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-GET-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("requires auth (401)", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the user's own goals, each with a computed feasibility", async () => {
    await prisma.goal.create({
      data: { userId, name: "خودرو", category: "car", targetAmount: 500_000_000, deadline: new Date(daysFromNow(365)) },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.goals)).toBe(true);
    expect(data.goals.length).toBeGreaterThan(0);
    const goal = data.goals.find((g: { name: string }) => g.name === "خودرو");
    expect(goal).toBeDefined();
    expect(goal.feasibility).toBeDefined();
    expect(typeof goal.feasibility.feasibilityStatus).toBe("string");
  });
});
