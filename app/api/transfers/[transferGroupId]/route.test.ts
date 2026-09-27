import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { DELETE } from "@/app/api/transfers/[transferGroupId]/route";
import { createTransfer } from "@/lib/data/transfers";

const mockedGetSession = vi.mocked(getSession);

const TRANSFER_CATEGORY_NAME = "انتقال بین حساب‌ها";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/transfers/x", { method: "DELETE" });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("DELETE /api/transfers/[transferGroupId]", () => {
  let userId: number;
  let otherUserId: number;
  let fromAccountId: number;
  let toAccountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-DEL-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-DEL-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    otherUserId = otherUser.id;

    const fromAccount = await prisma.financeAccount.create({ data: { userId, name: "مبدا", type: "cash" } });
    fromAccountId = fromAccount.id;
    const toAccount = await prisma.financeAccount.create({ data: { userId, name: "مقصد", type: "bank" } });
    toAccountId = toAccount.id;

    await prisma.category.create({
      data: { userId, name: TRANSFER_CATEGORY_NAME, icon: "🔁", color: "#94A3B8", type: "expense", isTransfer: true },
    });
    await prisma.category.create({
      data: { userId, name: TRANSFER_CATEGORY_NAME, icon: "🔁", color: "#10B981", type: "income", isTransfer: true },
    });
  }, 20000);

  afterAll(async () => {
    const ids = [userId, otherUserId];
    await prisma.transaction.deleteMany({ where: { userId: { in: ids } } });
    await prisma.category.deleteMany({ where: { userId: { in: ids } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }, 20000);

  it("returns 401 when unauthenticated", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await DELETE(makeRequest(), { params: Promise.resolve({ transferGroupId: "whatever" }) });
    expect(res.status).toBe(401);
  });

  it("deletes both rows of an existing transfer (200) and they're gone afterward", async () => {
    const created = await createTransfer(userId, { fromAccountId, toAccountId, amount: 4000 });

    const res = await DELETE(makeRequest(), { params: Promise.resolve({ transferGroupId: created.transferGroupId }) });
    expect(res.status).toBe(200);

    const remaining = await prisma.transaction.findMany({
      where: { userId, transferGroupId: created.transferGroupId },
    });
    expect(remaining).toHaveLength(0);
  });

  it("returns 404 for an unknown transferGroupId", async () => {
    const res = await DELETE(makeRequest(), { params: Promise.resolve({ transferGroupId: "no-such-id" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 when another user tries to delete this user's transfer, and leaves it intact", async () => {
    const created = await createTransfer(userId, { fromAccountId, toAccountId, amount: 6000 });
    mockedGetSession.mockResolvedValueOnce(asSession(otherUserId));

    const res = await DELETE(makeRequest(), { params: Promise.resolve({ transferGroupId: created.transferGroupId }) });
    expect(res.status).toBe(404);

    const remaining = await prisma.transaction.findMany({
      where: { userId, transferGroupId: created.transferGroupId },
    });
    expect(remaining).toHaveLength(2);
  });
});
