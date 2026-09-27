-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Category" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
    "isEssential" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "parentId" INTEGER,
    CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Category" ("color", "createdAt", "icon", "id", "isTransfer", "name", "parentId", "type", "userId") SELECT "color", "createdAt", "icon", "id", "isTransfer", "name", "parentId", "type", "userId" FROM "Category";
DROP TABLE "Category";
ALTER TABLE "new_Category" RENAME TO "Category";
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
CREATE UNIQUE INDEX "Category_userId_name_type_key" ON "Category"("userId", "name", "type");
CREATE TABLE "new_DefaultCategory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
    "isEssential" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentId" INTEGER,
    CONSTRAINT "DefaultCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DefaultCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DefaultCategory" ("color", "createdAt", "icon", "id", "isTransfer", "name", "parentId", "type") SELECT "color", "createdAt", "icon", "id", "isTransfer", "name", "parentId", "type" FROM "DefaultCategory";
DROP TABLE "DefaultCategory";
ALTER TABLE "new_DefaultCategory" RENAME TO "DefaultCategory";
CREATE INDEX "DefaultCategory_parentId_idx" ON "DefaultCategory"("parentId");
CREATE UNIQUE INDEX "DefaultCategory_name_type_key" ON "DefaultCategory"("name", "type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
