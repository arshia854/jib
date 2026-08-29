import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  unstable_update: vi.fn(),
}));

import { auth } from "@/auth";
import { PATCH, DELETE } from "@/app/api/admin/default-categories/[id]/route";

const mockedAuth = vi.mocked(auth);

function asNextAuthSession(userId: number) {
  return { userId: String(userId), onboarded: true };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/default-categories/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function paramsFor(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

async function createUser(label: string, role: "user" | "admin" = "user") {
  const user = await prisma.user.create({
    data: {
      phoneNumber: `TEST-ADMIN-DEFAULT-CATS-ID-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
    },
  });
  return user.id;
}

const cleanupUserIds: number[] = [];
const cleanupCategoryNames: string[] = [];

afterAll(async () => {
  if (cleanupCategoryNames.length) {
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

describe("PATCH /api/admin/default-categories/[id]", () => {
  it("rejects an invalid id (400)", async () => {
    const adminId = await createUser("patch-invalid-id-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ name: "جدید" }), paramsFor(NaN));
    expect(res.status).toBe(400);
  });

  it("rejects a body with no valid fields (400)", async () => {
    const adminId = await createUser("patch-empty-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);
    const name = "دسته پیش‌فرض تست PATCH خالی";
    cleanupCategoryNames.push(name);
    const category = await prisma.defaultCategory.create({
      data: { name, icon: "🧪", color: "#3B82F6", type: "expense" },
    });

    const res = await PATCH(makeRequest({}), paramsFor(category.id));
    expect(res.status).toBe(400);
  });

  it("a non-admin session is rejected with 403 and the row is untouched", async () => {
    const userId = await createUser("patch-nonadmin");
    cleanupUserIds.push(userId);
    const name = "دسته پیش‌فرض تست PATCH غیرمجاز";
    cleanupCategoryNames.push(name);
    const category = await prisma.defaultCategory.create({
      data: { name, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(userId) as never);

    const res = await PATCH(makeRequest({ name: "دستکاری شده" }), paramsFor(category.id));
    expect(res.status).toBe(403);

    const untouched = await prisma.defaultCategory.findUnique({ where: { id: category.id } });
    expect(untouched?.name).toBe(name);
  });

  it("an admin updates name/icon/color", async () => {
    const adminId = await createUser("patch-update-admin", "admin");
    cleanupUserIds.push(adminId);
    const name = "دسته پیش‌فرض تست PATCH موفق";
    const updatedName = "دسته پیش‌فرض تست PATCH ویرایش‌شده";
    cleanupCategoryNames.push(name, updatedName);
    const category = await prisma.defaultCategory.create({
      data: { name, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ name: updatedName, icon: "🎯", color: "#EF4444" }), paramsFor(category.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.category.name).toBe(updatedName);
    expect(data.category.icon).toBe("🎯");
    expect(data.category.color).toBe("#EF4444");
  });

  it("404s when the category does not exist", async () => {
    const adminId = await createUser("patch-notfound-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ name: "جدید" }), paramsFor(999_999_997));
    expect(res.status).toBe(404);
  });

  it("409s when renaming into a colliding name+type", async () => {
    const adminId = await createUser("patch-conflict-admin", "admin");
    cleanupUserIds.push(adminId);
    const nameA = "دسته پیش‌فرض تست تعارض الف";
    const nameB = "دسته پیش‌فرض تست تعارض ب";
    cleanupCategoryNames.push(nameA, nameB);
    await prisma.defaultCategory.create({ data: { name: nameA, icon: "🧪", color: "#3B82F6", type: "expense" } });
    const categoryB = await prisma.defaultCategory.create({
      data: { name: nameB, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ name: nameA }), paramsFor(categoryB.id));
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/admin/default-categories/[id]", () => {
  it("rejects an invalid id (400)", async () => {
    const adminId = await createUser("delete-invalid-id-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/default-categories/x"), paramsFor(NaN));
    expect(res.status).toBe(400);
  });

  it("a non-admin session is rejected with 403 and the row still exists", async () => {
    const userId = await createUser("delete-nonadmin");
    cleanupUserIds.push(userId);
    const name = "دسته پیش‌فرض تست DELETE غیرمجاز";
    cleanupCategoryNames.push(name);
    const category = await prisma.defaultCategory.create({
      data: { name, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(userId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/default-categories/1"), paramsFor(category.id));
    expect(res.status).toBe(403);
    expect(await prisma.defaultCategory.findUnique({ where: { id: category.id } })).not.toBeNull();
  });

  it("404s when the category does not exist", async () => {
    const adminId = await createUser("delete-notfound-admin", "admin");
    cleanupUserIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/default-categories/1"), paramsFor(999_999_996));
    expect(res.status).toBe(404);
  });

  // Database checklist: "onDelete: Restrict on Category.parent... confirm
  // this is tested" - DefaultCategory has the identical self-referential
  // Restrict relation, and unlike the user-facing Category (whose
  // deleteCategory only checks Transaction usage, never child categories -
  // see lib/data/categories.ts), deleteDefaultCategory DOES check child
  // count explicitly, throwing its own DefaultCategoryInUseError before
  // ever reaching the DB - this proves that app-level guard.
  it("409s (DefaultCategoryInUseError) when the category has children, and deletes neither row", async () => {
    const adminId = await createUser("delete-inuse-admin", "admin");
    cleanupUserIds.push(adminId);
    const parentName = "دسته والد تست DELETE";
    const childName = "دسته فرزند تست DELETE";
    cleanupCategoryNames.push(parentName, childName);
    const parent = await prisma.defaultCategory.create({
      data: { name: parentName, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    const child = await prisma.defaultCategory.create({
      data: { name: childName, icon: "🧪", color: "#3B82F6", type: "expense", parentId: parent.id },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/default-categories/1"), paramsFor(parent.id));
    expect(res.status).toBe(409);

    expect(await prisma.defaultCategory.findUnique({ where: { id: parent.id } })).not.toBeNull();
    expect(await prisma.defaultCategory.findUnique({ where: { id: child.id } })).not.toBeNull();
  });

  it("an admin deletes a childless default category (200)", async () => {
    const adminId = await createUser("delete-success-admin", "admin");
    cleanupUserIds.push(adminId);
    const name = "دسته پیش‌فرض تست DELETE موفق";
    cleanupCategoryNames.push(name);
    const category = await prisma.defaultCategory.create({
      data: { name, icon: "🧪", color: "#3B82F6", type: "expense" },
    });
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/default-categories/1"), paramsFor(category.id));
    expect(res.status).toBe(200);
    expect(await prisma.defaultCategory.findUnique({ where: { id: category.id } })).toBeNull();
  });
});
