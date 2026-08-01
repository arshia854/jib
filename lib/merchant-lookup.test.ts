import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { lookupGlobalMerchant, findMerchant } from "@/lib/merchant-lookup";

describe("lookupGlobalMerchant (pure, no DB)", () => {
  it("matches an exact merchant alias", () => {
    const result = lookupGlobalMerchant("دیجی کالا");
    expect(result.source).toBe("globalMerchant");
    expect(result.merchantName).toBe("دیجی‌کالا");
    expect(result.category).toBe("خرید");
    expect(result.subcategory).toBe("خرید آنلاین");
    expect(result.type).toBe("expense");
  });

  it("applies a keyword override when present", () => {
    const result = lookupGlobalMerchant("دیجی کالا کتاب خریدم");
    expect(result.source).toBe("keyword");
    expect(result.category).toBe("آموزش");
    expect(result.subcategory).toBe("کتاب");
    expect(result.type).toBe("expense");
  });

  it("returns none for unrelated text", () => {
    expect(lookupGlobalMerchant("سلام چطوری امروز").source).toBe("none");
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
