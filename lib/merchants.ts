import { FALLBACK_EXPENSE_CATEGORY, type CategoryType } from "@/lib/categories";

export interface MerchantKeywordOverride {
  // If this keyword appears in the raw input alongside the merchant name,
  // use this category/subcategory instead of the merchant's default.
  keyword: string;
  category: string;
  subcategory?: string;
}

export interface DefaultMerchant {
  name: string;
  aliases: string[];
  type: CategoryType;
  defaultCategory: string;
  defaultSubcategory?: string;
  keywordOverrides?: MerchantKeywordOverride[];
}

// category/subcategory strings below must match Category.name values seeded
// by DEFAULT_CATEGORIES (lib/categories.ts) exactly, since matching is by
// name lookup (see lib/data/transactions.ts:createTransaction).
//
// Aliases are stored in their canonical display form, not pre-normalized.
// Match against normalizeText(rawInput) vs normalizeText(alias) at lookup
// time (lib/normalize.ts) - case-only alias variants (e.g. "digikala" /
// "DIGIKALA") are therefore omitted here since normalizeText() already
// lowercases both sides before comparison.
export const DEFAULT_MERCHANTS: DefaultMerchant[] = [
  // ---- Shopping ----
  {
    name: "دیجی‌کالا",
    aliases: ["دیجی کالا", "digikala"],
    type: "expense",
    defaultCategory: "خرید",
    // FIXED (category audit): "خرید آنلاین" was never a real seeded
    // subcategory - خرید's only real children are پوشاک and لوازم دیجیتال
    // (see prisma/seed.ts's DEFAULT_CATEGORIES). دیجی‌کالا is a general
    // marketplace (electronics, clothing, books, home goods, ...), so
    // neither real child is an honest *default* fit - forcing one would
    // mis-categorize every purchase that isn't actually digital/electronics.
    // Left as category-only; the keywordOverrides below already promote
    // the common specific cases (لپ‌تاپ/هدفون -> لوازم دیجیتال, کفش ->
    // پوشاک) to a real subcategory when the input signals which kind of
    // purchase it actually is.
    keywordOverrides: [
      // آموزش genuinely has no children in DEFAULT_CATEGORIES - dropped
      // rather than pairing with a subcategory that doesn't exist.
      { keyword: "کتاب", category: "آموزش" },
      { keyword: "لپ تاپ", category: "خرید", subcategory: "لوازم دیجیتال" },
      { keyword: "هدفون", category: "خرید", subcategory: "لوازم دیجیتال" },
      { keyword: "کفش", category: "خرید", subcategory: "پوشاک" },
    ],
  },
  {
    name: "ترب",
    aliases: ["torob"],
    type: "expense",
    defaultCategory: "خرید",
    // FIXED (category audit): same "خرید آنلاین" doesn't exist issue as
    // دیجی‌کالا above - ترب is a price-comparison engine spanning every
    // product category, so there's no single real خرید child that's an
    // honest default. Left category-only for the same reason.
  },
  {
    name: "تکنولایف",
    aliases: ["technolife"],
    type: "expense",
    defaultCategory: "خرید",
    // FIXED (category audit): "دیجیتال/الکترونیک" doesn't exist - the real
    // seeded name (prisma/seed.ts's DEFAULT_CATEGORIES) is "لوازم دیجیتال".
    defaultSubcategory: "لوازم دیجیتال",
  },
  {
    name: "مقداد آی‌تی",
    aliases: ["مقداد ای تی", "meghdadit"],
    type: "expense",
    defaultCategory: "خرید",
    // FIXED (category audit): same "دیجیتال/الکترونیک" -> "لوازم دیجیتال"
    // naming fix as تکنولایف above.
    defaultSubcategory: "لوازم دیجیتال",
  },

  // ---- Food ----
  // FIXED (category audit): "دلیوری آنلاین" was never a real seeded
  // subcategory - خوراک و رستوران's only real children are سوپرمارکت and
  // رستوران و کافه (see prisma/seed.ts's DEFAULT_CATEGORIES). Of the two,
  // رستوران و کافه is the honest fit: these three apps exist to order
  // prepared food *from restaurants*, delivered instead of eaten on-site -
  // the same underlying spend as dining out, just via an app - not grocery
  // shopping, which سوپرمارکت actually means here. Not a perfect 1:1 (e.g.
  // اسنپ‌فود's grocery-delivery add-on would arguably be سوپرمارکت), but a
  // deliberately closer/honester default than forcing either "no
  // subcategory" or the grocery bucket for what's overwhelmingly
  // restaurant-food delivery.
  {
    name: "اسنپ‌فود",
    aliases: ["اسنپ فود", "snappfood"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "رستوران و کافه",
  },
  {
    name: "تپسی‌فود",
    aliases: ["تپسی فود", "tapsifood"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "رستوران و کافه",
  },
  {
    name: "ریحون",
    aliases: ["reyhoon"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "رستوران و کافه",
    // NOTE: legacy/inactive service (shut down) - kept only so old
    // transactions/SMS referencing it still match a sensible category.
  },

  // ---- Transport ----
  {
    name: "اسنپ",
    aliases: ["snapp"],
    type: "expense",
    defaultCategory: "حمل‌ونقل",
    // FIXED (category audit): was "تاکسی/اسنپ" - the real seeded name
    // (prisma/seed.ts's DEFAULT_CATEGORIES) is "تاکسی و اسنپ". A subtle
    // one-character-class mismatch (slash vs. "و") is exactly as fatal to
    // the exact-name lookup in resolveCategoryOverride as a completely
    // wrong string - previously believed already fixed, but wasn't.
    defaultSubcategory: "تاکسی و اسنپ",
    // TODO(matcher): "اسنپ" is a prefix of "اسنپ‌فود" - once matching logic
    // is implemented it MUST require اسنپ as a standalone token (word
    // boundary) and must not match when the next token is "فود", otherwise
    // every SnappFood transaction will also match this Transport entry.
  },
  {
    name: "تپسی",
    aliases: ["tapsi"],
    type: "expense",
    defaultCategory: "حمل‌ونقل",
    // FIXED (category audit): same "تاکسی/اسنپ" -> "تاکسی و اسنپ" fix as
    // اسنپ above.
    defaultSubcategory: "تاکسی و اسنپ",
  },

  // ---- Entertainment ----
  // FIXED (category audit): "اشتراک‌های دیجیتال" was never a real seeded
  // subcategory - تفریح و سرگرمی's only real child is سفر (Travel), which
  // is clearly not a fit for streaming subscriptions. No real subcategory
  // here honestly fits, so these four are left category-only rather than
  // forced into سفر.
  {
    name: "فیلیمو",
    aliases: ["filimo"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
  },
  {
    name: "نماوا",
    aliases: ["namava"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
  },
  {
    name: "اسپاتیفای",
    aliases: ["spotify"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
  },
  {
    name: "یوتیوب پریمیوم",
    aliases: ["youtube premium", "یوتیوب پریمیوم"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
  },

  // ---- Marketplace ----
  {
    name: "دیوار",
    aliases: ["divar"],
    type: "expense",
    defaultCategory: "خرید",
    // TODO(categories): spec's "Marketplace" subcategory doesn't exist in
    // DEFAULT_CATEGORIES (خرید only has پوشاک / دیجیتال/الکترونیک /
    // خرید آنلاین). Left unset rather than guessing a wrong match - needs
    // either a new "Marketplace" subcategory added to lib/categories.ts or
    // a decision to fold these into خرید آنلاین.
  },
  {
    name: "شیپور",
    aliases: ["sheypoor"],
    type: "expense",
    defaultCategory: "خرید",
  },

  // ---- Payment ----
  // NOTE: these are payment gateways/intermediaries, not real spending
  // categories - in practice they often show up in SMS as an intermediate
  // step before the actual merchant. Not handling that distinction now
  // (would need transaction-level "resolve through gateway" logic); seeded
  // with best-guess category only. TODO: revisit once gateway-passthrough
  // parsing is designed.
  {
    name: "زرین‌پال",
    aliases: ["زرین پال", "zarinpal"],
    type: "expense",
    // FIXED (category audit): bare "سایر" was never a real seeded category
    // - the real fallback bucket is "سایر هزینه‌ها" (see
    // FALLBACK_EXPENSE_CATEGORY in lib/categories.ts, imported above rather
    // than hardcoded again here so this can't drift out of sync with it).
    // سایر has no subcategories in DEFAULT_CATEGORIES; spec's "Payment
    // Gateway" subcategory doesn't exist yet either.
    defaultCategory: FALLBACK_EXPENSE_CATEGORY,
  },
  {
    name: "نکست‌پی",
    aliases: ["نکست پی", "nextpay"],
    type: "expense",
    // FIXED (category audit): same bare "سایر" fix as زرین‌پال above.
    defaultCategory: FALLBACK_EXPENSE_CATEGORY,
  },
  {
    name: "آپ",
    aliases: ["ap"],
    type: "expense",
    // FIXED (category audit): same bare "سایر" fix as زرین‌پال above.
    defaultCategory: FALLBACK_EXPENSE_CATEGORY,
    // TODO(matcher): "آپ" is a single short token (2 chars) with a very
    // high false-positive risk as a substring/loose match inside unrelated
    // Persian text. Do NOT include in loose/substring matching - require
    // exact whole-token match only, and even then treat with suspicion.
  },
  {
    name: "تاپ",
    aliases: ["tap"],
    type: "expense",
    // FIXED (category audit): same bare "سایر" fix as زرین‌پال above.
    defaultCategory: FALLBACK_EXPENSE_CATEGORY,
    // TODO(matcher): same high collision risk as آپ above - exact
    // whole-token match only, never substring.
    // (Spec listed aliases as "top, TAP" - "top" looks like a typo for
    // "tap" given تاپ transliterates to "tap"; used "tap" here. Flag if
    // "top" was actually intended as a separate alias.)
  },
];
