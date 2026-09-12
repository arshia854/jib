import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/transfers/route";
import { MAX_TRANSACTION_AMOUNT } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

const TRANSFER_CATEGORY_NAME = "انتقال بین حساب‌ها";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transfers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("POST /api/transfers", () => {
  let userId: number;
  let otherUserId: number;
  let fromAccountId: number;
  let toAccountId: number;
  let otherUserAccountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    otherUserId = otherUser.id;

    const fromAccount = await prisma.financeAccount.create({
      data: { userId, name: "مبدا", type: "cash", initialBalance: 1_000_000 },
    });
    fromAccountId = fromAccount.id;
    const toAccount = await prisma.financeAccount.create({ data: { userId, name: "مقصد", type: "bank" } });
    toAccountId = toAccount.id;

    const otherUserAccount = await prisma.financeAccount.create({
      data: { userId: otherUserId, name: "حساب کاربر دیگر", type: "cash" },
    });
    otherUserAccountId = otherUserAccount.id;

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
    const res = await POST(makeRequest({ fromAccountId, toAccountId, amount: 1000 }));
    expect(res.status).toBe(401);
  });

  it("creates a transfer (201) and persists both linked rows", async () => {
    const res = await POST(makeRequest({ fromAccountId, toAccountId, amount: 10000, note: "یادداشت تست" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.expenseTransaction.type).toBe("expense");
    expect(data.incomeTransaction.type).toBe("income");
    expect(data.expenseTransaction.transferGroupId).toBe(data.transferGroupId);

    const rows = await prisma.transaction.findMany({ where: { userId, transferGroupId: data.transferGroupId } });
    expect(rows).toHaveLength(2);
  });

  it("rejects a non-integer accountId (400)", async () => {
    const res = await POST(makeRequest({ fromAccountId: "abc", toAccountId, amount: 1000 }));
    expect(res.status).toBe(400);
  });

  it("rejects an amount over MAX_TRANSACTION_AMOUNT (400)", async () => {
    const res = await POST(makeRequest({ fromAccountId, toAccountId, amount: MAX_TRANSACTION_AMOUNT + 1 }));
    expect(res.status).toBe(400);
  });

  it("rejects amount <= 0 (400)", async () => {
    const res = await POST(makeRequest({ fromAccountId, toAccountId, amount: 0 }));
    expect(res.status).toBe(400);
  });

  it("maps SameAccountTransferError to 400", async () => {
    const res = await POST(makeRequest({ fromAccountId, toAccountId: fromAccountId, amount: 1000 }));
    expect(res.status).toBe(400);
  });

  it("maps AccountNotFoundError (cross-user account) to 404", async () => {
    const res = await POST(makeRequest({ fromAccountId: otherUserAccountId, toAccountId, amount: 1000 }));
    expect(res.status).toBe(404);
  });

  it("maps TransferCategoryMissingError to 409 for a user missing the category pair", async () => {
    const noCatUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-ROUTE-NOCAT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    const accountA = await prisma.financeAccount.create({ data: { userId: noCatUser.id, name: "الف", type: "cash" } });
    const accountB = await prisma.financeAccount.create({ data: { userId: noCatUser.id, name: "ب", type: "bank" } });
    mockedGetSession.mockResolvedValueOnce(asSession(noCatUser.id));

    const res = await POST(makeRequest({ fromAccountId: accountA.id, toAccountId: accountB.id, amount: 1000 }));
    expect(res.status).toBe(409);

    await prisma.financeAccount.deleteMany({ where: { userId: noCatUser.id } });
    await prisma.user.delete({ where: { id: noCatUser.id } });
  });
});
