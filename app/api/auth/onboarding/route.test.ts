import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
  setOnboarded: vi.fn(async () => {}),
}));

import { getSession, setOnboarded } from "@/lib/auth/session";
import { POST } from "@/app/api/auth/onboarding/route";

const mockedGetSession = vi.mocked(getSession);
const mockedSetOnboarded = vi.mocked(setOnboarded);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number, onboarded: boolean) {
  return { userId, onboarded, role: "user" as const };
}

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-ONBOARDING-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  return user.id;
}

const cleanupUserIds: number[] = [];

afterAll(async () => {
  if (cleanupUserIds.length) {
    await prisma.financeAccount.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.category.deleteMany({ where: { userId: { in: cleanupUserIds }, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedSetOnboarded.mockClear();
});

describe("POST /api/auth/onboarding", () => {
  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ name: "علی", age: 25 }));
    expect(res.status).toBe(401);
    expect(mockedSetOnboarded).not.toHaveBeenCalled();
  });

  describe("validation", () => {
    it("rejects a missing name (400)", async () => {
      const userId = await createTestUser("missing-name");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      const res = await POST(makeRequest({ age: 25 }));
      expect(res.status).toBe(400);
    });

    it("rejects a name over 60 characters (400)", async () => {
      const userId = await createTestUser("long-name");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      const res = await POST(makeRequest({ name: "ا".repeat(61), age: 25 }));
      expect(res.status).toBe(400);
    });

    it("rejects a non-integer age (400)", async () => {
      const userId = await createTestUser("bad-age-type");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      const res = await POST(makeRequest({ name: "علی", age: "adult" }));
      expect(res.status).toBe(400);
    });

    it("rejects an age below 10 (400)", async () => {
      const userId = await createTestUser("too-young");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      const res = await POST(makeRequest({ name: "علی", age: 9 }));
      expect(res.status).toBe(400);
    });

    it("rejects an age above 120 (400)", async () => {
      const userId = await createTestUser("too-old");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      const res = await POST(makeRequest({ name: "علی", age: 121 }));
      expect(res.status).toBe(400);
    });
  });

  describe("first-time onboarding (session.onboarded === false)", () => {
    it("updates the user, seeds default accounts/categories, marks onboarded, and returns ok", async () => {
      const userId = await createTestUser("first-time");
      cleanupUserIds.push(userId);
      mockedGetSession.mockResolvedValue(asSession(userId, false));

      const res = await POST(makeRequest({ name: "مریم", age: 30 }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.name).toBe("مریم");
      expect(user?.age).toBe(30);

      const accounts = await prisma.financeAccount.count({ where: { userId } });
      expect(accounts).toBeGreaterThan(0);
      const categories = await prisma.category.count({ where: { userId } });
      expect(categories).toBeGreaterThan(0);

      expect(mockedSetOnboarded).toHaveBeenCalledTimes(1);
    });
  });

  describe("already-onboarded user (session.onboarded === true)", () => {
    it("updates the user's name/age but does not reseed defaults a second time", async () => {
      const userId = await createTestUser("already-onboarded");
      cleanupUserIds.push(userId);

      // Onboard once for real first, so there's an existing baseline to
      // prove a second call doesn't duplicate.
      mockedGetSession.mockResolvedValue(asSession(userId, false));
      await POST(makeRequest({ name: "رضا", age: 40 }));
      const accountsAfterFirst = await prisma.financeAccount.count({ where: { userId } });
      const categoriesAfterFirst = await prisma.category.count({ where: { userId } });
      mockedSetOnboarded.mockClear();

      // Now call again as an already-onboarded session (e.g. editing name
      // in settings, which reuses this same endpoint).
      mockedGetSession.mockResolvedValue(asSession(userId, true));
      const res = await POST(makeRequest({ name: "رضا احمدی", age: 41 }));
      expect(res.status).toBe(200);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.name).toBe("رضا احمدی");
      expect(user?.age).toBe(41);

      const accountsAfterSecond = await prisma.financeAccount.count({ where: { userId } });
      const categoriesAfterSecond = await prisma.category.count({ where: { userId } });
      expect(accountsAfterSecond).toBe(accountsAfterFirst);
      expect(categoriesAfterSecond).toBe(categoriesAfterFirst);

      // setOnboarded() is still called - it's an idempotent "mark as
      // onboarded" trigger, cheap to call again even when already true.
      expect(mockedSetOnboarded).toHaveBeenCalledTimes(1);
    });
  });
});
