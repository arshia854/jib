import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/facts/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/facts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

async function createTestUser(label: string) {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-FACTS-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  return user.id;
}

async function cleanupUser(userId: number) {
  await prisma.userFact.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("POST /api/facts", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ key: "employment_status", value: "employed" }));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown key (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(makeRequest({ key: "favorite_color", value: "blue" }));
    expect(res.status).toBe(400);
  });

  it("rejects a value outside the key's allowed vocabulary (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(makeRequest({ key: "account_structure", value: "many_accounts" }));
    expect(res.status).toBe(400);
  });

  it("saves a valid (key, value) as a user_stated fact and is idempotent on re-answer", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));

    const res = await POST(makeRequest({ key: "employment_status", value: "student" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.fact.key).toBe("employment_status");
    expect(data.fact.value).toBe("student");
    expect(data.fact.source).toBe("user_stated");

    // Changing the answer later (e.g. from the Settings page) updates the
    // same row rather than creating a second one - UserFact's @@unique([userId, key]).
    const res2 = await POST(makeRequest({ key: "employment_status", value: "business_owner" }));
    expect(res2.status).toBe(200);

    const rows = await prisma.userFact.findMany({ where: { userId, key: "employment_status" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("business_owner");
  });
});
