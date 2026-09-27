import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { PATCH } from "@/app/api/accounts/[id]/route";
import { MAX_NAME_LENGTH, MAX_ACCOUNT_BALANCE_MAGNITUDE } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/accounts/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("PATCH /api/accounts/[id] - length limits", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ACCOUNTS-ID-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب اولیه", type: "cash" },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects a name over MAX_NAME_LENGTH (400) and leaves the row untouched", async () => {
    const res = await PATCH(makeRequest({ name: "ت".repeat(MAX_NAME_LENGTH + 1) }), {
      params: Promise.resolve({ id: String(accountId) }),
    });
    expect(res.status).toBe(400);
    const untouched = await prisma.financeAccount.findUnique({ where: { id: accountId } });
    expect(untouched?.name).toBe("حساب اولیه");
  });

  it("accepts a name exactly at MAX_NAME_LENGTH (200)", async () => {
    const name = "ث".repeat(MAX_NAME_LENGTH);
    const res = await PATCH(makeRequest({ name }), { params: Promise.resolve({ id: String(accountId) }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.name).toBe(name);
  });

  it("silently drops an out-of-range initialBalance (400, no valid field) and leaves the row untouched", async () => {
    const res = await PATCH(makeRequest({ initialBalance: MAX_ACCOUNT_BALANCE_MAGNITUDE + 1 }), {
      params: Promise.resolve({ id: String(accountId) }),
    });
    // No other valid field was sent either, so this hits the existing
    // "no valid field to update" 400 - matching how an invalid `type` is
    // already handled by this same route, not a dedicated error message.
    expect(res.status).toBe(400);
    const untouched = await prisma.financeAccount.findUnique({ where: { id: accountId } });
    expect(untouched?.initialBalance).toBe(0);
  });

  it("accepts an initialBalance exactly at MAX_ACCOUNT_BALANCE_MAGNITUDE (200)", async () => {
    const res = await PATCH(makeRequest({ initialBalance: -MAX_ACCOUNT_BALANCE_MAGNITUDE }), {
      params: Promise.resolve({ id: String(accountId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.account.initialBalance).toBe(-MAX_ACCOUNT_BALANCE_MAGNITUDE);
  });
});
