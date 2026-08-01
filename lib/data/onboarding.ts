import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES, DEFAULT_ACCOUNT } from "@/lib/categories";

export async function seedDefaultsForUser(userId: number) {
  await prisma.$transaction(async (tx) => {
    await tx.account.create({ data: { ...DEFAULT_ACCOUNT, userId } });

    for (const { subcategories, ...mainData } of DEFAULT_CATEGORIES) {
      const parent = await tx.category.create({ data: { ...mainData, userId } });

      if (subcategories?.length) {
        await tx.category.createMany({
          data: subcategories.map((sub) => ({
            name: sub.name,
            icon: sub.icon ?? mainData.icon,
            color: sub.color ?? mainData.color,
            type: mainData.type,
            parentId: parent.id,
            userId,
          })),
        });
      }
    }
  });
}
