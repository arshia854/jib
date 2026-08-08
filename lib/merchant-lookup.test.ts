import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { lookupGlobalMerchant, findMerchant } from "@/lib/merchant-lookup";

describe("lookupGlobalMerchant (pure, no DB)", () => {
  it("matches an exact merchant alias", () => {
    const result = lookupGlobalMerchant("دیجی کالا");
    expect(result.source).toBe("globalMerchant");
    expect(result.merchantName).toBe("دیجی‌کالا");
    expect(result.category).toBe("خرید");
    // دیجی‌کالا has no default subcategory - "خرید آنلاین" was never a
    // real seeded DefaultCategory (see the FIXED comment in
    // lib/merchants.ts); a general marketplace has no single honest fit
    // among خرید's real children (پوشاک, لوازم دیجیتال).
    expect(result.subcategory).toBeUndefined();
    expect(result.type).toBe("expense");
  });

  it("applies a keyword override when present", () => {
    const result = lookupGlobalMerchant("دیجی کالا کتاب خریدم");
    expect(result.source).toBe("keyword");
    expect(result.category).toBe("آموزش");
    // آموزش has no children in DEFAULT_CATEGORIES, so this override is
    // category-only (see the FIXED comment on the کتاب override in
    // lib/merchants.ts) - "کتاب" was never a real seeded subcategory.
    expect(result.subcategory).toBeUndefined();
    expect(result.type).toBe("expense");
  });

  it("returns none for unrelated text", () => {
    expect(lookupGlobalMerchant("سلام چطوری امروز").source).toBe("none");
  });
});

// Guards against the class of bug fixed for اسنپ/تپسی: a
// defaultSubcategory string in lib/merchants.ts that doesn't exactly match
// a real seeded DefaultCategory name (see lib/merchants.ts's top-of-file
// comment on why matching is by exact name). Checked against the live
// DefaultCategory table - the actual seed source (prisma/seed.ts) - rather
// than a hardcoded expected string, so a future rename on either side still
// gets caught instead of two copies of the same typo agreeing with each
// other.
describe("global merchant subcategories resolve to real seeded DefaultCategory names", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(["اسنپ", "تپسی"])("%s's subcategory matches a seeded DefaultCategory under its category", async (input) => {
    const result = lookupGlobalMerchant(input);
    expect(result.source).toBe("globalMerchant");
    expect(result.subcategory).toBeTruthy();

    const seeded = await prisma.defaultCategory.findFirst({
      where: { name: result.subcategory!, type: result.type },
      include: { parent: true },
    });
    expect(seeded).not.toBeNull();
    expect(seeded?.parent?.name).toBe(result.category);
  });
});

describe("findMerchant (DB-backed userMapping tier)", () => {
  let userId: number;
  let parentCategoryId: number;
  let subCategoryId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-MERCHANT-LOOKUP-${Date.now()}` },
    });
    userId = user.id;

    const parent = await prisma.category.create({
      data: { userId, name: "دسته تست مرچنت", icon: "🧪", color: "#000000", type: "expense" },
    });
    parentCategoryId = parent.id;
    const sub = await prisma.category.create({
      data: {
        userId,
        name: "زیردسته تست مرچنت",
        icon: "🧪",
        color: "#000000",
        type: "expense",
        parentId: parent.id,
      },
    });
    subCategoryId = sub.id;

    await prisma.merchantMapping.create({
      data: { userId, merchantKey: "فروشگاه تستی", categoryId: sub.id },
    });
  });

  afterAll(async () => {
    // Child (subcategory) must go before the parent - Category.parentId
    // has onDelete: Restrict, so deleting the parent first would fail the
    // FK constraint.
    await prisma.merchantMapping.deleteMany({ where: { userId } });
    await prisma.category.delete({ where: { id: subCategoryId } });
    await prisma.category.delete({ where: { id: parentCategoryId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("resolves a learned user mapping before the global list", async () => {
    const result = await findMerchant(userId, "فروشگاه تستی ۵۰ تومن خریدم");
    expect(result.source).toBe("userMapping");
    expect(result.category).toBe("دسته تست مرچنت");
    expect(result.subcategory).toBe("زیردسته تست مرچنت");
    expect(result.merchantName).toBe("فروشگاه تستی");
    expect(result.type).toBe("expense");
  });

  it("falls back to the global merchant list when no user mapping matches", async () => {
    const result = await findMerchant(userId, "دیجی کالا ۵۰ تومن");
    expect(result.source).toBe("globalMerchant");
  });

  it("returns none when nothing matches", async () => {
    const result = await findMerchant(userId, "سلام چطوری");
    expect(result.source).toBe("none");
  });
});
