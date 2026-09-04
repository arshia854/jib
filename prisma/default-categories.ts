// Pure data, no side effects - deliberately split out of prisma/seed.ts so
// it can be imported (e.g. by test/setup/global-setup.ts) without also
// triggering that file's top-level main() call. seed.ts imports
// DEFAULT_CATEGORIES from here rather than defining it inline; this file
// must never import "@/lib/prisma" or do any I/O itself.
export interface DefaultCategorySeed {
  name: string;
  icon: string;
  color: string;
  type: "income" | "expense";
  // Essential vs discretionary spending classification (see
  // lib/analytics/spending-summary.ts's discretionaryExpense). Meaningless
  // for income categories - always `true` there, just the harmless schema
  // default, so nothing downstream has to special-case income type.
  isEssential: boolean;
  children?: { name: string; icon: string; color: string; isEssential: boolean }[];
}

export const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  // ---------- EXPENSE ----------
  {
    name: "خوراک و رستوران", icon: "🍔", color: "#F97316", type: "expense", isEssential: true,
    children: [
      { name: "سوپرمارکت", icon: "🛒", color: "#F97316", isEssential: true },
      { name: "میوه و سبزیجات", icon: "🍎", color: "#F97316", isEssential: true },
      { name: "رستوران و کافه", icon: "☕", color: "#F97316", isEssential: false },
      { name: "غذای بیرون‌بر", icon: "🥡", color: "#F97316", isEssential: false },
    ],
  },
  {
    name: "حمل‌ونقل", icon: "🚗", color: "#3B82F6", type: "expense", isEssential: true,
    children: [
      { name: "بنزین", icon: "⛽", color: "#3B82F6", isEssential: true },
      { name: "تاکسی و اسنپ", icon: "🚕", color: "#3B82F6", isEssential: true },
      { name: "تعمیر و سرویس خودرو", icon: "🔧", color: "#3B82F6", isEssential: true },
      { name: "مترو و اتوبوس", icon: "🚇", color: "#3B82F6", isEssential: true },
      { name: "پارکینگ و جریمه", icon: "🅿️", color: "#3B82F6", isEssential: false },
    ],
  },
  {
    name: "خرید", icon: "🛍️", color: "#EC4899", type: "expense", isEssential: false,
    children: [
      { name: "پوشاک", icon: "👕", color: "#EC4899", isEssential: false },
      { name: "لوازم دیجیتال", icon: "📱", color: "#EC4899", isEssential: false },
      { name: "لوازم و اثاثیه خانه", icon: "🛋️", color: "#EC4899", isEssential: false },
      { name: "اکسسوری و زیورآلات", icon: "💍", color: "#EC4899", isEssential: false },
    ],
  },
  {
    name: "قبوض و اشتراک", icon: "🧾", color: "#64748B", type: "expense", isEssential: true,
    children: [
      { name: "برق، آب و گاز", icon: "💡", color: "#64748B", isEssential: true },
      { name: "اینترنت و تلفن", icon: "📶", color: "#64748B", isEssential: true },
      { name: "شارژ موبایل", icon: "📲", color: "#64748B", isEssential: true },
      { name: "اشتراک نرم‌افزار و سرویس", icon: "🔄", color: "#64748B", isEssential: false },
    ],
  },
  {
    name: "مسکن", icon: "🏠", color: "#1E3A8A", type: "expense", isEssential: true,
    children: [
      { name: "اجاره", icon: "🏠", color: "#1E3A8A", isEssential: true },
      { name: "قسط وام مسکن", icon: "🏦", color: "#1E3A8A", isEssential: true },
      { name: "شارژ ساختمان", icon: "🏢", color: "#1E3A8A", isEssential: true },
      { name: "تعمیر و نگهداری منزل", icon: "🛠️", color: "#1E3A8A", isEssential: true },
    ],
  },
  {
    name: "سلامت", icon: "💊", color: "#EF4444", type: "expense", isEssential: true,
    children: [
      { name: "دارو", icon: "💊", color: "#EF4444", isEssential: true },
      { name: "ویزیت پزشک", icon: "🩺", color: "#EF4444", isEssential: true },
      { name: "دندان‌پزشکی", icon: "🦷", color: "#EF4444", isEssential: true },
      { name: "آزمایش و تصویربرداری", icon: "🔬", color: "#EF4444", isEssential: true },
    ],
  },
  {
    name: "تفریح و سرگرمی", icon: "🎬", color: "#8B5CF6", type: "expense", isEssential: false,
    children: [
      { name: "سینما و کنسرت", icon: "🎭", color: "#8B5CF6", isEssential: false },
      { name: "بازی و اشتراک سرگرمی", icon: "🎮", color: "#8B5CF6", isEssential: false },
      { name: "کتاب و مجله", icon: "📖", color: "#8B5CF6", isEssential: false },
      { name: "گردش و تفریح بیرون از خانه", icon: "🎡", color: "#8B5CF6", isEssential: false },
    ],
  },
  {
    name: "آموزش", icon: "📚", color: "#06B6D4", type: "expense", isEssential: true,
    children: [
      { name: "شهریه مدرسه و دانشگاه", icon: "🎓", color: "#06B6D4", isEssential: true },
      { name: "دوره و کلاس آنلاین", icon: "💻", color: "#06B6D4", isEssential: false },
      { name: "کتاب و لوازم‌التحریر", icon: "✏️", color: "#06B6D4", isEssential: true },
      { name: "کلاس زبان", icon: "🗣️", color: "#06B6D4", isEssential: false },
    ],
  },
  {
    name: "سفر", icon: "✈️", color: "#0EA5E9", type: "expense", isEssential: false,
    children: [
      { name: "بلیط سفر", icon: "🎫", color: "#0EA5E9", isEssential: false },
      { name: "هتل و اقامتگاه", icon: "🏨", color: "#0EA5E9", isEssential: false },
      { name: "تور مسافرتی", icon: "🗺️", color: "#0EA5E9", isEssential: false },
    ],
  },
  {
    name: "ورزش و تناسب‌اندام", icon: "🏋️", color: "#22C55E", type: "expense", isEssential: false,
    children: [
      { name: "اشتراک باشگاه", icon: "🏋️", color: "#22C55E", isEssential: false },
      { name: "لوازم ورزشی", icon: "⚽", color: "#22C55E", isEssential: false },
      { name: "مربی شخصی و کلاس ورزشی", icon: "🤸", color: "#22C55E", isEssential: false },
    ],
  },
  {
    name: "حیوان خانگی", icon: "🐾", color: "#F59E0B", type: "expense", isEssential: true,
    children: [
      { name: "غذای حیوان خانگی", icon: "🍖", color: "#F59E0B", isEssential: true },
      { name: "دامپزشک", icon: "🐶", color: "#F59E0B", isEssential: true },
      { name: "لوازم حیوان خانگی", icon: "🦴", color: "#F59E0B", isEssential: false },
    ],
  },
  {
    name: "خدمات شخصی و زیبایی", icon: "💇", color: "#FB7185", type: "expense", isEssential: false,
    children: [
      { name: "آرایشگاه و سالن زیبایی", icon: "💇", color: "#FB7185", isEssential: false },
      { name: "لوازم آرایشی و بهداشتی", icon: "🧴", color: "#FB7185", isEssential: true },
      { name: "خشکشویی", icon: "👔", color: "#FB7185", isEssential: false },
    ],
  },
  {
    name: "بیمه", icon: "🛡️", color: "#14B8A6", type: "expense", isEssential: true,
    children: [
      { name: "بیمه درمان تکمیلی", icon: "🩹", color: "#14B8A6", isEssential: true },
      { name: "بیمه خودرو", icon: "🚙", color: "#14B8A6", isEssential: true },
      { name: "بیمه منزل", icon: "🏠", color: "#14B8A6", isEssential: false },
    ],
  },
  {
    name: "اقساط و بدهی", icon: "💳", color: "#78716C", type: "expense", isEssential: true,
    children: [
      { name: "قسط وام شخصی", icon: "🏦", color: "#78716C", isEssential: true },
      { name: "بازپرداخت کارت اعتباری", icon: "💳", color: "#78716C", isEssential: true },
      { name: "چک و سفته", icon: "📄", color: "#78716C", isEssential: true },
    ],
  },
  {
    name: "پس‌انداز و سرمایه‌گذاری", icon: "📈", color: "#10B981", type: "expense", isEssential: false,
    children: [
      { name: "واریز به حساب پس‌انداز", icon: "💰", color: "#10B981", isEssential: false },
      { name: "خرید طلا و ارز", icon: "🪙", color: "#10B981", isEssential: false },
      { name: "صندوق سرمایه‌گذاری و بورس", icon: "📊", color: "#10B981", isEssential: false },
    ],
  },
  {
    name: "هدیه و خیریه", icon: "🎁", color: "#F43F5E", type: "expense", isEssential: false,
    children: [
      { name: "هدیه تولد و مناسبت", icon: "🎁", color: "#F43F5E", isEssential: false },
      { name: "کمک مالی به خانواده", icon: "❤️", color: "#F43F5E", isEssential: true },
      { name: "خیریه و صدقه", icon: "🤲", color: "#F43F5E", isEssential: false },
    ],
  },
  {
    name: "سایر هزینه‌ها", icon: "🔖", color: "#94A3B8", type: "expense", isEssential: false,
  },

  // ---------- INCOME ----------
  { name: "حقوق", icon: "💰", color: "#10B981", type: "income", isEssential: true },
  { name: "درآمد آزاد", icon: "💼", color: "#10B981", type: "income", isEssential: true },
  {
    name: "سرمایه‌گذاری", icon: "📈", color: "#10B981", type: "income", isEssential: true,
    children: [
      { name: "سود سپرده بانکی", icon: "🏦", color: "#10B981", isEssential: true },
      { name: "سود سهام و صندوق", icon: "📊", color: "#10B981", isEssential: true },
    ],
  },
  { name: "اجاره‌ی ملک", icon: "🏠", color: "#10B981", type: "income", isEssential: true },
  { name: "هدیه", icon: "🎁", color: "#10B981", type: "income", isEssential: true },
  { name: "سایر درآمدها", icon: "➕", color: "#10B981", type: "income", isEssential: true },
];
