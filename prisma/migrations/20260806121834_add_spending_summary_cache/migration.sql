-- CreateTable
CREATE TABLE "SpendingSummaryCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "monthKey" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "SpendingSummaryCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SpendingSummaryCache_userId_monthKey_key" ON "SpendingSummaryCache"("userId", "monthKey");
