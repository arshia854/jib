import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Same rationale as lib/data/admin-users.test.ts: this route (and the
// lib/data/admin-users.ts functions it calls) authorizes via
// requireAdminSession() -> getSession() -> @/auth's auth(), not via a
// getSession() call the route makes itself - so @/auth is mocked here
// (not @/lib/auth/session), leaving requireAdminSession's real logic (the
// thing actually under test for the 403 cases) exercised for real.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  unstable_update: vi.fn(),
}));

import { auth } from "@/auth";
import { seedDefaultsForUser } from "@/lib/data/onboarding";
import { PATCH, DELETE } from "@/app/api/admin/users/[id]/route";

const mockedAuth = vi.mocked(auth);

function asNextAuthSession(userId: number) {
  return { userId: String(userId), onboarded: true };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/1", {
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
    data: { phoneNumber: `TEST-ADMIN-USERS-ID-ROUTE-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role },
  });
  return user.id;
}

const cleanupIds: number[] = [];

afterAll(async () => {
  if (cleanupIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedAuth.mockReset();
});

describe("PATCH /api/admin/users/[id]", () => {
  it("rejects an invalid id (400)", async () => {
    const adminId = await createUser("patch-invalid-id-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "block" }), paramsFor(NaN));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid action (400)", async () => {
    const adminId = await createUser("patch-invalid-action-admin", "admin");
    const targetId = await createUser("patch-invalid-action-target");
    cleanupIds.push(adminId, targetId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "delete-please" }), paramsFor(targetId));
    expect(res.status).toBe(400);
  });

  it("a non-admin session is rejected with 403 and the target is left untouched", async () => {
    const regularUserId = await createUser("patch-nonadmin-actor");
    const targetId = await createUser("patch-nonadmin-target");
    cleanupIds.push(regularUserId, targetId);
    mockedAuth.mockResolvedValue(asNextAuthSession(regularUserId) as never);

    const res = await PATCH(makeRequest({ action: "block" }), paramsFor(targetId));
    expect(res.status).toBe(403);

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    expect(target?.blockedAt).toBeNull();
  });

  it("an admin can block another user", async () => {
    const adminId = await createUser("patch-block-admin", "admin");
    const targetId = await createUser("patch-block-target");
    cleanupIds.push(adminId, targetId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "block" }), paramsFor(targetId));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.blockedAt).not.toBeNull();

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    expect(target?.blockedAt).not.toBeNull();
  });

  it("an admin can unblock a previously-blocked user", async () => {
    const adminId = await createUser("patch-unblock-admin", "admin");
    const targetId = await createUser("patch-unblock-target");
    cleanupIds.push(adminId, targetId);
    await prisma.user.update({ where: { id: targetId }, data: { blockedAt: new Date() } });
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "unblock" }), paramsFor(targetId));
    expect(res.status).toBe(200);

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    expect(target?.blockedAt).toBeNull();
  });

  it("404s when the target user does not exist", async () => {
    const adminId = await createUser("patch-notfound-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "block" }), paramsFor(999_999_999));
    expect(res.status).toBe(404);
  });

  it("an admin cannot block themselves (400, CannotModifySelfError)", async () => {
    const adminId = await createUser("patch-self-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await PATCH(makeRequest({ action: "block" }), paramsFor(adminId));
    expect(res.status).toBe(400);

    const self = await prisma.user.findUnique({ where: { id: adminId } });
    expect(self?.blockedAt).toBeNull();
  });
});

describe("DELETE /api/admin/users/[id]", () => {
  it("rejects an invalid id (400)", async () => {
    const adminId = await createUser("delete-invalid-id-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/users/x"), paramsFor(NaN));
    expect(res.status).toBe(400);
  });

  it("a non-admin session is rejected with 403 and the target still exists", async () => {
    const regularUserId = await createUser("delete-nonadmin-actor");
    const targetId = await createUser("delete-nonadmin-target");
    cleanupIds.push(regularUserId, targetId);
    mockedAuth.mockResolvedValue(asNextAuthSession(regularUserId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(targetId));
    expect(res.status).toBe(403);

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    expect(target).not.toBeNull();
  });

  it("404s when the target user does not exist", async () => {
    const adminId = await createUser("delete-notfound-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(999_999_998));
    expect(res.status).toBe(404);
  });

  it("an admin cannot delete themselves (400, CannotModifySelfError)", async () => {
    const adminId = await createUser("delete-self-admin", "admin");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(adminId));
    expect(res.status).toBe(400);

    const self = await prisma.user.findUnique({ where: { id: adminId } });
    expect(self).not.toBeNull();
  });

  // Database checklist item: "cascade-delete behavior... confirm at least
  // one test actually deletes a user and verifies the cascade". This route
  // is the real, live call path an admin uses to delete a user (via
  // lib/data/admin-users.ts's deleteUserAsAdmin -> prisma.user.delete), so
  // exercising it end-to-end here proves the schema's onDelete: Cascade
  // annotations actually behave that way against the real (test) DB, not
  // just that they're declared in prisma/schema.prisma.
  it(
    "an admin deleting a user cascades to every one of that user's owned rows (FinanceAccount, Category, Transaction, ChatMessage, MerchantMapping, SpendingSummaryCache, UserFact)",
    async () => {
      const adminId = await createUser("delete-cascade-admin", "admin");
      const targetId = await createUser("delete-cascade-target");
      cleanupIds.push(adminId); // targetId is expected to be gone by the end - not added here.
      mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

      const account = await prisma.financeAccount.create({
        data: { userId: targetId, name: "حساب تست کسکید", type: "cash", initialBalance: 0 },
      });
      const category = await prisma.category.create({
        data: { userId: targetId, name: "دسته تست کسکید", icon: "🧪", color: "#333333", type: "expense" },
      });
      const transaction = await prisma.transaction.create({
        data: {
          userId: targetId,
          accountId: account.id,
          categoryId: category.id,
          amount: 10000,
          type: "expense",
          date: new Date(),
          rawInput: "تست کسکید",
        },
      });
      const conversation = await prisma.conversation.create({ data: { userId: targetId } });
      const chatMessage = await prisma.chatMessage.create({
        data: { userId: targetId, role: "user", content: "سلام", conversationId: conversation.id },
      });
      const merchantMapping = await prisma.merchantMapping.create({
        data: { userId: targetId, merchantKey: "فروشگاه تست کسکید", categoryId: category.id },
      });
      const summaryCache = await prisma.spendingSummaryCache.create({
        data: { userId: targetId, monthKey: "1404-05", payload: "{}" },
      });
      const userFact = await prisma.userFact.create({
        data: { userId: targetId, key: "employment_status", value: "employed", source: "user_stated" },
      });

      const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(targetId));
      expect(res.status).toBe(200);

      expect(await prisma.user.findUnique({ where: { id: targetId } })).toBeNull();
      expect(await prisma.financeAccount.findUnique({ where: { id: account.id } })).toBeNull();
      expect(await prisma.category.findUnique({ where: { id: category.id } })).toBeNull();
      expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).toBeNull();
      expect(await prisma.chatMessage.findUnique({ where: { id: chatMessage.id } })).toBeNull();
      expect(await prisma.conversation.findUnique({ where: { id: conversation.id } })).toBeNull();
      expect(await prisma.merchantMapping.findUnique({ where: { id: merchantMapping.id } })).toBeNull();
      expect(await prisma.spendingSummaryCache.findUnique({ where: { id: summaryCache.id } })).toBeNull();
      expect(await prisma.userFact.findUnique({ where: { id: userFact.id } })).toBeNull();
    },
    20000
  );

  // Regression test for a real bug this session found (not a hypothetical):
  // a bare prisma.user.delete() failed with a genuine SQLite FOREIGN KEY
  // constraint error for ANY onboarded user - not just one with
  // transactions - because seedDefaultsForUser() gives every user a
  // parent+child category hierarchy, and Category's own self-referential
  // `parent` relation is onDelete: Restrict; SQLite's cascade processing
  // doesn't guarantee children are cascade-deleted before their parent
  // within the same User-triggered cascade. Fixed in
  // lib/data/admin-users.ts's deleteUserAsAdmin() (see its own comment) -
  // this is the more commonly-hit shape of the bug fixed there, distinct
  // from (and simpler than) the full multi-model cascade test above.
  it(
    "an admin can delete a normally-onboarded user (seeded parent+child categories, no transactions)",
    async () => {
      const adminId = await createUser("delete-onboarded-admin", "admin");
      const targetId = await createUser("delete-onboarded-target");
      cleanupIds.push(adminId);
      await seedDefaultsForUser(targetId);
      mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

      const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(targetId));
      expect(res.status).toBe(200);
      expect(await prisma.user.findUnique({ where: { id: targetId } })).toBeNull();
      expect(await prisma.category.count({ where: { userId: targetId } })).toBe(0);
      expect(await prisma.financeAccount.count({ where: { userId: targetId } })).toBe(0);
    },
    15000
  );

  it("an admin can delete a user with no related rows at all", async () => {
    const adminId = await createUser("delete-plain-admin", "admin");
    const targetId = await createUser("delete-plain-target");
    cleanupIds.push(adminId);
    mockedAuth.mockResolvedValue(asNextAuthSession(adminId) as never);

    const res = await DELETE(new NextRequest("http://localhost/api/admin/users/1"), paramsFor(targetId));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: targetId } })).toBeNull();
  });
});
