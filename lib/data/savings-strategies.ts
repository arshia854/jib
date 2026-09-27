import "server-only";
import { prisma } from "@/lib/prisma";

type PrismaClient = typeof prisma;

// Fixed vocabulary for SavingsStrategy.formulaType/status (prisma/schema.prisma)
// - enforced here at the application level only, same convention as
// GOAL_CATEGORIES/GOAL_STATUSES in lib/data/goals.ts.
export const SAVINGS_STRATEGY_FORMULA_TYPES = [
  "fifty_thirty_twenty",
  "pay_yourself_first",
  "leftover",
  "roundup",
  "custom",
] as const;
export type SavingsStrategyFormulaType = (typeof SAVINGS_STRATEGY_FORMULA_TYPES)[number];

export const SAVINGS_STRATEGY_STATUSES = ["active", "paused", "abandoned"] as const;
export type SavingsStrategyStatus = (typeof SAVINGS_STRATEGY_STATUSES)[number];

export class SavingsStrategyNotFoundError extends Error {}

// Thrown when a create/update would leave the user with two "active" rows of
// the same formulaType - each active row is listed on its own everywhere
// (income-reaction banner, this-month progress), so a second one just doubles
// everything up.
export class DuplicateActiveStrategyError extends Error {}

/**
 * The user's own savings strategies - active first, then by createdAt
 * descending. No feasibility computation involved here, unlike
 * listGoalsWithFeasibility - this model has no relation to
 * Transaction/Goal yet, so there's nothing to join.
 */
export async function listSavingsStrategies(userId: number, client: PrismaClient = prisma) {
  const strategies = await client.savingsStrategy.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return [...strategies].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active"));
}

export async function createSavingsStrategy(
  userId: number,
  data: {
    formulaType: string;
    targetPercent?: number | null;
    targetAmount?: number | null;
    status?: string;
  }
) {
  const status = data.status ?? "active";
  if (status === "active") {
    const duplicate = await prisma.savingsStrategy.findFirst({
      where: { userId, formulaType: data.formulaType, status: "active" },
    });
    if (duplicate) {
      throw new DuplicateActiveStrategyError("یک استراتژی فعال از این نوع از قبل وجود دارد.");
    }
  }

  return prisma.savingsStrategy.create({
    data: {
      formulaType: data.formulaType,
      targetPercent: data.targetPercent ?? null,
      targetAmount: data.targetAmount ?? null,
      status,
      userId,
    },
  });
}

export async function getSavingsStrategy(userId: number, id: number) {
  const strategy = await prisma.savingsStrategy.findFirst({ where: { id, userId } });
  if (!strategy) {
    throw new SavingsStrategyNotFoundError("استراتژی پس‌انداز یافت نشد.");
  }
  return strategy;
}

// Backs the income-transaction savings-suggestion trigger
// (lib/notifications/savings-suggestion.ts). A user can have more than one
// "active" row at once - createSavingsStrategy/updateSavingsStrategy above
// only block a duplicate *active row of the same formulaType*, not a second
// active row overall - so this picks exactly one to react to per income
// transaction rather than firing a suggestion per active strategy. Most
// recently updated wins (a user who just tweaked/reactivated a strategy is
// treated as caring about that one right now); null when the user has no
// active strategy at all.
export async function getMostRecentActiveSavingsStrategy(userId: number, client: PrismaClient = prisma) {
  return client.savingsStrategy.findFirst({
    where: { userId, status: "active" },
    orderBy: { updatedAt: "desc" },
  });
}

export async function updateSavingsStrategy(
  userId: number,
  id: number,
  data: {
    formulaType?: string;
    targetPercent?: number | null;
    targetAmount?: number | null;
    status?: string;
  }
) {
  const existing = await prisma.savingsStrategy.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new SavingsStrategyNotFoundError("استراتژی پس‌انداز یافت نشد.");
  }

  // Covers both "pause, then reactivate while a newer active one exists" and
  // "switch a paused row's formulaType to one that's already active elsewhere".
  const resultingFormulaType = data.formulaType ?? existing.formulaType;
  const resultingStatus = data.status ?? existing.status;
  if (resultingStatus === "active") {
    const duplicate = await prisma.savingsStrategy.findFirst({
      where: { userId, formulaType: resultingFormulaType, status: "active", id: { not: id } },
    });
    if (duplicate) {
      throw new DuplicateActiveStrategyError("یک استراتژی فعال از این نوع از قبل وجود دارد.");
    }
  }

  return prisma.savingsStrategy.update({ where: { id }, data });
}

export async function deleteSavingsStrategy(userId: number, id: number) {
  const existing = await prisma.savingsStrategy.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new SavingsStrategyNotFoundError("استراتژی پس‌انداز یافت نشد.");
  }
  return prisma.savingsStrategy.delete({ where: { id } });
}
