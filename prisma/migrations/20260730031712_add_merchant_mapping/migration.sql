-- CreateTable
CREATE TABLE "MerchantMapping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "merchantKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" INTEGER NOT NULL,
    "categoryId" INTEGER NOT NULL,
    CONSTRAINT "MerchantMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MerchantMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MerchantMapping_categoryId_idx" ON "MerchantMapping"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantMapping_userId_merchantKey_key" ON "MerchantMapping"("userId", "merchantKey");
