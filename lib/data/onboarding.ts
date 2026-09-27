import "server-only";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";

export async function seedDefaultsForUser(userId: number) {
  await prisma.$transaction(async (tx) => {
    await tx.financeAccount.create({ data: { ...DEFAULT_ACCOUNT, userId } });
  });
  await seedDefaultCategoriesForUser(userId);
}

// Just the Category half of seedDefaultsForUser - split out so a backfill
// (see prisma/backfill-categories.ts) can copy DefaultCategory rows into a
// user's Category table without also re-creating their FinanceAccount.
export async function seedDefaultCategoriesForUser(userId: number) {
  // Archived defaults (DefaultCategory.isArchived) are never seeded.
  // Removing an entry from prisma/default-categories.ts alone doesn't retire
  // it: prisma/seed.ts only ever upserts, so its already-seeded row stays in
  // the live DefaultCategory table until it's flagged here.
  const defaultMains = await prisma.defaultCategory.findMany({
    where: { parentId: null, isArchived: false },
    include: { children: { where: { isArchived: false } } },
    orderBy: { id: "asc" },
  });

  await prisma.$transaction(async (tx) => {
    for (const main of defaultMains) {
      const parent = await tx.category.create({
        data: {
          name: main.name,
          icon: main.icon,
          color: main.color,
          type: main.type,
          isTransfer: main.isTransfer,
          isEssential: main.isEssential,
          userId,
        },
      });

      if (main.children.length) {
        await tx.category.createMany({
          data: main.children.map((sub) => ({
            name: sub.name,
            icon: sub.icon,
            color: sub.color,
            type: sub.type,
            isTransfer: sub.isTransfer,
            isEssential: sub.isEssential,
            parentId: parent.id,
            userId,
          })),
        });
      }
    }
  });
}
