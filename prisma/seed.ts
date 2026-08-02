// Seeds the global DefaultCategory table (see prisma/schema.prisma) that
// lib/data/onboarding.ts copies into each new user's own Category rows.
import "dotenv/config";
import { prisma } from "@/lib/prisma";

interface DefaultCategorySeed {
  name: string;
  icon: string;
  color: string;
  type: "income" | "expense";
  children?: { name: string; icon: string; color: string }[];
}

const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  {
    name: "خوراک و رستوران",
    icon: "🍔",
    color: "#F97316",
    type: "expense",
    children: [
      { name: "سوپرمارکت", icon: "🛒", color: "#F97316" },
      { name: "رستوران و کافه", icon: "☕", color: "#F97316" },
    ],
  },
  {
    name: "حمل‌ونقل",
    icon: "🚗",
    color: "#3B82F6",
    type: "expense",
    children: [
      { name: "بنزین", icon: "⛽", color: "#3B82F6" },
      { name: "تاکسی و اسنپ", icon: "🚕", color: "#3B82F6" },
    ],
  },
  {
    name: "خرید",
    icon: "🛍️",
    color: "#EC4899",
    type: "expense",
    children: [
      { name: "پوشاک", icon: "👕", color: "#EC4899" },
      { name: "لوازم دیجیتال", icon: "📱", color: "#EC4899" },
    ],
  },
  {
    name: "قبوض و اشتراک",
    icon: "🧾",
    color: "#64748B",
    type: "expense",
    children: [
      { name: "برق، آب و گاز", icon: "💡", color: "#64748B" },
      { name: "اینترنت و تلفن", icon: "📶", color: "#64748B" },
    ],
  },
  {
    name: "مسکن",
    icon: "🏠",
    color: "#1E3A8A",
    type: "expense",
    children: [{ name: "اجاره", icon: "🏠", color: "#1E3A8A" }],
  },
  {
    name: "سلامت",
    icon: "💊",
    color: "#EF4444",
    type: "expense",
    children: [
      { name: "دارو", icon: "💊", color: "#EF4444" },
      { name: "ویزیت پزشک", icon: "🩺", color: "#EF4444" },
    ],
  },
  {
    name: "تفریح و سرگرمی",
    icon: "🎬",
    color: "#8B5CF6",
    type: "expense",
    children: [{ name: "سفر", icon: "✈️", color: "#8B5CF6" }],
  },
  {
    name: "آموزش",
    icon: "📚",
    color: "#06B6D4",
    type: "expense",
  },
  {
    name: "سایر هزینه‌ها",
    icon: "🔖",
    color: "#94A3B8",
    type: "expense",
  },
  {
    name: "حقوق",
    icon: "💰",
    color: "#10B981",
    type: "income",
  },
  {
    name: "درآمد آزاد",
    icon: "💼",
    color: "#10B981",
    type: "income",
  },
  {
    name: "سرمایه‌گذاری",
    icon: "📈",
    color: "#10B981",
    type: "income",
  },
  {
    name: "هدیه",
    icon: "🎁",
    color: "#10B981",
    type: "income",
  },
  {
    name: "سایر درآمدها",
    icon: "➕",
    color: "#10B981",
    type: "income",
  },
];

async function main() {
  for (const category of DEFAULT_CATEGORIES) {
    const parent = await prisma.defaultCategory.upsert({
      where: { name_type: { name: category.name, type: category.type } },
      update: { icon: category.icon, color: category.color },
      create: {
        name: category.name,
        icon: category.icon,
        color: category.color,
        type: category.type,
      },
    });

    for (const child of category.children ?? []) {
      await prisma.defaultCategory.upsert({
        where: { name_type: { name: child.name, type: category.type } },
        update: { icon: child.icon, color: child.color, parentId: parent.id },
        create: {
          name: child.name,
          icon: child.icon,
          color: child.color,
          type: category.type,
          parentId: parent.id,
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
