import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { PATCH, DELETE } from "@/app/api/savings-strategies/[id]/route";

const mockedGetSession = vi.mocked(getSession);

function makePatchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/savings-strategies/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("PATCH/DELETE /api/savings-strategies/[id]", () => {
  let userId: number;
  let otherUserId: number;
  let strategyId: number;
  let otherUsersStrategyId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-STRATEGIES-ID-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: {
        phoneNumber: `TEST-SAVINGS-STRATEGIES-ID-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    otherUserId = otherUser.id;

    mockedGetSession.mockResolvedValue(asSession(userId));

    const strategy = await prisma.savingsStrategy.create({
      data: { userId, formulaType: "fifty_thirty_twenty", targetPercent: 20 },
    });
    strategyId = strategy.id;

    const otherStrategy = await prisma.savingsStrategy.create({
      data: { userId: otherUserId, formulaType: "roundup", targetAmount: 10_000 },
    });
    otherUsersStrategyId = otherStrategy.id;
  });

  afterAll(async () => {
    await prisma.savingsStrategy.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("rejects an invalid formulaType (400)", async () => {
    const res = await PATCH(makePatchRequest({ formulaType: "not-a-real-formula" }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status (400)", async () => {
    const res = await PATCH(makePatchRequest({ status: "not-a-real-status" }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(400);
  });

  it("allows updating status alone without resending targetPercent/targetAmount (200)", async () => {
    const res = await PATCH(makePatchRequest({ status: "paused" }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.strategy.status).toBe("paused");
    expect(data.strategy.targetPercent).toBe(20);
  });

  it("rejects setting both targetPercent and targetAmount in the same call (400)", async () => {
    const res = await PATCH(makePatchRequest({ targetPercent: 30, targetAmount: 100_000 }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(400);
  });

  it("switches to targetAmount and clears targetPercent (200)", async () => {
    const res = await PATCH(makePatchRequest({ targetAmount: 250_000 }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.strategy.targetAmount).toBe(250_000);
    expect(data.strategy.targetPercent).toBeNull();
  });

  it("PATCH scopes by ownership - another user's strategy is not found (404), not updated", async () => {
    const res = await PATCH(makePatchRequest({ status: "abandoned" }), {
      params: Promise.resolve({ id: String(otherUsersStrategyId) }),
    });
    expect(res.status).toBe(404);
    const untouched = await prisma.savingsStrategy.findUnique({ where: { id: otherUsersStrategyId } });
    expect(untouched?.status).toBe("active");
  });

  it("returns 409 with the Persian message when reactivating a paused strategy would duplicate an active one of the same formulaType", async () => {
    const paused = await prisma.savingsStrategy.create({
      data: { userId, formulaType: "pay_yourself_first", targetPercent: 10, status: "paused" },
    });
    await prisma.savingsStrategy.create({
      data: { userId, formulaType: "pay_yourself_first", targetPercent: 15, status: "active" },
    });

    const res = await PATCH(makePatchRequest({ status: "active" }), {
      params: Promise.resolve({ id: String(paused.id) }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("شما همین حالا یک استراتژی «فعال» از این نوع دارید. اول اون رو متوقف یا حذف کن.");
    const untouched = await prisma.savingsStrategy.findUnique({ where: { id: paused.id } });
    expect(untouched?.status).toBe("paused");
  });

  it("DELETE scopes by ownership - another user's strategy is not found (404), not deleted", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/savings-strategies/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(otherUsersStrategyId) }),
    });
    expect(res.status).toBe(404);
    const stillThere = await prisma.savingsStrategy.findUnique({ where: { id: otherUsersStrategyId } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE removes the caller's own strategy (200)", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/savings-strategies/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(strategyId) }),
    });
    expect(res.status).toBe(200);
    const deleted = await prisma.savingsStrategy.findUnique({ where: { id: strategyId } });
    expect(deleted).toBeNull();
  });
});
