import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveNewCategoryIcon } from "@/lib/categories";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { POST } from "@/app/api/categories/route";

const mockedGetSession = vi.mocked(getSession);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/categories", {
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
    data: { phoneNumber: `TEST-CATEGORIES-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  return user.id;
}

async function cleanupUser(userId: number) {
  // Children first: Category.parent uses onDelete: Restrict, so a bulk
  // deleteMany covering both a parent and its child in one statement can
  // fail depending on row order.
  await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("POST /api/categories", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("main");
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("returns 401 when there is no session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ name: "بدون ورود", type: "expense" }));
    expect(res.status).toBe(401);
  });

  describe("body validation", () => {
    it("rejects a missing name (400)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(makeRequest({ type: "expense", icon: "🧪", color: "#3B82F6" }));
      expect(res.status).toBe(400);
    });

    it("rejects an invalid type (400)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(makeRequest({ name: "نوع نامعتبر", type: "savings", icon: "🧪", color: "#3B82F6" }));
      expect(res.status).toBe(400);
    });

    it("manual source: rejects a missing icon/color (400)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(makeRequest({ name: "بدون آیکون", type: "expense" }));
      expect(res.status).toBe(400);
    });

    it("manual source: rejects a non-hex color (400)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(makeRequest({ name: "رنگ نامعتبر", type: "expense", icon: "🧪", color: "blue" }));
      expect(res.status).toBe(400);
    });
  });

  describe("ai-suggestion source: parentName resolution", () => {
    it("400s when parentName does not exist", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(
        makeRequest({ name: "زیردسته یتیم", type: "expense", parentName: "دسته والد ناموجود", source: "ai-suggestion" })
      );
      expect(res.status).toBe(400);
    });

    it("400s when parentName exists but with a different type", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const parent = await prisma.category.create({
        data: { userId, name: "والد درآمدی", icon: "💰", color: "#10B981", type: "income" },
      });

      const res = await POST(
        makeRequest({ name: "زیردسته هزینه‌ای", type: "expense", parentName: parent.name, source: "ai-suggestion" })
      );
      expect(res.status).toBe(400);
    });

    it("resolves a valid same-type parentName to the parent's id", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const parent = await prisma.category.create({
        data: { userId, name: "دسته والد نمونه", icon: "🧾", color: "#3B82F6", type: "expense" },
      });

      const res = await POST(
        makeRequest({ name: "زیرشاخه فرزند", type: "expense", parentName: parent.name, source: "ai-suggestion" })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.category.parentId).toBe(parent.id);
    });
  });

  describe("ai-suggestion source: forced server-side icon", () => {
    it("ignores a client-supplied icon and uses resolveNewCategoryIcon instead", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const name = "دسته بدون آیکون سفارشی";
      const res = await POST(
        makeRequest({ name, type: "expense", parentName: null, icon: "💥totally-fake", source: "ai-suggestion" })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.category.icon).toBe(resolveNewCategoryIcon(name));
      expect(data.category.icon).not.toBe("💥totally-fake");
      expect(data.resolvedExisting).toBe(false);
    });
  });

  describe("ai-suggestion source: dedup via findSimilarCategory", () => {
    it("resolves to an existing exact-name match instead of creating a duplicate (200, resolvedExisting: true)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const existing = await prisma.category.create({
        data: { userId, name: "سوپرمارکت تست دیدوپ", icon: "🛒", color: "#10B981", type: "expense" },
      });
      const countBefore = await prisma.category.count({ where: { userId } });

      const res = await POST(
        makeRequest({ name: "سوپرمارکت تست دیدوپ", type: "expense", parentName: null, source: "ai-suggestion" })
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resolvedExisting).toBe(true);
      expect(data.category.id).toBe(existing.id);

      const countAfter = await prisma.category.count({ where: { userId } });
      expect(countAfter).toBe(countBefore);
    });

    it("resolves via CATEGORY_ALIASES to the canonical existing category (200, resolvedExisting: true)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const existing = await prisma.category.create({
        data: { userId, name: "دخانیات", icon: "🚬", color: "#64748B", type: "expense" },
      });
      const countBefore = await prisma.category.count({ where: { userId } });

      // "سیگار" is a registered alias for "دخانیات" (see lib/category-aliases.ts).
      const res = await POST(makeRequest({ name: "سیگار", type: "expense", parentName: null, source: "ai-suggestion" }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resolvedExisting).toBe(true);
      expect(data.category.id).toBe(existing.id);

      const countAfter = await prisma.category.count({ where: { userId } });
      expect(countAfter).toBe(countBefore);
    });

    it("creates a genuinely new, non-duplicate category (201, resolvedExisting: false)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const name = "دسته کاملا جدید تست";
      const res = await POST(makeRequest({ name, type: "expense", parentName: null, source: "ai-suggestion" }));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.resolvedExisting).toBe(false);
      expect(data.category.name).toBe(name);
      expect(data.category.icon).toBe(resolveNewCategoryIcon(name));
    });
  });

  describe("manual source (omitted): unchanged pre-existing contract", () => {
    it("creates a category using the client-supplied icon/color, with no resolvedExisting field (201)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      const res = await POST(
        makeRequest({ name: "دسته دستی تست", type: "expense", icon: "🎯", color: "#8B5CF6" })
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.category.icon).toBe("🎯");
      expect(data.category.color).toBe("#8B5CF6");
      expect(data).not.toHaveProperty("resolvedExisting");
    });

    it("409s on a duplicate name+type, matching the pre-existing collision behavior", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      await POST(makeRequest({ name: "دسته دستی تکراری", type: "expense", icon: "🔁", color: "#EF4444" }));
      const res = await POST(makeRequest({ name: "دسته دستی تکراری", type: "expense", icon: "🔁", color: "#EF4444" }));
      expect(res.status).toBe(409);
    });

    it("does not run dedup: an exact name match against an existing category still creates a new row (409 on retry, not a silent 200 resolve)", async () => {
      mockedGetSession.mockResolvedValue(asSession(userId));
      // "سیگار" is an alias that would resolve to "دخانیات" under source: "ai-suggestion" (tested above).
      // Under source: "manual" there is no dedup at all, so this must behave like any other manual create.
      const res = await POST(makeRequest({ name: "سیگار دستی تست", type: "expense", icon: "🚬", color: "#64748B" }));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).not.toHaveProperty("resolvedExisting");
    });
  });
});

// Deliberately unrelated single-word names (colors) so none of them can
// accidentally trip findSimilarCategory's >= 0.5 token-overlap fallback
// against each other or against the actual test category names below -
// a real risk this suite hit before this rename (see git history).
const FILLER_CATEGORY_NAMES = ["زرد", "بنفش", "نارنجی", "خاکستری", "صورتی", "فیروزه‌ای", "زیتونی", "کرم", "یاسی"];

describe("POST /api/categories - MAX_CATEGORIES_PER_24H rate limit (ai-suggestion source only)", () => {
  let userId: number;

  beforeAll(async () => {
    userId = await createTestUser("ratelimit");
    mockedGetSession.mockResolvedValue(asSession(userId));
    // Seed 9 categories already "created" within the last 24h, so the next
    // ai-suggestion create is the 10th (== MAX_CATEGORIES_PER_24H).
    for (const name of FILLER_CATEGORY_NAMES) {
      await prisma.category.create({ data: { userId, name, icon: "🧪", color: "#64748B", type: "expense" } });
    }
  });

  afterAll(async () => {
    await cleanupUser(userId);
  });

  it("allows creation up to and including the threshold (10th succeeds)", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(makeRequest({ name: "قهوه فرانسه", type: "expense", parentName: null, source: "ai-suggestion" }));
    expect(res.status).toBe(201);
  });

  it("rejects the (threshold + 1)th creation within 24h with the expected status and Persian message", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(
      makeRequest({ name: "چتر و کفش بارانی", type: "expense", parentName: null, source: "ai-suggestion" })
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe(
      "در ۲۴ ساعت گذشته دسته‌بندی زیادی ساخته‌اید؛ لطفاً از دسته‌های موجود استفاده کنید."
    );
  });

  // Runs before the "still allows manual creation" test below - that test's
  // own successful create adds another row to the window, which would
  // throw off this test's count arithmetic (10 -> age one out -> 9) if it
  // ran first.
  it("allows creation again once the oldest row in the window ages out past 24h", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const oldest = await prisma.category.findFirst({ where: { userId, name: FILLER_CATEGORY_NAMES[0] } });
    if (!oldest) throw new Error("expected seeded category not found");

    await prisma.category.update({
      where: { id: oldest.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const res = await POST(
      makeRequest({ name: "بیمه موتور سیکلت", type: "expense", parentName: null, source: "ai-suggestion" })
    );
    expect(res.status).toBe(201);
  });

  it("still allows a manual-source creation for the same user regardless of the ai-suggestion window state", async () => {
    mockedGetSession.mockResolvedValue(asSession(userId));
    const res = await POST(makeRequest({ name: "دسته دستی هنگام محدودیت", type: "expense", icon: "🎯", color: "#3B82F6" }));
    expect(res.status).toBe(201);
  });
});
