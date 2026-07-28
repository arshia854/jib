import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";

export async function getDefaultAccount(userId: number) {
  const existing = await prisma.account.findFirst({ where: { userId }, orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.account.create({ data: { ...DEFAULT_ACCOUNT, userId } });
}
