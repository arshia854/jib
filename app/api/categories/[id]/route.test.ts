import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { PATCH } from "@/app/api/categories/[id]/route";
import { MAX_NAME_LENGTH, MAX_ICON_LENGTH } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/categories/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("PATCH /api/categories/[id] - length limits", () => {
  let userId: number;
  let categoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-CATEGORIES-ID-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const category = await prisma.category.create({
      data: { userId, name: "دسته اولیه", icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects a name over MAX_NAME_LENGTH (400) and leaves the row untouched", async () => {
    const res = await PATCH(makeRequest({ name: "ت".repeat(MAX_NAME_LENGTH + 1) }), {
      params: Promise.resolve({ id: String(categoryId) }),
    });
    expect(res.status).toBe(400);
    const untouched = await prisma.category.findUnique({ where: { id: categoryId } });
    expect(untouched?.name).toBe("دسته اولیه");
  });

  it("rejects an icon over MAX_ICON_LENGTH (400)", async () => {
    const res = await PATCH(makeRequest({ icon: "🧪".repeat(MAX_ICON_LENGTH + 1) }), {
      params: Promise.resolve({ id: String(categoryId) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a name exactly at MAX_NAME_LENGTH (200)", async () => {
    const name = "ث".repeat(MAX_NAME_LENGTH);
    const res = await PATCH(makeRequest({ name }), { params: Promise.resolve({ id: String(categoryId) }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category.name).toBe(name);
  });
});
