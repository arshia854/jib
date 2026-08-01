export type CategoryType = "income" | "expense";

export interface DefaultSubcategory {
  name: string;
  // Omit to inherit the parent main category's icon/color.
  icon?: string;
  color?: string;
}

export interface DefaultCategory {
  name: string;
  icon: string;
  color: string;
  type: CategoryType;
  isTransfer?: boolean;
  subcategories?: DefaultSubcategory[];
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // ---- expense: main categories ----
  {
    name: "خوراک و رستوران",
    icon: "🍔",
    color: "#F97316",
    type: "expense",
    subcategories: [{ name: "سوپرمارکت" }, { name: "رستوران/کافه" }, { name: "دلیوری آنلاین" }],
  },
  {
    name: "خانه و زندگی",
    icon: "🏠",
    color: "#1E3A8A",
    type: "expense",
    subcategories: [
      { name: "اجاره/قسط مسکن" },
      { name: "قبوض خانه" },
      { name: "لوازم خانه" },
      { name: "تعمیرات" },
    ],
  },
  {
    name: "حمل‌ونقل",
    icon: "🚗",
    color: "#3B82F6",
    type: "expense",
    subcategories: [
      { name: "بنزین" },
      { name: "تاکسی/اسنپ" },
      { name: "تعمیر خودرو" },
      { name: "بلیط سفر" },
    ],
  },
  {
    name: "تفریح و سرگرمی",
    icon: "🎬",
    color: "#8B5CF6",
    type: "expense",
    subcategories: [{ name: "سینما/کنسرت" }, { name: "اشتراک‌های دیجیتال" }, { name: "بازی" }],
  },
  {
    name: "خرید",
    icon: "🛍️",
    color: "#EC4899",
    type: "expense",
    subcategories: [{ name: "پوشاک" }, { name: "دیجیتال/الکترونیک" }, { name: "خرید آنلاین" }],
  },
  {
    name: "سلامت و درمان",
    icon: "💊",
    color: "#EF4444",
    type: "expense",
    subcategories: [{ name: "دارو" }, { name: "ویزیت پزشک" }, { name: "باشگاه" }],
  },
  {
    name: "آموزش",
    icon: "📚",
    color: "#06B6D4",
    type: "expense",
    subcategories: [{ name: "کلاس" }, { name: "کتاب" }, { name: "دوره آنلاین" }],
  },
  {
    name: "قبوض و اشتراک",
    icon: "🧾",
    color: "#64748B",
    type: "expense",
    subcategories: [{ name: "موبایل" }, { name: "اینترنت" }, { name: "بیمه" }],
  },
  { name: "انتقال بین حساب‌ها", icon: "🔄", color: "#14B8A6", type: "expense", isTransfer: true },
  { name: "سایر", icon: "📦", color: "#94A3B8", type: "expense" },

  // ---- income: main categories ----
  {
    name: "درآمد",
    icon: "💵",
    color: "#059669",
    type: "income",
    subcategories: [
      { name: "حقوق", icon: "💰", color: "#10B981" },
      { name: "فریلنس", icon: "💼", color: "#3B82F6" },
      { name: "هدیه", icon: "🎁", color: "#EC4899" },
      { name: "سرمایه‌گذاری", icon: "📈", color: "#1E3A8A" },
    ],
  },
  { name: "انتقال بین حساب‌ها", icon: "🔄", color: "#14B8A6", type: "income", isTransfer: true },
  { name: "سایر", icon: "📦", color: "#94A3B8", type: "income" },
];

export const DEFAULT_ACCOUNT = {
  name: "کیف پول",
  type: "cash",
  initialBalance: 0,
};
