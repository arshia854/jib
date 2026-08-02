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
  const defaultMains = await prisma.defaultCategory.findMany({
    where: { parentId: null },
    include: { children: true },
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
            parentId: parent.id,
            userId,
          })),
        });
      }
    }
  });
}
