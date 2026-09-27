-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "User" ADD COLUMN "blockedAt" DATETIME;

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "route" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "userId" INTEGER,
    CONSTRAINT "ErrorLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DefaultCategory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentId" INTEGER,
    CONSTRAINT "DefaultCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DefaultCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ErrorLog_timestamp_idx" ON "ErrorLog"("timestamp");

-- CreateIndex
CREATE INDEX "ErrorLog_userId_idx" ON "ErrorLog"("userId");

-- CreateIndex
CREATE INDEX "DefaultCategory_parentId_idx" ON "DefaultCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DefaultCategory_name_type_key" ON "DefaultCategory"("name", "type");

-- CreateData
-- Seed data: preserves the exact default categories previously
-- hardcoded in lib/categories.ts's DEFAULT_CATEGORIES, now admin-managed.
INSERT INTO "DefaultCategory" ("name","icon","color","type","isTransfer") VALUES
('خوراک و رستوران','🍔','#F97316','expense',false),
('خانه و زندگی','🏠','#1E3A8A','expense',false),
('حمل‌ونقل','🚗','#3B82F6','expense',false),
('تفریح و سرگرمی','🎬','#8B5CF6','expense',false),
('خرید','🛍️','#EC4899','expense',false),
('سلامت و درمان','💊','#EF4444','expense',false),
('آموزش','📚','#06B6D4','expense',false),
('قبوض و اشتراک','🧾','#64748B','expense',false),
('انتقال بین حساب‌ها','🔄','#14B8A6','expense',true),
('سایر','📦','#94A3B8','expense',false),
('درآمد','💵','#059669','income',false),
('انتقال بین حساب‌ها','🔄','#14B8A6','income',true),
('سایر','📦','#94A3B8','income',false);

INSERT INTO "DefaultCategory" ("name","icon","color","type","isTransfer","parentId") VALUES
('سوپرمارکت','🍔','#F97316','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خوراک و رستوران' AND type='expense' AND "parentId" IS NULL)),
('رستوران/کافه','🍔','#F97316','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خوراک و رستوران' AND type='expense' AND "parentId" IS NULL)),
('دلیوری آنلاین','🍔','#F97316','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خوراک و رستوران' AND type='expense' AND "parentId" IS NULL)),
('اجاره/قسط مسکن','🏠','#1E3A8A','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خانه و زندگی' AND type='expense' AND "parentId" IS NULL)),
('قبوض خانه','🏠','#1E3A8A','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خانه و زندگی' AND type='expense' AND "parentId" IS NULL)),
('لوازم خانه','🏠','#1E3A8A','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خانه و زندگی' AND type='expense' AND "parentId" IS NULL)),
('تعمیرات','🏠','#1E3A8A','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خانه و زندگی' AND type='expense' AND "parentId" IS NULL)),
('بنزین','🚗','#3B82F6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='حمل‌ونقل' AND type='expense' AND "parentId" IS NULL)),
('تاکسی/اسنپ','🚗','#3B82F6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='حمل‌ونقل' AND type='expense' AND "parentId" IS NULL)),
('تعمیر خودرو','🚗','#3B82F6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='حمل‌ونقل' AND type='expense' AND "parentId" IS NULL)),
('بلیط سفر','🚗','#3B82F6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='حمل‌ونقل' AND type='expense' AND "parentId" IS NULL)),
('سینما/کنسرت','🎬','#8B5CF6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='تفریح و سرگرمی' AND type='expense' AND "parentId" IS NULL)),
('اشتراک‌های دیجیتال','🎬','#8B5CF6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='تفریح و سرگرمی' AND type='expense' AND "parentId" IS NULL)),
('بازی','🎬','#8B5CF6','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='تفریح و سرگرمی' AND type='expense' AND "parentId" IS NULL)),
('پوشاک','🛍️','#EC4899','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خرید' AND type='expense' AND "parentId" IS NULL)),
('دیجیتال/الکترونیک','🛍️','#EC4899','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خرید' AND type='expense' AND "parentId" IS NULL)),
('خرید آنلاین','🛍️','#EC4899','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='خرید' AND type='expense' AND "parentId" IS NULL)),
('دارو','💊','#EF4444','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='سلامت و درمان' AND type='expense' AND "parentId" IS NULL)),
('ویزیت پزشک','💊','#EF4444','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='سلامت و درمان' AND type='expense' AND "parentId" IS NULL)),
('باشگاه','💊','#EF4444','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='سلامت و درمان' AND type='expense' AND "parentId" IS NULL)),
('کلاس','📚','#06B6D4','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='آموزش' AND type='expense' AND "parentId" IS NULL)),
('کتاب','📚','#06B6D4','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='آموزش' AND type='expense' AND "parentId" IS NULL)),
('دوره آنلاین','📚','#06B6D4','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='آموزش' AND type='expense' AND "parentId" IS NULL)),
('موبایل','🧾','#64748B','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='قبوض و اشتراک' AND type='expense' AND "parentId" IS NULL)),
('اینترنت','🧾','#64748B','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='قبوض و اشتراک' AND type='expense' AND "parentId" IS NULL)),
('بیمه','🧾','#64748B','expense',false,(SELECT id FROM "DefaultCategory" WHERE name='قبوض و اشتراک' AND type='expense' AND "parentId" IS NULL)),
('حقوق','💰','#10B981','income',false,(SELECT id FROM "DefaultCategory" WHERE name='درآمد' AND type='income' AND "parentId" IS NULL)),
('فریلنس','💼','#3B82F6','income',false,(SELECT id FROM "DefaultCategory" WHERE name='درآمد' AND type='income' AND "parentId" IS NULL)),
('هدیه','🎁','#EC4899','income',false,(SELECT id FROM "DefaultCategory" WHERE name='درآمد' AND type='income' AND "parentId" IS NULL)),
('سرمایه‌گذاری','📈','#1E3A8A','income',false,(SELECT id FROM "DefaultCategory" WHERE name='درآمد' AND type='income' AND "parentId" IS NULL));
