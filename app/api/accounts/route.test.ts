import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/accounts/route";
import { MAX_NAME_LENGTH, MAX_ACCOUNT_BALANCE_MAGNITUDE } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("POST /api/accounts - length limits", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ACCOUNTS-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects a name over MAX_NAME_LENGTH (400)", async () => {
    const res = await POST(makeRequest({ name: "الف".repeat(MAX_NAME_LENGTH + 1), type: "cash" }));
    expect(res.status).toBe(400);
  });

  it("accepts a name exactly at MAX_NAME_LENGTH (201)", async () => {
    const name = "ب".repeat(MAX_NAME_LENGTH);
    const res = await POST(makeRequest({ name, type: "cash" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.account.name).toBe(name);
  });

  it("rejects an initialBalance whose magnitude exceeds MAX_ACCOUNT_BALANCE_MAGNITUDE (400), both signs", async () => {
    const tooPositive = await POST(
      makeRequest({ name: "حساب تست", type: "cash", initialBalance: MAX_ACCOUNT_BALANCE_MAGNITUDE + 1 })
    );
    expect(tooPositive.status).toBe(400);
    const tooNegative = await POST(
      makeRequest({ name: "حساب تست", type: "cash", initialBalance: -(MAX_ACCOUNT_BALANCE_MAGNITUDE + 1) })
    );
    expect(tooNegative.status).toBe(400);
  });

  it("accepts an initialBalance exactly at MAX_ACCOUNT_BALANCE_MAGNITUDE, both signs (201)", async () => {
    const positive = await POST(
      makeRequest({ name: "حساب تست مثبت", type: "cash", initialBalance: MAX_ACCOUNT_BALANCE_MAGNITUDE })
    );
    expect(positive.status).toBe(201);
    const positiveData = await positive.json();
    expect(positiveData.account.initialBalance).toBe(MAX_ACCOUNT_BALANCE_MAGNITUDE);

    const negative = await POST(
      makeRequest({ name: "حساب تست منفی", type: "cash", initialBalance: -MAX_ACCOUNT_BALANCE_MAGNITUDE })
    );
    expect(negative.status).toBe(201);
    const negativeData = await negative.json();
    expect(negativeData.account.initialBalance).toBe(-MAX_ACCOUNT_BALANCE_MAGNITUDE);
  });
});
