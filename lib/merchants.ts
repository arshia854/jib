import type { CategoryType } from "@/lib/categories";

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
    defaultSubcategory: "خرید آنلاین",
    keywordOverrides: [
      { keyword: "کتاب", category: "آموزش", subcategory: "کتاب" },
      { keyword: "لپ تاپ", category: "خرید", subcategory: "دیجیتال/الکترونیک" },
      { keyword: "هدفون", category: "خرید", subcategory: "دیجیتال/الکترونیک" },
      { keyword: "کفش", category: "خرید", subcategory: "پوشاک" },
    ],
  },
  {
    name: "ترب",
    aliases: ["torob"],
    type: "expense",
    defaultCategory: "خرید",
    defaultSubcategory: "خرید آنلاین",
  },
  {
    name: "تکنولایف",
    aliases: ["technolife"],
    type: "expense",
    defaultCategory: "خرید",
    // Spec said "Electronics" - DEFAULT_CATEGORIES has no standalone
    // "Electronics" subcategory under خرید, closest existing match is
    // دیجیتال/الکترونیک (Shopping > Digital/Electronics).
    defaultSubcategory: "دیجیتال/الکترونیک",
  },
  {
    name: "مقداد آی‌تی",
    aliases: ["مقداد ای تی", "meghdadit"],
    type: "expense",
    defaultCategory: "خرید",
    defaultSubcategory: "دیجیتال/الکترونیک",
  },

  // ---- Food ----
  {
    name: "اسنپ‌فود",
    aliases: ["اسنپ فود", "snappfood"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "دلیوری آنلاین",
  },
  {
    name: "تپسی‌فود",
    aliases: ["تپسی فود", "tapsifood"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "دلیوری آنلاین",
  },
  {
    name: "ریحون",
    aliases: ["reyhoon"],
    type: "expense",
    defaultCategory: "خوراک و رستوران",
    defaultSubcategory: "دلیوری آنلاین",
    // NOTE: legacy/inactive service (shut down) - kept only so old
    // transactions/SMS referencing it still match a sensible category.
  },

  // ---- Transport ----
  {
    name: "اسنپ",
    aliases: ["snapp"],
    type: "expense",
    defaultCategory: "حمل‌ونقل",
    defaultSubcategory: "تاکسی/اسنپ",
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
    defaultSubcategory: "تاکسی/اسنپ",
  },

  // ---- Entertainment ----
  {
    name: "فیلیمو",
    aliases: ["filimo"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
    defaultSubcategory: "اشتراک‌های دیجیتال",
  },
  {
    name: "نماوا",
    aliases: ["namava"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
    defaultSubcategory: "اشتراک‌های دیجیتال",
  },
  {
    name: "اسپاتیفای",
    aliases: ["spotify"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
    defaultSubcategory: "اشتراک‌های دیجیتال",
  },
  {
    name: "یوتیوب پریمیوم",
    aliases: ["youtube premium", "یوتیوب پریمیوم"],
    type: "expense",
    defaultCategory: "تفریح و سرگرمی",
    defaultSubcategory: "اشتراک‌های دیجیتال",
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
    defaultCategory: "سایر",
    // TODO(categories): سایر has no subcategories in DEFAULT_CATEGORIES;
    // spec's "Payment Gateway" subcategory doesn't exist yet.
  },
  {
    name: "نکست‌پی",
    aliases: ["نکست پی", "nextpay"],
    type: "expense",
    defaultCategory: "سایر",
  },
  {
    name: "آپ",
    aliases: ["ap"],
    type: "expense",
    defaultCategory: "سایر",
    // TODO(matcher): "آپ" is a single short token (2 chars) with a very
    // high false-positive risk as a substring/loose match inside unrelated
    // Persian text. Do NOT include in loose/substring matching - require
    // exact whole-token match only, and even then treat with suspicion.
  },
  {
    name: "تاپ",
    aliases: ["tap"],
    type: "expense",
    defaultCategory: "سایر",
    // TODO(matcher): same high collision risk as آپ above - exact
    // whole-token match only, never substring.
    // (Spec listed aliases as "top, TAP" - "top" looks like a typo for
    // "tap" given تاپ transliterates to "tap"; used "tap" here. Flag if
    // "top" was actually intended as a separate alias.)
  },
];
