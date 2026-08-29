import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Same rationale as lib/auth/session.test.ts: @/auth needs a real Next.js
// request context to run at all, so it's mocked wholesale here rather than
// exercised for real - requireAdminSession() itself (the thing every
// function below actually depends on) is not mocked.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  unstable_update: vi.fn(),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { auth } from "@/auth";
import { logger } from "@/lib/observability/logger";
import { prisma } from "@/lib/prisma";
import { listUsersForAdmin, getUserDetailForAdmin, InvalidUserRoleError } from "@/lib/data/admin-users";

// Phase 15: `role` read via isValidRole() instead of the old `u.role as
// UserRole - a corrupted row (bypassing lib/data/admin-users.ts itself via
// a raw Prisma write, see lib/auth/session.test.ts's own comment on the
// PRAGMA ignore_check_constraints technique used below) must be logged as
// a data-integrity error and never rendered via a guessed "user"/"admin"
// value.
describe("admin-users - Phase 15 role validation", () => {
  let adminId: number;
  let targetId: number;

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: { phoneNumber: `TEST-ADMIN-ROLE-${Date.now()}`, role: "admin" },
    });
    adminId = admin.id;
    const target = await prisma.user.create({ data: { phoneNumber: `TEST-TARGET-ROLE-${Date.now()}` } });
    targetId = target.id;
  }, 20000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, targetId] } } });
    await prisma.$disconnect();
  }, 20000);

  beforeEach(() => {
    vi.mocked(auth).mockReset();
    vi.mocked(auth).mockResolvedValue({ userId: String(adminId), onboarded: true } as never);
    vi.mocked(logger.error).mockClear();
  });

  it("listUsersForAdmin includes a normal user's role unchanged", async () => {
    const result = await listUsersForAdmin(1, 1000);
    const row = result.items.find((u) => u.id === targetId);
    expect(row?.role).toBe("user");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it(
    "listUsersForAdmin excludes a row with a corrupted role and logs it, without failing the whole request",
    async () => {
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'superadmin' WHERE "id" = ?`, targetId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);

      const result = await listUsersForAdmin(1, 1000);

      // The corrupted row is gone from the list, but every other user
      // (including the admin making the request) still comes back - one
      // bad row doesn't take down the whole admin page.
      expect(result.items.find((u) => u.id === targetId)).toBeUndefined();
      expect(result.items.find((u) => u.id === adminId)?.role).toBe("admin");

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields] = vi.mocked(logger.error).mock.calls[0];
      expect(fields).toMatchObject({
        errorType: "AUTH_ERROR",
        route: "data/admin-users",
        userId: adminId,
        context: { operation: "listUsersForAdmin", targetUserId: targetId },
      });

      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'user' WHERE "id" = ?`, targetId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);
    },
    15000
  );

  it("getUserDetailForAdmin returns a normal user's role unchanged", async () => {
    const detail = await getUserDetailForAdmin(targetId);
    expect(detail.role).toBe("user");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it(
    "getUserDetailForAdmin throws InvalidUserRoleError (not AdminUserNotFoundError) and logs, for a corrupted role",
    async () => {
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'superadmin' WHERE "id" = ?`, targetId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);

      await expect(getUserDetailForAdmin(targetId)).rejects.toBeInstanceOf(InvalidUserRoleError);

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields] = vi.mocked(logger.error).mock.calls[0];
      expect(fields).toMatchObject({
        errorType: "AUTH_ERROR",
        route: "data/admin-users",
        userId: adminId,
        context: { operation: "getUserDetailForAdmin", targetUserId: targetId },
      });

      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'user' WHERE "id" = ?`, targetId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);
    },
    15000
  );
});
