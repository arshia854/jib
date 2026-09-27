-- Multi-conversation chat history: the assistant's single endless
-- per-user thread becomes N conversations, each with its own bounded
-- message history and its own AI context (see lib/data/conversations.ts
-- and app/api/chat/route.ts).
--
-- Everything below except the one "Backfill" block is verbatim
-- `prisma migrate diff --from-schema <HEAD's schema.prisma> --to-schema
-- prisma/schema.prisma --script` output, run offline per AGENTS.md - no
-- DB was touched to produce it. Two deliberate, minimal edits to that
-- output, both of them the data migration the diff has no way to express:
--
--   1. The "Backfill" INSERT INTO "Conversation" block, inserted between
--      the CreateTable and the RedefineTables - it must run after
--      "Conversation" exists and before "ChatMessage" is rebuilt with a
--      NOT NULL "conversationId" pointing at it.
--   2. The RedefineTables INSERT gained a "conversationId" column +
--      its correlated subquery. `migrate diff` emitted that INSERT
--      without the new column at all (it has no idea where the value
--      should come from), which would fail the NOT NULL constraint on
--      the first existing row.
--
-- Nothing else in the diff output was altered - in particular this
-- migration does NOT rebuild "User", so the hand-written
-- "User_role_check" CHECK constraint from
-- 20260822213426_add_user_role_check_constraint is untouched here (see
-- 20260825171540_add_assets for the one time that constraint was
-- accidentally dropped by a RedefineTables, and why).
--
-- Applied to the live Turso DB on 2026-09-04 (see _prisma_migrations and
-- scripts/backfill-migration-history.ts's MIGRATION_NAMES) per AGENTS.md's
-- "Applying a new schema change" process.

-- CreateTable
CREATE TABLE "Conversation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Backfill (not `migrate diff` output - see this file's header).
--
-- Exactly one Conversation per user who already has any ChatMessage row -
-- GROUP BY "userId" over "ChatMessage" guarantees that: one output row per
-- distinct owner, and users with no chat history get nothing (they'll
-- create their first conversation through the app instead).
--
-- title: that user's earliest role='user' message, whitespace-trimmed and
-- cut to 40 characters, with '…' appended only when something was actually
-- cut. SQLite's SUBSTR/LENGTH count characters (codepoints) on TEXT, not
-- bytes, so this cannot split a Persian character in half - the same
-- codepoint-level cut truncateTitle() in lib/data/conversations.ts makes
-- for newly auto-titled conversations, kept deliberately consistent.
-- NULLIF(..., '') covers a user whose messages are all role='assistant'
-- (subquery -> NULL) or whose first message trims to empty; COALESCE then
-- falls back to the literal 'مکالمه قبلی' ("previous conversation").
--
-- createdAt/updatedAt/lastMessageAt are derived from the messages
-- themselves rather than the migration's own wall clock, so a backfilled
-- thread sorts into the history list by its real last activity.
INSERT INTO "Conversation" ("userId", "title", "createdAt", "updatedAt", "lastMessageAt")
SELECT
    m."userId",
    COALESCE(
        NULLIF(
            (
                SELECT
                    CASE
                        WHEN LENGTH(TRIM(first_msg."content")) > 40
                            THEN SUBSTR(TRIM(first_msg."content"), 1, 40) || '…'
                        ELSE TRIM(first_msg."content")
                    END
                FROM "ChatMessage" first_msg
                WHERE first_msg."userId" = m."userId" AND first_msg."role" = 'user'
                ORDER BY first_msg."timestamp" ASC, first_msg."id" ASC
                LIMIT 1
            ),
            ''
        ),
        'مکالمه قبلی'
    ),
    MIN(m."timestamp"),
    MAX(m."timestamp"),
    MAX(m."timestamp")
FROM "ChatMessage" m
GROUP BY m."userId";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The correlated subquery resolves to exactly one row: the backfill above
-- created precisely one Conversation per user-with-messages, and this
-- table is empty of any other Conversation at this point in the migration
-- (the table was created three statements ago). Every row of the old
-- "ChatMessage" therefore gets a non-NULL owner-matching conversationId -
-- if any row somehow didn't, the NOT NULL constraint would abort the
-- migration rather than let a dangling message through.
INSERT INTO "new_ChatMessage" ("content", "id", "role", "timestamp", "userId", "conversationId")
SELECT
    m."content",
    m."id",
    m."role",
    m."timestamp",
    m."userId",
    (SELECT c."id" FROM "Conversation" c WHERE c."userId" = m."userId" ORDER BY c."id" ASC LIMIT 1)
FROM "ChatMessage" m;
DROP TABLE "ChatMessage";
ALTER TABLE "new_ChatMessage" RENAME TO "ChatMessage";
CREATE INDEX "ChatMessage_userId_timestamp_idx" ON "ChatMessage"("userId", "timestamp");
CREATE INDEX "ChatMessage_conversationId_timestamp_idx" ON "ChatMessage"("conversationId", "timestamp");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Conversation_userId_lastMessageAt_idx" ON "Conversation"("userId", "lastMessageAt");
