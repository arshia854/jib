import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { GET } from "@/app/api/savings-strategies/suggestions/route";
import { SAVINGS_STRATEGY_FORMULA_TYPES } from "@/lib/data/savings-strategies";

const mockedGetSession = vi.mocked(getSession);

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("GET /api/savings-strategies/suggestions", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SAVINGS-SUGGESTIONS-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  it("requires auth (401)", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns a profile and one suggestion per formula type for a user with no transaction history", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.profile).toEqual({
      avgIncome: null,
      avgEssentialExpense: null,
      avgDiscretionaryExpense: null,
      avgNetCashFlow: null,
    });
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data.suggestions.map((s: { formulaType: string }) => s.formulaType)).toEqual([
      ...SAVINGS_STRATEGY_FORMULA_TYPES,
    ]);
    // No history yet - every formula except the always-placeholder roundup
    // (and the formula-less custom) should report hasData: false.
    const roundup = data.suggestions.find((s: { formulaType: string }) => s.formulaType === "roundup");
    expect(roundup.hasData).toBe(false);
    expect(roundup.targetAmount).toBeGreaterThan(0);
  });
});
