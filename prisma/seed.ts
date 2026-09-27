// Seeds the global DefaultCategory table (see prisma/schema.prisma) that
// lib/data/onboarding.ts copies into each new user's own Category rows.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES } from "./default-categories";

async function main() {
  for (const category of DEFAULT_CATEGORIES) {
    const parent = await prisma.defaultCategory.upsert({
      where: { name_type: { name: category.name, type: category.type } },
      // parentId: null is required here, not just icon/color/isEssential -
      // without it, a (name, type) that already exists in the table *as a
      // child* (e.g. a stale row from an older seed snapshot baked into an
      // early migration - see AGENTS.md) would silently stay a child
      // forever instead of being promoted to top-level, even though every
      // other field gets refreshed correctly. Confirmed to actually happen
      // (not just theoretical) while seeding the Subtask 23-top-level
      // category tree on 2026-09-04 - see docs/roadmap-status.md's entry
      // that day for the exact affected rows.
      update: {
        icon: category.icon,
        color: category.color,
        isEssential: category.isEssential,
        isTransfer: category.isTransfer ?? false,
        parentId: null,
      },
      create: {
        name: category.name,
        icon: category.icon,
        color: category.color,
        type: category.type,
        isEssential: category.isEssential,
        isTransfer: category.isTransfer ?? false,
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
