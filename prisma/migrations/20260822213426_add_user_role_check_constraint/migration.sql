-- Phase 15 (Schema & Role Hardening): adds a DB-level CHECK constraint
-- restricting User.role to the two values the application actually
-- understands ('user' | 'admin' - see lib/auth/session.ts's UserRole type
-- and isValidRole()). This is defense-in-depth, not a fix for a live
-- authorization bug: no code path was found that writes `role` from
-- request-body/client input (only auth.ts's user-create, which never sets
-- role at all - it takes the schema default - and lib/data/admin-users.ts's
-- setUserBlocked/deleteUserAsAdmin, which never touch `role`), and every
-- read of `role` for an authorization decision (requireAdminSession(),
-- proxy.ts) already does a strict `=== "admin"` whitelist comparison, which
-- cannot be tricked into granting admin by an unexpected string. The actual
-- risk this closes is a *silently wrong* role value from some future bad
-- write (a bug, a manual DB edit, a bad script) going undetected - see this
-- migration's own PR/roadmap entry for the fuller writeup.
--
-- This migration is hand-written, not `prisma migrate diff` output, and
-- that's deliberate, not a shortcut: `schema.prisma` has no way to express
-- a CHECK constraint in this installed Prisma version - confirmed directly
-- (not assumed) by adding `@check(name: "role_valid", "role IN ('user',
-- 'admin')")` to the `role` field and running `prisma validate`, which
-- failed with "Attribute not known: '@check'" (Prisma 7.9.1 - see
-- package.json). There is and can be no `schema.prisma` diff behind this
-- migration: the model keeps `role String @default("user")` unchanged
-- (see that field's own updated comment), same as every other type-like
-- string field in this schema - this constraint exists only at the SQL
-- level, invisible to `prisma migrate diff`/`db pull`/Prisma's own
-- validation. Treat this file as the one source of truth for it.
--
-- SQLite has no `ALTER TABLE ... ADD CONSTRAINT` (see AGENTS.md), so this
-- uses the same table-rebuild ("RedefineTables") pattern Prisma's own
-- migration engine already generated once in this project -
-- prisma/migrations/20260806144050_add_category_is_essential/migration.sql
-- - copied here by hand in the same style. The column list/order/types/
-- defaults below are copied verbatim from `npx prisma migrate diff
-- --from-empty --to-schema prisma/schema.prisma --script`'s own
-- `CREATE TABLE "User"` output (run offline, no DB touched), with only the
-- trailing CHECK constraint added - so this is guaranteed to match what
-- schema.prisma already describes today, not a hand-guessed column list.
-- `User` has no outgoing foreign keys of its own, and SQLite resolves the
-- many incoming ones (FinanceAccount, Category, Transaction, ChatMessage,
-- MerchantMapping, Account, SpendingSummaryCache, UserFact, ErrorLog) by
-- table name, not a persistent identity - none of those child tables need
-- to be touched or redefined for this change, same as the Category rebuild
-- above didn't touch Transaction.
--
-- CAUTION before applying this to the live Turso DB (see AGENTS.md's
-- offline-migration process - this has NOT been applied there as part of
-- this change): the INSERT step below fails outright if any existing row
-- already has a role outside ('user', 'admin'). Run
-- `SELECT id, role FROM User WHERE role NOT IN ('user', 'admin')` against
-- the live DB first and resolve any hits before applying this file for
-- real - this repo has no access to the live DB to check that here.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phoneNumber" TEXT,
    "email" TEXT,
    "emailVerified" DATETIME,
    "passwordHash" TEXT,
    "image" TEXT,
    "name" TEXT,
    "age" INTEGER,
    "role" TEXT NOT NULL DEFAULT 'user',
    "blockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_role_check" CHECK ("role" IN ('user', 'admin'))
);
INSERT INTO "new_User" ("id", "phoneNumber", "email", "emailVerified", "passwordHash", "image", "name", "age", "role", "blockedAt", "createdAt", "updatedAt") SELECT "id", "phoneNumber", "email", "emailVerified", "passwordHash", "image", "name", "age", "role", "blockedAt", "createdAt", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
