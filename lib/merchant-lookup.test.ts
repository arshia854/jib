import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { lookupGlobalMerchant, findMerchant, buildMerchantKey } from "@/lib/merchant-lookup";

// Regression (docs/roadmap-status.md, Phase 7/8 correction): merchantKey
// used to be the entire raw SMS/typed text, amount digits included -
// normalizeText() never strips digits, so a learned mapping only ever
// re-matched a later transaction quoting the identical amount. These are
// pure unit tests of the extraction itself, no DB - see the "findMerchant"
// describe block below for the DB-backed end-to-end regression/
// false-positive coverage.
describe("buildMerchantKey", () => {
  it("strips a trailing amount (Persian digits)", () => {
    expect(buildMerchantKey("فروشگاه یک ۵۰۰۰۰")).toBe("فروشگاه یک");
  });

  it("strips amount digits regardless of script (Latin/Arabic-Indic)", () => {
    const key = buildMerchantKey("فروشگاه یک ۵۰۰۰۰");
    expect(buildMerchantKey("فروشگاه یک 50000")).toBe(key);
    expect(buildMerchantKey("فروشگاه یک ٥٠٠٠٠")).toBe(key);
  });

  it("two texts for the same merchant differing only in amount produce the same key", () => {
    expect(buildMerchantKey("کافه دو ۲۰۰۰۰")).toBe(buildMerchantKey("کافه دو ۷۵۰۰۰"));
  });

  it("strips the closed set of relative-date words extractDate.ts recognizes", () => {
    const bare = buildMerchantKey("اسنپ گرفتم");
    expect(buildMerchantKey("دیروز اسنپ گرفتم")).toBe(bare);
    expect(buildMerchantKey("امروز اسنپ گرفتم")).toBe(bare);
    expect(buildMerchantKey("پریروز اسنپ گرفتم")).toBe(bare);
    expect(buildMerchantKey("هفته پیش اسنپ گرفتم")).toBe(bare);
  });

  it("preserves the order of remaining tokens and does not collapse distinct merchants", () => {
    expect(buildMerchantKey("فروشگاه یک ۵۰۰۰۰")).not.toBe(buildMerchantKey("فروشگاه دو ۵۰۰۰۰"));
    expect(buildMerchantKey("کافه شمال ۲۰۰۰۰")).not.toBe(buildMerchantKey("کافه جنوب ۲۰۰۰۰"));
  });

  it("returns an empty string for text that is entirely digits/date-words, without throwing", () => {
    expect(buildMerchantKey("۵۰۰۰۰")).toBe("");
    expect(buildMerchantKey("دیروز")).toBe("");
  });

  // An amount sitting *between* the merchant name and a trailing currency
  // word (e.g. "... ۳۰۰۰۰ تومن") must not produce a key that glues the
  // merchant name directly onto "تومن" - that adjacency never existed in
  // the original text, and a later mention with a different amount still
  // has its own amount token in that same gap, so it would never
  // reproduce a glued-together candidate. The longest surviving run (the
  // merchant name itself) must win over the short "تومن"-only run instead.
  it("does not glue words together across a stripped internal amount token", () => {
    const key = buildMerchantKey("فروشگاه ناشناخته هشتاد ۳۰۰۰۰ تومن");
    expect(key).toBe("فروشگاه ناشناخته هشتاد");
    expect(key).not.toContain("تومن");
  });
});

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

// DB-backed complement to the pure buildMerchantKey tests above - proves
// the fix end-to-end through findMerchant()/findBestMatch(), the same
// entry point real transaction parsing uses, and that fixing the
// amount-collapsing bug does not introduce a new false-positive collapsing
// bug between genuinely distinct merchants (docs/roadmap-status.md, Phase
// 7/8 correction).
describe("findMerchant (merchantKey generalizes across amount, not across merchants)", () => {
  let userId: number;
  let categoryOneId: number;
  let categoryTwoId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-MERCHANT-KEY-REGRESSION-${Date.now()}` },
    });
    userId = user.id;

    const categoryOne = await prisma.category.create({
      data: { userId, name: "دسته مرچنت یک", icon: "🧪", color: "#000000", type: "expense" },
    });
    categoryOneId = categoryOne.id;
    const categoryTwo = await prisma.category.create({
      data: { userId, name: "دسته مرچنت دو", icon: "🧪", color: "#111111", type: "expense" },
    });
    categoryTwoId = categoryTwo.id;

    // Mirrors what updateTransaction() itself would store post-fix - built
    // via buildMerchantKey directly (not through updateTransaction) so this
    // exercises the write/read contract at the merchant-lookup level in
    // isolation from the transaction-mutation code path already covered in
    // lib/data/transactions.test.ts.
    await prisma.merchantMapping.create({
      data: { userId, merchantKey: buildMerchantKey("فروشگاه یک ۵۰۰۰۰"), categoryId: categoryOneId },
    });
    await prisma.merchantMapping.create({
      data: { userId, merchantKey: buildMerchantKey("فروشگاه دو ۵۰۰۰۰"), categoryId: categoryTwoId },
    });
  });

  afterAll(async () => {
    await prisma.merchantMapping.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("resolves a later mention at the same merchant with a different amount (the bug this session fixed)", async () => {
    const result = await findMerchant(userId, "فروشگاه یک ۹۹۰۰۰ تومن خریدم");
    expect(result.source).toBe("userMapping");
    expect(result.category).toBe("دسته مرچنت یک");
  });

  it("does not collapse two distinct merchants with superficially similar text into the same mapping", async () => {
    const one = await findMerchant(userId, "فروشگاه یک ۱۲۰۰۰ تومن خریدم");
    const two = await findMerchant(userId, "فروشگاه دو ۱۲۰۰۰ تومن خریدم");

    expect(one.source).toBe("userMapping");
    expect(one.category).toBe("دسته مرچنت یک");
    expect(two.source).toBe("userMapping");
    expect(two.category).toBe("دسته مرچنت دو");
  });
});
