import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveNewCategoryIcon } from "@/lib/categories";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/transactions/[id]/suggested-category/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transactions/1/suggested-category", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asSession(userId: number) {
  return { userId, onboarded: true, role: "user" as const };
}

describe("POST /api/transactions/[id]/suggested-category", () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;
  let categoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-SUGGESTED-CATEGORY-ROUTE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    });
    userId = user.id;

    const otherUser = await prisma.user.create({
      data: {
        phoneNumber: `TEST-SUGGESTED-CATEGORY-ROUTE-OTHER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    otherUserId = otherUser.id;

    const account = await prisma.financeAccount.create({ data: { userId, name: "حساب تست", type: "cash" } });
    accountId = account.id;

    const category = await prisma.category.create({
      data: { userId, name: "سایر هزینه‌ها", icon: "🧪", color: "#64748B", type: "expense" },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    // Children first: Category.parent uses onDelete: Restrict.
    await prisma.category.deleteMany({ where: { userId: { in: [userId, otherUserId] }, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  async function createSuggestedTransaction(overrides: Partial<{ suggestedCategoryName: string | null }> = {}) {
    return prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId,
        amount: 140000,
        type: "expense",
        rawInput: "۱۴۰ سیگار",
        suggestedCategoryName: "دخانیات تست پیشنهاد",
        suggestedCategoryParentName: null,
        suggestedCategoryReason: "خرید سیگار",
        suggestedCategoryIcon: "🚬",
        ...overrides,
      },
    });
  }

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ action: "dismiss" }), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid id (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(makeRequest({ action: "dismiss" }), { params: Promise.resolve({ id: "not-a-number" }) });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid action (400)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const txn = await createSuggestedTransaction();
    const res = await POST(makeRequest({ action: "delete" }), { params: Promise.resolve({ id: String(txn.id) }) });
    expect(res.status).toBe(400);
  });

  describe("action: dismiss", () => {
    it("clears the suggestion without touching categoryId (200)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const txn = await createSuggestedTransaction();

      const res = await POST(makeRequest({ action: "dismiss" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(200);

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.categoryId).toBe(categoryId);
      expect(updated?.suggestedCategoryName).toBeNull();
    });

    it("404s for a transaction with no standing suggestion", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const txn = await createSuggestedTransaction({ suggestedCategoryName: null });

      const res = await POST(makeRequest({ action: "dismiss" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(404);
    });

    it("404s (not 200) when a user targets another user's transaction, and it's left untouched", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const txn = await createSuggestedTransaction();
      mockedGetSession.mockResolvedValue(asSession(otherUserId));

      const res = await POST(makeRequest({ action: "dismiss" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(404);

      const untouched = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(untouched?.suggestedCategoryName).toBe("دخانیات تست پیشنهاد");
    });
  });

  describe("action: accept", () => {
    it("creates a genuinely new category (forced icon) and applies it (200)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const name = `دخانیات تست پذیرش ${Date.now()}`;
      const txn = await createSuggestedTransaction({ suggestedCategoryName: name });

      const res = await POST(makeRequest({ action: "accept" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.category.name).toBe(name);
      expect(data.category.icon).toBe(resolveNewCategoryIcon(name));

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.categoryId).toBe(data.category.id);
      expect(updated?.suggestedCategoryName).toBeNull();
      expect(updated?.suggestedCategoryParentName).toBeNull();
      expect(updated?.suggestedCategoryReason).toBeNull();
      expect(updated?.suggestedCategoryIcon).toBeNull();
    });

    it("dedups onto an existing exact-name match instead of creating a duplicate", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const existing = await prisma.category.create({
        data: { userId, name: "سوپرمارکت تست پذیرش پیشنهاد", icon: "🛒", color: "#10B981", type: "expense" },
      });
      const txn = await createSuggestedTransaction({ suggestedCategoryName: existing.name });
      const countBefore = await prisma.category.count({ where: { userId } });

      const res = await POST(makeRequest({ action: "accept" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.category.id).toBe(existing.id);
      expect(await prisma.category.count({ where: { userId } })).toBe(countBefore);

      const updated = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(updated?.categoryId).toBe(existing.id);
    });

    it("404s for a transaction with no standing suggestion", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const txn = await createSuggestedTransaction({ suggestedCategoryName: null });

      const res = await POST(makeRequest({ action: "accept" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(404);
    });

    it("404s (not 200) when a user targets another user's transaction, and it's left untouched", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const txn = await createSuggestedTransaction();
      mockedGetSession.mockResolvedValue(asSession(otherUserId));

      const res = await POST(makeRequest({ action: "accept" }), { params: Promise.resolve({ id: String(txn.id) }) });
      expect(res.status).toBe(404);

      const untouched = await prisma.transaction.findUnique({ where: { id: txn.id } });
      expect(untouched?.categoryId).toBe(categoryId);
      expect(untouched?.suggestedCategoryName).toBe("دخانیات تست پیشنهاد");
    });
  });
});
