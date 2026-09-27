import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

// @/auth (NextAuth's own `auth()`) needs a real Next.js request context
// (cookies()/headers() async storage) to run at all - not available under
// plain vitest - so it's mocked wholesale here, same as every route test
// in this codebase mocks lib/auth/session itself. This file is the one
// place that instead exercises lib/auth/session.ts's own real logic
// (getSession/getActiveUser/requireAdminSession) against a real DB row, so
// only its one upstream dependency (auth()) is stubbed, not session.ts.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
  unstable_update: vi.fn(),
}));

// pino writes real JSON to stdout in this test env (see report-error.test.ts's
// own note) - mocked purely to make the exact fields reportError()'s
// underlying logger.error() call receives assertable.
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { auth } from "@/auth";
import { logger } from "@/lib/observability/logger";
import { prisma } from "@/lib/prisma";
import { isValidRole, getSession, requireAdminSession, NotAdminError } from "@/lib/auth/session";

describe("isValidRole", () => {
  it('accepts "user"', () => {
    expect(isValidRole("user")).toBe(true);
  });

  it('accepts "admin"', () => {
    expect(isValidRole("admin")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidRole("")).toBe(false);
  });

  it("rejects wrong casing", () => {
    expect(isValidRole("Admin")).toBe(false);
    expect(isValidRole("USER")).toBe(false);
  });

  it("rejects an unrelated string", () => {
    expect(isValidRole("superadmin")).toBe(false);
    expect(isValidRole("moderator")).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidRole(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidRole(undefined)).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isValidRole(1)).toBe(false);
    expect(isValidRole(true)).toBe(false);
    expect(isValidRole({})).toBe(false);
  });
});

// Phase 15 regression coverage: a row whose `role` column holds something
// other than "user"/"admin" - bypassing lib/auth/session.ts and
// lib/data/admin-users.ts entirely via a raw Prisma write, the same way a
// real bad write (a bug, a manual DB edit, data older than the CHECK
// constraint below) would look from this app's point of view. Written via
// $executeRawUnsafe + PRAGMA ignore_check_constraints (SQLite's own,
// documented escape hatch for loading data that predates a constraint -
// https://www.sqlite.org/pragma.html#pragma_ignore_check_constraints) since
// prisma.user.update()/.create() with an invalid role is now itself
// rejected by the DB - see the "DB CHECK constraint" block below, which
// proves that half separately.
describe("getSession - invalid User.role data-integrity regression", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-SESSION-ROLE-${Date.now()}` } });
    userId = user.id;
  }, 20000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  beforeEach(() => {
    vi.mocked(auth).mockReset();
    vi.mocked(logger.error).mockClear();
  });

  it("resolves a normal 'user' role unchanged", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: String(userId), onboarded: true } as never);

    const session = await getSession();

    expect(session).toEqual({ userId, onboarded: true, role: "user" });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it(
    "returns null and logs a data-integrity error for a corrupted role, instead of silently treating it as valid",
    async () => {
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'superadmin' WHERE "id" = ?`, userId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);

      // Confirms the corrupted value is really sitting in the row (not
      // rejected at write time) before exercising the read path below.
      const raw = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      expect(raw?.role).toBe("superadmin");

      vi.mocked(auth).mockResolvedValue({ userId: String(userId), onboarded: true } as never);

      const session = await getSession();

      // Not coerced to "user" or "admin" either way - a corrupted role
      // fails closed (no session), same as a blocked/deleted user.
      expect(session).toBeNull();

      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields, message] = vi.mocked(logger.error).mock.calls[0];
      expect(fields).toMatchObject({ errorType: "AUTH_ERROR", route: "auth/session", userId });
      expect(message).toContain("superadmin");

      // requireAdminSession() on top of a corrupted-role session: per the
      // roadmap's own step 1 question, this should NOT grant admin. With
      // getSession() already returning null above, requireAdminSession()
      // hits its existing `!session` branch - confirms the strict
      // whitelist gate was never actually the weak point here.
      await expect(requireAdminSession()).rejects.toBeInstanceOf(NotAdminError);
    },
    15000
  );

  it(
    "requireAdminSession() does not grant admin for a corrupted-but-not-'admin' value even with a valid session shape otherwise",
    async () => {
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'Admin' WHERE "id" = ?`, userId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);

      vi.mocked(auth).mockResolvedValue({ userId: String(userId), onboarded: true } as never);

      await expect(requireAdminSession()).rejects.toBeInstanceOf(NotAdminError);

      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = ON`);
      await prisma.$executeRawUnsafe(`UPDATE "User" SET "role" = 'user' WHERE "id" = ?`, userId);
      await prisma.$executeRawUnsafe(`PRAGMA ignore_check_constraints = OFF`);
    },
    15000
  );
});

// Turso latency fix (docs/roadmap-status.md): getActiveUser() now reads the
// User row through getCachedUser() (React's cache(), see that function's own
// doc comment in lib/auth/session.ts) instead of running its own independent
// `prisma.user.findUnique`. This proves that change didn't weaken the "a
// blocked user is rejected on their very next request" guarantee this file's
// own doc comment on getActiveUser already documents - each getSession()
// call below stands in for a separate incoming request and must reflect
// whatever blockedAt currently holds at call time, not a value read on an
// earlier call.
describe("getSession - blocked user rejected on next request (Turso latency fix regression coverage)", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-SESSION-BLOCKED-${Date.now()}` } });
    userId = user.id;
  }, 20000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  beforeEach(() => {
    vi.mocked(auth).mockReset();
  });

  it("accepts the session before the user is blocked, then rejects the very next call once blocked", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: String(userId), onboarded: true } as never);

    const before = await getSession();
    expect(before).toEqual({ userId, onboarded: true, role: "user" });

    await prisma.user.update({ where: { id: userId }, data: { blockedAt: new Date() } });

    const after = await getSession();
    expect(after).toBeNull();
  });
});

// Confirms the mechanism from the migration itself, not just the app-level
// helper - a CHECK constraint that only the app layer enforced would still
// leave a direct/manual DB write free to corrupt the column.
describe("DB CHECK constraint on User.role", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-ROLE-CHECK-${Date.now()}` } });
    userId = user.id;
  }, 20000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it("rejects an UPDATE to an invalid role", async () => {
    await expect(prisma.user.update({ where: { id: userId }, data: { role: "superadmin" } })).rejects.toThrow();

    const untouched = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    expect(untouched?.role).toBe("user");
  });

  it("rejects a CREATE with an invalid role", async () => {
    await expect(
      prisma.user.create({ data: { phoneNumber: `TEST-ROLE-CHECK-CREATE-${Date.now()}`, role: "moderator" } })
    ).rejects.toThrow();
  });

  it("still allows both valid values", async () => {
    await expect(prisma.user.update({ where: { id: userId }, data: { role: "admin" } })).resolves.toMatchObject({
      role: "admin",
    });
    await expect(prisma.user.update({ where: { id: userId }, data: { role: "user" } })).resolves.toMatchObject({
      role: "user",
    });
  });
});
