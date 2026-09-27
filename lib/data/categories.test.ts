import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  updateCategory,
  deleteCategory,
  resolveOrCreateCategoryFromSuggestion,
  CategoryNotFoundError,
  CategoryInUseError,
  InvalidParentCategoryError,
  CategoryCreationRateLimitedError,
} from "@/lib/data/categories";
import { resolveNewCategoryIcon } from "@/lib/categories";

// Phase 3.2 regression coverage: proves the { id, userId } ownership check
// on updateCategory/deleteCategory actually blocks cross-user access. No
// vulnerability was found here (see security-audit-report.md and the
// Phase 0 audit) - this locks the already-correct behavior in place
// against future regressions.
describe("cross-user ownership", () => {
  let userAId: number;
  let userBId: number;
  let categoryAId: number;

  beforeAll(async () => {
    const userA = await prisma.user.create({ data: { phoneNumber: `TEST-CATEGORY-OWNERSHIP-A-${Date.now()}` } });
    userAId = userA.id;
    const userB = await prisma.user.create({ data: { phoneNumber: `TEST-CATEGORY-OWNERSHIP-B-${Date.now()}` } });
    userBId = userB.id;

    const categoryA = await prisma.category.create({
      data: { userId: userAId, name: "دسته اصلی الف", icon: "🧪", color: "#444444", type: "expense" },
    });
    categoryAId = categoryA.id;
  }, 20000);

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  }, 20000);

  // See the matching comment in lib/data/transactions.test.ts's "cross-user
  // ownership" block: generous explicit timeouts here account for real
  // live-Turso network latency (T-1 in security-audit-report.md), not a
  // slow assertion.
  it(
    "updateCategory throws CategoryNotFoundError when called by another user, and leaves the row untouched",
    async () => {
      await expect(updateCategory(userBId, categoryAId, { name: "دستکاری شده" })).rejects.toBeInstanceOf(
        CategoryNotFoundError
      );

      const untouched = await prisma.category.findUnique({ where: { id: categoryAId } });
      expect(untouched?.name).toBe("دسته اصلی الف");
    },
    15000
  );

  it(
    "deleteCategory throws CategoryNotFoundError when called by another user, and the row still exists after",
    async () => {
      await expect(deleteCategory(userBId, categoryAId)).rejects.toBeInstanceOf(CategoryNotFoundError);

      const stillThere = await prisma.category.findUnique({ where: { id: categoryAId } });
      expect(stillThere).not.toBeNull();
    },
    15000
  );

  it(
    "the owner can still update their own category (sanity check the block above is ownership-specific)",
    async () => {
      const updated = await updateCategory(userAId, categoryAId, { name: "دسته اصلی الف - ویرایش شده" });
      expect(updated.name).toBe("دسته اصلی الف - ویرایش شده");
    },
    15000
  );
});

