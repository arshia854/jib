// Seeds the global DefaultCategory table (see prisma/schema.prisma) that
// lib/data/onboarding.ts copies into each new user's own Category rows.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "./default-categories";

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
