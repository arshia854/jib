-- CreateTable
CREATE TABLE "Asset" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "quantity" REAL NOT NULL,
    "purchasePricePerUnit" BIGINT NOT NULL,
    "purchaseDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPricePerUnit" BIGINT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LivePriceCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "goldGramPricePerUnit" BIGINT NOT NULL,
    "usdPricePerUnit" BIGINT NOT NULL,
    "bitcoinPricePerUnit" BIGINT NOT NULL,
    "fetchedAt" DATETIME NOT NULL
);

-- RedefineTables
--
-- Bug fix (found while verifying an unrelated change - see docs/roadmap-status.md
-- for the full writeup): `prisma migrate diff` rebuilt this table straight
-- from schema.prisma alone to add `showBalanceInAssets`, which has no way to
-- express the hand-written `User_role_check` CHECK constraint added by
-- prisma/migrations/20260822213426_add_user_role_check_constraint (see that
-- migration's own comment on why it can't live in schema.prisma). Diffing
-- from a schema that constraint isn't part of silently dropped it from the
-- rebuilt table. Restored here, verbatim from that migration, so this
-- RedefineTables doesn't undo Phase 15's role hardening. Neither this
-- migration nor the one it depends on has been applied to the live Turso DB
-- yet (per AGENTS.md's process/docs/roadmap-status.md Phase 19) - this fixes
-- the migration.sql file itself, before either was ever applied for real.
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
    "showBalanceInAssets" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "User_role_check" CHECK ("role" IN ('user', 'admin'))
);
INSERT INTO "new_User" ("age", "blockedAt", "createdAt", "email", "emailVerified", "id", "image", "name", "passwordHash", "phoneNumber", "role", "updatedAt") SELECT "age", "blockedAt", "createdAt", "email", "emailVerified", "id", "image", "name", "passwordHash", "phoneNumber", "role", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Asset_userId_idx" ON "Asset"("userId");

