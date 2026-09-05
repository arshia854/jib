import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { PATCH, DELETE } from "@/app/api/goals/[id]/route";
import { MAX_NAME_LENGTH, MAX_GOAL_TARGET_AMOUNT } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makePatchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/goals/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

describe("PATCH/DELETE /api/goals/[id]", () => {
  let userId: number;
  let otherUserId: number;
  let goalId: number;
  let otherUsersGoalId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-ID-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-GOALS-ID-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    otherUserId = otherUser.id;

    mockedGetSession.mockResolvedValue(asSession(userId));

    const goal = await prisma.goal.create({
      data: { userId, name: "مک‌بوک", category: "device", targetAmount: 60_000_000, deadline: daysFromNow(180) },
    });
    goalId = goal.id;

    const otherGoal = await prisma.goal.create({
      data: {
        userId: otherUserId,
        name: "هدف کاربر دیگر",
        category: "other",
        targetAmount: 1_000_000,
        deadline: daysFromNow(90),
      },
    });
    otherUsersGoalId = otherGoal.id;
  });

  afterAll(async () => {
    await prisma.goal.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it("rejects a name over MAX_NAME_LENGTH (400) and leaves the row untouched", async () => {
    const res = await PATCH(makePatchRequest({ name: "ب".repeat(MAX_NAME_LENGTH + 1) }), {
      params: Promise.resolve({ id: String(goalId) }),
    });
    expect(res.status).toBe(400);
    const untouched = await prisma.goal.findUnique({ where: { id: goalId } });
    expect(untouched?.name).toBe("مک‌بوک");
  });

  it("rejects a targetAmount over MAX_GOAL_TARGET_AMOUNT (400)", async () => {
    const res = await PATCH(makePatchRequest({ targetAmount: MAX_GOAL_TARGET_AMOUNT + 1 }), {
      params: Promise.resolve({ id: String(goalId) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status (400)", async () => {
    const res = await PATCH(makePatchRequest({ status: "not-a-real-status" }), {
      params: Promise.resolve({ id: String(goalId) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable deadline (400)", async () => {
    const res = await PATCH(makePatchRequest({ deadline: "not-a-date" }), {
      params: Promise.resolve({ id: String(goalId) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid partial update (200)", async () => {
    const res = await PATCH(makePatchRequest({ status: "achieved" }), { params: Promise.resolve({ id: String(goalId) }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.goal.status).toBe("achieved");
  });

  it("PATCH scopes by ownership - another user's goal is not found (404), not updated", async () => {
    const res = await PATCH(makePatchRequest({ status: "abandoned" }), {
      params: Promise.resolve({ id: String(otherUsersGoalId) }),
    });
    expect(res.status).toBe(404);
    const untouched = await prisma.goal.findUnique({ where: { id: otherUsersGoalId } });
    expect(untouched?.status).toBe("active");
  });

  it("DELETE scopes by ownership - another user's goal is not found (404), not deleted", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/goals/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(otherUsersGoalId) }),
    });
    expect(res.status).toBe(404);
    const stillThere = await prisma.goal.findUnique({ where: { id: otherUsersGoalId } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE removes the caller's own goal (200)", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/goals/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(goalId) }),
    });
    expect(res.status).toBe(200);
    const deleted = await prisma.goal.findUnique({ where: { id: goalId } });
    expect(deleted).toBeNull();
  });
});
