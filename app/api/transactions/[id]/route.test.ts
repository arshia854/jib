import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { PATCH, DELETE } from "@/app/api/transactions/[id]/route";
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from "@/lib/limits";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transactions/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("PATCH /api/transactions/[id] - length limits", () => {
  let userId: number;
  let accountId: number;
  let categoryName: string;
  let transactionId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ID-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    mockedGetSession.mockResolvedValue(asSession(userId));

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;

    categoryName = "دسته تست ویرایش";
    const category = await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: category.id,
        amount: 10000,
        type: "expense",
        rawInput: "تراکنش اولیه",
      },
    });
    transactionId = txn.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return { amount: 20000, type: "expense", category: categoryName, accountId, ...overrides };
  }

  it("rejects a description over MAX_DESCRIPTION_LENGTH (400)", async () => {
    const res = await PATCH(makeRequest(validBody({ description: "ب".repeat(MAX_DESCRIPTION_LENGTH + 1) })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a category name over MAX_NAME_LENGTH (400)", async () => {
    const res = await PATCH(makeRequest(validBody({ category: "پ".repeat(MAX_NAME_LENGTH + 1) })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a description exactly at MAX_DESCRIPTION_LENGTH (200)", async () => {
    const description = "ث".repeat(MAX_DESCRIPTION_LENGTH);
    const res = await PATCH(makeRequest(validBody({ description })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transaction.description.length).toBe(MAX_DESCRIPTION_LENGTH);
  });
});

// Transactions checklist (docs/roadmap-status.md, Phase 16): "malformed
// input" and "ownership" at the route level - the length-limits block above
// only covers the two string-length fields; this route's numeric/enum
// validation and error->status mapping (TransactionNotFoundError,
// InvalidCategoryError, InvalidAccountError) had no direct test before this
// session.
describe("PATCH /api/transactions/[id] - malformed input, not-found, ownership", () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;
  let categoryName: string;
  let transactionId: number;
  let otherUsersTransactionId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ID-ROUTE-MALFORMED-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ID-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    otherUserId = otherUser.id;

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست نامعتبر", type: "cash" } });
    accountId = account.id;
    const otherAccount = await prisma.financeAccount.create({
      data: { userId: otherUserId, name: "حساب کاربر دیگر", type: "cash" },
    });

    categoryName = "دسته تست ویرایش نامعتبر";
    const category = await prisma.category.create({
      data: { userId, name: categoryName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    const otherCategory = await prisma.category.create({
      data: { userId: otherUserId, name: "دسته کاربر دیگر", icon: "🧪", color: "#3B82F6", type: "expense" },
    });

    const txn = await prisma.transaction.create({
      data: { userId, accountId, categoryId: category.id, amount: 10000, type: "expense", rawInput: "تراکنش اولیه" },
    });
    transactionId = txn.id;

    const otherTxn = await prisma.transaction.create({
      data: {
        userId: otherUserId,
        accountId: otherAccount.id,
        categoryId: otherCategory.id,
        amount: 5000,
        type: "expense",
        rawInput: "تراکنش کاربر دیگر",
      },
    });
    otherUsersTransactionId = otherTxn.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.category.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return { amount: 20000, type: "expense", category: categoryName, accountId, ...overrides };
  }

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await PATCH(makeRequest(validBody()), { params: Promise.resolve({ id: String(transactionId) }) });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid id (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody()), { params: Promise.resolve({ id: "not-a-number" }) });
    expect(res.status).toBe(400);
  });

  it("rejects a zero/negative amount (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody({ amount: 0 })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an amount over MAX_TRANSACTION_AMOUNT (400), leaving the row untouched", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody({ amount: 99999999999999 })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
    const untouched = await prisma.transaction.findUnique({ where: { id: transactionId } });
    expect(untouched?.amount).toBe(10000);
  });

  it("rejects an invalid type (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody({ type: "savings" })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a transaction id that doesn't exist", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody()), { params: Promise.resolve({ id: "999999994" }) });
    expect(res.status).toBe(404);
  });

  it("404s (not 200) when a user targets another user's transaction, and leaves it untouched", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody()), {
      params: Promise.resolve({ id: String(otherUsersTransactionId) }),
    });
    expect(res.status).toBe(404);

    const untouched = await prisma.transaction.findUnique({ where: { id: otherUsersTransactionId } });
    expect(untouched?.amount).toBe(5000);
  });

  it("400s (InvalidCategoryError) for a category name that doesn't exist for this user", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody({ category: "دسته‌ای که وجود ندارد" })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("400s (InvalidAccountError) for an accountId that doesn't belong to this user", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const otherAccount = await prisma.financeAccount.findFirst({ where: { userId: otherUserId } });
    const res = await PATCH(makeRequest(validBody({ accountId: otherAccount!.id })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(400);
  });

  it("a well-formed request updates the transaction (200)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await PATCH(makeRequest(validBody({ amount: 77777 })), {
      params: Promise.resolve({ id: String(transactionId) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.transaction.amount).toBe(77777);
  });
});

// Transactions checklist: DELETE had zero test coverage at the route level
// before this session (lib/data/transactions.test.ts covers
// deleteTransaction() directly, but not this route's own auth/validation/
// error->status wiring).
describe("DELETE /api/transactions/[id]", () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;
  let categoryId: number;

  function makeDeleteRequest(): NextRequest {
    return new NextRequest("http://localhost/api/transactions/1", { method: "DELETE" });
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSACTIONS-ID-ROUTE-DELETE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;
    const otherUser = await prisma.user.create({
      data: {
        phoneNumber: `TEST-TRANSACTIONS-ID-ROUTE-DELETE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    otherUserId = otherUser.id;

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست حذف", type: "cash" } });
    accountId = account.id;
    const category = await prisma.category.create({
      data: { userId, name: "دسته تست حذف", icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid id (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "not-a-number" }) });
    expect(res.status).toBe(400);
  });

  it("404s for a transaction id that doesn't exist", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: "999999993" }) });
    expect(res.status).toBe(404);
  });

  it("404s (not 200) when a user targets another user's transaction, and it still exists after", async () => {
    const other = await prisma.transaction.create({
      data: {
        userId: otherUserId,
        accountId: (
          await prisma.financeAccount.create({ data: { userId: otherUserId, name: "حساب کاربر دیگر", type: "cash" } })
        ).id,
        categoryId: (
          await prisma.category.create({
            data: { userId: otherUserId, name: "دسته کاربر دیگر حذف", icon: "🧪", color: "#3B82F6", type: "expense" },
          })
        ).id,
        amount: 8000,
        type: "expense",
        rawInput: "تراکنش کاربر دیگر",
      },
    });
    mockedGetSession.mockResolvedValue(asSession(userId));

    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: String(other.id) }) });
    expect(res.status).toBe(404);
    expect(await prisma.transaction.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("deletes the owner's own transaction (200, gone from the DB)", async () => {
    const txn = await prisma.transaction.create({
      data: { userId, accountId, categoryId, amount: 12345, type: "expense", rawInput: "تراکنش قابل حذف" },
    });
    mockedGetSession.mockResolvedValue(asSession(userId));

    const res = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: String(txn.id) }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
    expect(await prisma.transaction.findUnique({ where: { id: txn.id } })).toBeNull();
  });
});
