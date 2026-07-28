import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCOUNT } from "@/lib/categories";

export async function getDefaultAccount() {
  const existing = await prisma.account.findFirst({ orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.account.create({ data: DEFAULT_ACCOUNT });
}
