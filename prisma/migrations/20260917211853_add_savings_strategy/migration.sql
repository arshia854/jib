-- CreateTable
CREATE TABLE "SavingsStrategy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "formulaType" TEXT NOT NULL,
    "targetPercent" REAL,
    "targetAmount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "SavingsStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SavingsStrategy_userId_idx" ON "SavingsStrategy"("userId");
