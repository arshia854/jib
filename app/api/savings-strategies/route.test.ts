import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET, POST } from "@/app/api/savings-strategies/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/savings-strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("POST /api/savings-strategies - validation", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects a formulaType outside the fixed enum (400)", async () => {
    const res = await POST(makeRequest({ formulaType: "not-a-real-formula", targetPercent: 20 }));
    expect(res.status).toBe(400);
  });

  it("rejects when both targetPercent and targetAmount are set (400)", async () => {
    const res = await POST(makeRequest({ formulaType: "custom", targetPercent: 20, targetAmount: 100_000 }));
    expect(res.status).toBe(400);
  });

  it("rejects when neither targetPercent nor targetAmount is set (400)", async () => {
    const res = await POST(makeRequest({ formulaType: "custom" }));
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range targetPercent (400)", async () => {
    const res = await POST(makeRequest({ formulaType: "fifty_thirty_twenty", targetPercent: 150 }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive targetAmount (400)", async () => {
    const res = await POST(makeRequest({ formulaType: "pay_yourself_first", targetAmount: 0 }));
    expect(res.status).toBe(400);
  });

  it("creates a valid strategy with targetPercent (201), status defaulting to active", async () => {
    const res = await POST(makeRequest({ formulaType: "fifty_thirty_twenty", targetPercent: 20 }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.strategy.formulaType).toBe("fifty_thirty_twenty");
    expect(data.strategy.targetPercent).toBe(20);
    expect(data.strategy.targetAmount).toBeNull();
    expect(data.strategy.status).toBe("active");
  });

  it("creates a valid strategy with targetAmount (201)", async () => {
    const res = await POST(makeRequest({ formulaType: "pay_yourself_first", targetAmount: 500_000, status: "paused" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.strategy.targetAmount).toBe(500_000);
    expect(data.strategy.targetPercent).toBeNull();
    expect(data.strategy.status).toBe("paused");
  });
});

describe("POST /api/savings-strategies - duplicate active strategy", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-DUP-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("returns 409 with the Persian message when an active strategy of that formulaType already exists, and creates nothing", async () => {
    const first = await POST(makeRequest({ formulaType: "leftover", targetAmount: 100_000 }));
    expect(first.status).toBe(201);

    const second = await POST(makeRequest({ formulaType: "leftover", targetAmount: 200_000 }));
    expect(second.status).toBe(409);
    const data = await second.json();
    expect(data.error).toBe("شما همین حالا یک استراتژی «فعال» از این نوع دارید. اول اون رو متوقف یا حذف کن.");

    expect(await prisma.savingsStrategy.count({ where: { userId, formulaType: "leftover" } })).toBe(1);
  });
});

describe("GET /api/savings-strategies", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-GET-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("requires auth (401)", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the user's own strategies", async () => {
    await prisma.savingsStrategy.create({ data: { userId, formulaType: "roundup", targetPercent: 5 } });

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.strategies)).toBe(true);
    const strategy = data.strategies.find((s: { formulaType: string }) => s.formulaType === "roundup");
    expect(strategy).toBeDefined();
  });
});
