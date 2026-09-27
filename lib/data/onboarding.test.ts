import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedDefaultCategoriesForUser } from "@/lib/data/onboarding";

// DB-integration style, same conventions as lib/data/transactions.test.ts /
// lib/analytics/spending-summary.test.ts: real Prisma calls against the
// configured datasource, per-test user + cleanup rather than a shared
// beforeAll fixture, since this test mutates/depends on the global
// DefaultCategory table state.
async function cleanup(userId: number) {
  // Children first - Category.parentId's FK is onDelete: Restrict, so a
  // single deleteMany({ userId }) would fail on any parent row that still
  // has a child pointing at it.
  await prisma.category.deleteMany({ where: { userId, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("seedDefaultCategoriesForUser", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("copies each DefaultCategory's isEssential value onto the new user's own Category row - a realistic new-signup scenario, not a synthetic edge case", async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ONBOARDING-ESSENTIAL-${Date.now()}` },
    });

    try {
      await seedDefaultCategoriesForUser(user.id);

      // "رستوران و کافه" is seeded as isEssential: false (see prisma/seed.ts).
      // A brand-new user's copy of it should carry that same classification.
      const restaurant = await prisma.category.findFirst({
        where: { userId: user.id, name: "رستوران و کافه", type: "expense" },
      });
      expect(restaurant).not.toBeNull();
      expect(restaurant?.isEssential).toBe(false);

      // "مسکن" (a top-level default with no children present) is seeded as
      // isEssential: true - included to prove the parent-row create path is
      // also checked, not just the children createMany path above.
      const housing = await prisma.category.findFirst({
        where: { userId: user.id, name: "مسکن", type: "expense" },
      });
      expect(housing).not.toBeNull();
      expect(housing?.isEssential).toBe(true);
    } finally {
      await cleanup(user.id);
    }
  });

  it("never seeds an archived DefaultCategory (the retired \"واریز به حساب پس‌انداز\") for a new user", async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-ONBOARDING-DEPRECATED-${Date.now()}` },
    });

    // Simulates the real live-DB situation: this category was removed from
    // prisma/default-categories.ts, but prisma/seed.ts's upsert-only logic
    // never deletes a row it stops seeing in the array (see that file's own
    // comment), so an existing DefaultCategory row for it can still be
    // there - flagged isArchived by prisma/archive-retired-categories.ts.
    // Inserted directly (not via the seed array) specifically to prove
    // seedDefaultCategoriesForUser's own isArchived filter - not just the
    // absence of this row from the seed data - is what keeps it out.
    const parent = await prisma.defaultCategory.findFirst({
      where: { name: "پس‌انداز و سرمایه‌گذاری", type: "expense", parentId: null },
    });
    expect(parent).not.toBeNull();
    const stale = await prisma.defaultCategory.upsert({
      where: { name_type: { name: "واریز به حساب پس‌انداز", type: "expense" } },
      update: { parentId: parent!.id, isArchived: true },
      create: {
        name: "واریز به حساب پس‌انداز",
        icon: "💰",
        color: "#10B981",
        type: "expense",
        isEssential: true,
        isArchived: true,
        parentId: parent!.id,
      },
    });

    try {
      await seedDefaultCategoriesForUser(user.id);

      const deprecated = await prisma.category.findFirst({
        where: { userId: user.id, name: "واریز به حساب پس‌انداز", type: "expense" },
      });
      expect(deprecated).toBeNull();

      // Its sibling under the same parent is untouched by the exclusion -
      // only the one deprecated child is skipped.
      const gold = await prisma.category.findFirst({
        where: { userId: user.id, name: "خرید طلا و ارز", type: "expense" },
      });
      expect(gold).not.toBeNull();
    } finally {
      await cleanup(user.id);
      await prisma.defaultCategory.delete({ where: { id: stale.id } });
    }
  });
});
