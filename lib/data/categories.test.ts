import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateCategory, deleteCategory, CategoryNotFoundError, CategoryInUseError } from "@/lib/data/categories";

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