// Database checklist (docs/roadmap-status.md, Phase 16): "Deletion
// behavior: onDelete: Restrict on... Category->Transaction... a
// category/account with existing transactions can't be deleted - confirm
// this is tested, not just declared in schema." deleteCategory() already
// enforces this at the application level via a pre-check (see
// lib/data/categories.ts) - this had zero test coverage before this
// session.
describe("deleteCategory - in-use protection (Restrict)", () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-CATEGORY-INUSE-${Date.now()}` } });
    userId = user.id;
    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست دسته در حال استفاده", type: "cash", initialBalance: 0 },
    });
    accountId = account.id;
  }, 20000);

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.merchantMapping.deleteMany({ where: { userId } });
    // Children first: Category.parent uses onDelete: Restrict.
    await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "rejects deleting a category referenced by an existing transaction, and leaves both rows intact",
    async () => {
      const category = await prisma.category.create({
        data: { userId, name: "دسته در حال استفاده", icon: "🧪", color: "#333333", type: "expense" },
      });
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId: category.id,
          amount: 20000,
          type: "expense",
          date: new Date(),
          rawInput: "تست",
        },
      });

      await expect(deleteCategory(userId, category.id)).rejects.toBeInstanceOf(CategoryInUseError);

      expect(await prisma.category.findUnique({ where: { id: category.id } })).not.toBeNull();
      expect(await prisma.transaction.findUnique({ where: { id: transaction.id } })).not.toBeNull();
    },
    15000
  );

  it(
    "succeeds once the referencing transaction is gone",
    async () => {
      const category = await prisma.category.create({
        data: { userId, name: "دسته موقتاً در حال استفاده", icon: "🧪", color: "#333333", type: "expense" },
      });
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          accountId,
          categoryId: category.id,
          amount: 15000,
          type: "expense",
          date: new Date(),
          rawInput: "تست",
        },
      });

      await expect(deleteCategory(userId, category.id)).rejects.toBeInstanceOf(CategoryInUseError);

      await prisma.transaction.delete({ where: { id: transaction.id } });

      await expect(deleteCategory(userId, category.id)).resolves.toMatchObject({ id: category.id });
      expect(await prisma.category.findUnique({ where: { id: category.id } })).toBeNull();
    },
    15000
  );

  // deleteCategory() itself only pre-checks Transaction usage (see
  // lib/data/categories.ts) - it does NOT check for child categories before
  // deleting, unlike deleteDefaultCategory()'s explicit childCount guard
  // (lib/data/admin-categories.ts). So a parent category with children is
  // only ever protected by the DB's own schema-level Restrict on
  // Category.parent - confirmed directly here (not just declared in
  // schema.prisma), since deleteCategory() would otherwise let the
  // application-level check pass right through to a raw FK violation.
  it(
    "a parent category with a child is rejected at the DB level (Category.parent Restrict) when deleteCategory has no transaction usage to catch it",
    async () => {
      const parent = await prisma.category.create({
        data: { userId, name: "دسته والد با فرزند", icon: "🧪", color: "#333333", type: "expense" },
      });
      const child = await prisma.category.create({
        data: { userId, name: "دسته فرزند", icon: "🧪", color: "#333333", type: "expense", parentId: parent.id },
      });

      // No transaction references the parent, so deleteCategory()'s own
      // pre-check passes - the rejection below comes from the database
      // itself, not from CategoryInUseError.
      await expect(deleteCategory(userId, parent.id)).rejects.toThrow();

      expect(await prisma.category.findUnique({ where: { id: parent.id } })).not.toBeNull();
      expect(await prisma.category.findUnique({ where: { id: child.id } })).not.toBeNull();
    },
    15000
  );
});

// Pulled out of app/api/categories/route.ts's source: "ai-suggestion"
// branch (see lib/data/categories.ts's own comment on why) so both that
// route and POST /api/transactions/[id]/suggested-category's "accept"
// action share one resolution path. That route's own test file
// (app/api/categories/route.test.ts) already exercises this thoroughly
// end-to-end over HTTP - these tests cover the function's own contract
// directly instead of duplicating that coverage.
describe("resolveOrCreateCategoryFromSuggestion", () => {
  let userId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-RESOLVE-CATEGORY-SUGGESTION-${Date.now()}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    // Children first: Category.parent uses onDelete: Restrict (the
    // "resolves a valid same-type parentName" test below creates one).
    await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  // Deliberately unrelated single-word-ish names across this whole describe
  // block (same precedent as app/api/categories/route.test.ts's own
  // FILLER_CATEGORY_NAMES comment) - a shared suffix across test category
  // names would otherwise risk tripping findSimilarCategory's own >= 0.5
  // token-overlap fallback against an unrelated category from a different
  // test in this block, which is a real failure mode this suite hit before
  // this rename (see git history).
  it("creates a genuinely new category with a forced (not client-supplied) icon", async () => {
    const name = "زعفران";
    const result = await resolveOrCreateCategoryFromSuggestion(userId, { name, parentName: null, type: "expense" });

    expect(result.resolvedExisting).toBe(false);
    expect(result.category.name).toBe(name);
    expect(result.category.icon).toBe(resolveNewCategoryIcon(name));
    expect(result.category.color).toBe("#64748B");
  });

  it("resolves to an existing exact-name match instead of creating a duplicate", async () => {
    const existing = await prisma.category.create({
      data: { userId, name: "کوهنوردی", icon: "🛒", color: "#10B981", type: "expense" },
    });
    const countBefore = await prisma.category.count({ where: { userId } });

    const result = await resolveOrCreateCategoryFromSuggestion(userId, {
      name: existing.name,
      parentName: null,
      type: "expense",
    });

    expect(result.resolvedExisting).toBe(true);
    expect(result.category.id).toBe(existing.id);
    expect(await prisma.category.count({ where: { userId } })).toBe(countBefore);
  });

  // Without excludeArchived here, "پس‌انداز" token-overlaps the archived
  // "واریز به حساب پس‌انداز" at ratio 1.0 (normalizeText turns the
  // half-space into a plain space, so both carry the tokens پس/انداز) and
  // would resolve onto it - landing the accepted suggestion's transaction on
  // a retired category.
  it("never resolves onto an archived category, creating a new one instead", async () => {
    const archived = await prisma.category.create({
      data: { userId, name: "واریز به حساب پس‌انداز", icon: "💰", color: "#10B981", type: "expense", isArchived: true },
    });

    const result = await resolveOrCreateCategoryFromSuggestion(userId, {
      name: "پس‌انداز",
      parentName: null,
      type: "expense",
    });

    expect(result.resolvedExisting).toBe(false);
    expect(result.category.id).not.toBe(archived.id);
    expect(result.category.name).toBe("پس‌انداز");
  });

  it("resolves a valid same-type parentName to the parent's id", async () => {
    const parent = await prisma.category.create({
      data: { userId, name: "دوچرخه‌سواری", icon: "🧾", color: "#3B82F6", type: "expense" },
    });

    const result = await resolveOrCreateCategoryFromSuggestion(userId, {
      name: "قایقرانی",
      parentName: parent.name,
      type: "expense",
    });

    expect(result.category.parentId).toBe(parent.id);
  });

  it("throws InvalidParentCategoryError when parentName does not exist", async () => {
    await expect(
      resolveOrCreateCategoryFromSuggestion(userId, {
        name: "تیراندازی",
        parentName: "والدی که وجود ندارد",
        type: "expense",
      })
    ).rejects.toBeInstanceOf(InvalidParentCategoryError);
  });

  it("throws InvalidParentCategoryError when parentName exists but with a different type", async () => {
    const parent = await prisma.category.create({
      data: { userId, name: "دوومیدانی", icon: "💰", color: "#10B981", type: "income" },
    });

    await expect(
      resolveOrCreateCategoryFromSuggestion(userId, {
        name: "اسکیت",
        parentName: parent.name,
        type: "expense",
      })
    ).rejects.toBeInstanceOf(InvalidParentCategoryError);
  });

  it("throws CategoryCreationRateLimitedError once MAX_CATEGORIES_PER_24H is reached", async () => {
    const rateLimitedUser = await prisma.user.create({
      data: { phoneNumber: `TEST-RESOLVE-CATEGORY-RATE-LIMIT-${Date.now()}` },
    });
    const fillerNames = ["زرد ۲", "بنفش ۲", "نارنجی ۲", "خاکستری ۲", "صورتی ۲", "فیروزه‌ای ۲", "زیتونی ۲", "کرم ۲", "یاسی ۲", "سرمه‌ای ۲"];
    for (const name of fillerNames) {
      await prisma.category.create({
        data: { userId: rateLimitedUser.id, name, icon: "🧪", color: "#64748B", type: "expense" },
      });
    }

    await expect(
      resolveOrCreateCategoryFromSuggestion(rateLimitedUser.id, {
        name: "دسته یازدهم resolveOrCreate",
        parentName: null,
        type: "expense",
      })
    ).rejects.toBeInstanceOf(CategoryCreationRateLimitedError);

    await prisma.category.deleteMany({ where: { userId: rateLimitedUser.id } });
    await prisma.user.delete({ where: { id: rateLimitedUser.id } });
  });
});
