import { prisma } from "@/lib/prisma";
import { DEFAULT_CATEGORIES, DEFAULT_ACCOUNT } from "@/lib/categories";

export async function seedDefaultsForUser(userId: number) {
  await prisma.account.create({ data: { ...DEFAULT_ACCOUNT, userId } });
  await prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((category) => ({ ...category, userId })),
  });
}
