// Seeds the global DefaultCategory table (see prisma/schema.prisma) that
// lib/data/onboarding.ts copies into each new user's own Category rows.
import "dotenv/config";
import { prisma } from "@/lib/prisma";

interface DefaultCategorySeed {
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

const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  {
    name: "خوراک و رستوران",
    icon: "🍔",
    color: "#F97316",
    type: "expense",
    // The parent itself has no direct transactions in practice - a
    // transaction always picks a subcategory. Set to true (matching
    // سوپرمارکت, the more common of its two children) so this only matters
    // in the edge case of a transaction saved directly against the parent
    // with no subcategory.
    isEssential: true,
    children: [
      { name: "سوپرمارکت", icon: "🛒", color: "#F97316", isEssential: true },
      { name: "رستوران و کافه", icon: "☕", color: "#F97316", isEssential: false },
    ],
  },
  {
    name: "حمل‌ونقل",
    icon: "🚗",
    color: "#3B82F6",
    type: "expense",
    isEssential: true,
    children: [
      { name: "بنزین", icon: "⛽", color: "#3B82F6", isEssential: true },
      { name: "تاکسی و اسنپ", icon: "🚕", color: "#3B82F6", isEssential: true },
    ],
  },
  {
    name: "خرید",
    icon: "🛍️",
    color: "#EC4899",
    type: "expense",
    isEssential: false,
    children: [
      { name: "پوشاک", icon: "👕", color: "#EC4899", isEssential: false },
      { name: "لوازم دیجیتال", icon: "📱", color: "#EC4899", isEssential: false },
    ],
  },
  {
    name: "قبوض و اشتراک",
    icon: "🧾",
    color: "#64748B",
    type: "expense",
    isEssential: true,
    children: [
      { name: "برق، آب و گاز", icon: "💡", color: "#64748B", isEssential: true },
      { name: "اینترنت و تلفن", icon: "📶", color: "#64748B", isEssential: true },
    ],
  },
  {
    name: "مسکن",
    icon: "🏠",
    color: "#1E3A8A",
    type: "expense",
    isEssential: true,
    children: [{ name: "اجاره", icon: "🏠", color: "#1E3A8A", isEssential: true }],
  },
  {
    name: "سلامت",
    icon: "💊",
    color: "#EF4444",
    type: "expense",
    isEssential: true,
    children: [
      { name: "دارو", icon: "💊", color: "#EF4444", isEssential: true },
      { name: "ویزیت پزشک", icon: "🩺", color: "#EF4444", isEssential: true },
    ],
  },
  {
    name: "تفریح و سرگرمی",
    icon: "🎬",
    color: "#8B5CF6",
    type: "expense",
    isEssential: false,
    children: [{ name: "سفر", icon: "✈️", color: "#8B5CF6", isEssential: false }],
  },
  {
    name: "آموزش",
    icon: "📚",
    color: "#06B6D4",
    type: "expense",
    isEssential: true,
  },
  {
    name: "سایر هزینه‌ها",
    icon: "🔖",
    color: "#94A3B8",
    type: "expense",
    isEssential: false,
  },
  {
    name: "حقوق",
    icon: "💰",
    color: "#10B981",
    type: "income",
    isEssential: true,
  },
  {
    name: "درآمد آزاد",
    icon: "💼",
    color: "#10B981",
    type: "income",
    isEssential: true,
  },
  {
    name: "سرمایه‌گذاری",
    icon: "📈",
    color: "#10B981",
    type: "income",
    isEssential: true,
  },
  {
    name: "هدیه",
    icon: "🎁",
    color: "#10B981",
    type: "income",
    isEssential: true,
  },
  {
    name: "سایر درآمدها",
    icon: "➕",
    color: "#10B981",
    type: "income",
    isEssential: true,
  },
];

async function main() {
  for (const category of DEFAULT_CATEGORIES) {
    const parent = await prisma.defaultCategory.upsert({
      where: { name_type: { name: category.name, type: category.type } },
      update: { icon: category.icon, color: category.color, isEssential: category.isEssential },
      create: {
        name: category.name,
        icon: category.icon,
        color: category.color,
        type: category.type,
        isEssential: category.isEssential,
      },
    });

    for (const child of category.children ?? []) {
      await prisma.defaultCategory.upsert({
        where: { name_type: { name: child.name, type: category.type } },
        update: { icon: child.icon, color: child.color, parentId: parent.id, isEssential: child.isEssential },
        create: {
          name: child.name,
          icon: child.icon,
          color: child.color,
          type: category.type,
          parentId: parent.id,
          isEssential: child.isEssential,
        },
      });
    }
  }

  const count = await prisma.defaultCategory.count();
  console.log(`Seeded default categories. Total rows: ${count}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
