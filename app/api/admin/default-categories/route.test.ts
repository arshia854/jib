import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Same rationale as admin/users/[id]/route.test.ts: this route authorizes
// via requireAdminSession() -> getSession() -> @/auth's auth(), called
// inside lib/data/admin-categories.ts, not by this route itself.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  unstable_update: vi.fn(),
}));

import { auth } from "@/auth";
import { GET, POST } from "@/app/api/admin/default-categories/route";

const mockedAuth = vi.mocked(auth);

function asNextAuthSession(userId: number) {
  return { userId: String(userId), onboarded: true };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/default-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createUser(label: string, role: "user" | "admin" = "user") {
  const user = await prisma.user.create({
    data: { phoneNumber: `TEST-ADMIN-DEFAULT-CATS-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role },
  });
  return user.id;
}

const cleanupUserIds: number[] = [];
const cleanupCategoryNames: string[] = [];

afterAll(async () => {
  if (cleanupCategoryNames.length) {
    // Children first: DefaultCategory.parent uses onDelete: Restrict, same
    // as Category.parent - see lib/data/categories.test.ts's cleanupUser
    // for the identical pattern.
    await prisma.defaultCategory.deleteMany({
      where: { name: { in: cleanupCategoryNames }, parentId: { not: null } },
    });
    await prisma.defaultCategory.deleteMany({ where: { name: { in: cleanupCategoryNames } } });
  }
  if (cleanupUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedAuth.mockReset();
});

describe("GET /api/admin/default-categories", () => {
  it("rejects a non-admin session with 403", async () => {
    const userId = await createUser("get-nonadmin");
    cleanupUserIds.push(userId);
    mockedAuth.mockResolvedValue(asNextAuthSession(userId) as never);

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("an admin gets the full default-category list", async () => {
    const adminId = await createUser("get-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(0);
  });
});

describe("POST /api/admin/default-categories", () => {
  it("rejects a non-admin session with 403 and creates nothing", async () => {
    const userId = await createUser("post-nonadmin");
    cleanupUserIds.push(userId);
    mockedAuth.mockResolvedValue(asNextAuthSession(userId) as never);
    const name = "دسته ادمین تست غیرمجاز";
    cleanupCategoryNames.push(name);

    const res = await POST(makeRequest({ name, icon: "🧪", color: "#3B82F6", type: "expense" }));
    expect(res.status).toBe(403);
    const row = await prisma.defaultCategory.findFirst({ where: { name } });
    expect(row).toBeNull();
  });

  it("rejects missing required fields (400)", async () => {
    const adminId = await createUser("post-missing-fields-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await POST(makeRequest({ name: "دسته ناقص", type: "expense" }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid (non-hex) color (400)", async () => {
    const adminId = await createUser("post-invalid-color-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await POST(makeRequest({ name: "دسته رنگ نامعتبر", icon: "🧪", color: "blue", type: "expense" }));
    expect(res.status).toBe(400);
  });

  it("an admin creates a new default category (201)", async () => {
    const adminId = await createUser("post-create-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);
    const name = "دسته پیش‌فرض تست ادمین";
    cleanupCategoryNames.push(name);

    const res = await POST(makeRequest({ name, icon: "🧪", color: "#3B82F6", type: "expense" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.category.name).toBe(name);
    expect(data.category.isTransfer).toBe(false);
    expect(data.category.isEssential).toBe(true);
  });

  it("409s on a duplicate name+type", async () => {
    const adminId = await createUser("post-duplicate-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);
    const name = "دسته پیش‌فرض تکراری تست";
    cleanupCategoryNames.push(name);

    const first = await POST(makeRequest({ name, icon: "🧪", color: "#3B82F6", type: "expense" }));
    expect(first.status).toBe(201);
    const second = await POST(makeRequest({ name, icon: "🧪", color: "#3B82F6", type: "expense" }));
    expect(second.status).toBe(409);
  });

  it("creates a subcategory under a parentId", async () => {
    const adminId = await createUser("post-subcategory-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);
    const parentName = "دسته والد تست ادمین";
    const childName = "دسته فرزند تست ادمین";
    cleanupCategoryNames.push(parentName, childName);

    const parentRes = await POST(makeRequest({ name: parentName, icon: "🧪", color: "#3B82F6", type: "expense" }));
    const parent = (await parentRes.json()).category;

    const childRes = await POST(
      makeRequest({ name: childName, icon: "🧪", color: "#3B82F6", type: "expense", parentId: parent.id })
    );
    expect(childRes.status).toBe(201);
    const child = (await childRes.json()).category;
    expect(child.parentId).toBe(parent.id);
  });
});
