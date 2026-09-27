import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { getTodaySpending } from "@/lib/reports/today-spending";

describe("getTodaySpending", () => {
  let userId: number;
  let accountId: number;

  const FOOD_NAME = "خوراک تست روزانه";
  const TRANSPORT_NAME = "حمل‌ونقل تست روزانه";
  const INCOME_NAME = "درآمد تست روزانه";

  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12, 0, 0);

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-TODAY-SPENDING-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const [food, transport, income] = await Promise.all([
      prisma.category.create({
        data: { userId, name: FOOD_NAME, icon: "🍔", color: "#000001", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: TRANSPORT_NAME, icon: "🚌", color: "#000002", type: "expense" },
      }),
      prisma.category.create({
        data: { userId, name: INCOME_NAME, icon: "💰", color: "#000003", type: "income" },
      }),
    ]);

    const makeTxn = (categoryId: number, type: "income" | "expense", amount: number, date: Date) =>
      prisma.transaction.create({
        data: { userId, accountId, categoryId, amount, type, rawInput: "تست", date },
      });

    await Promise.all([
      // Larger amount today -> should sort first
      makeTxn(food.id, "expense", 80000, today),
      // Smaller amount today
      makeTxn(transport.id, "expense", 30000, today),
      // Yesterday -> must be excluded
      makeTxn(food.id, "expense", 500000, yesterday),
      // Income today -> must not be treated as spending
      makeTxn(income.id, "income", 1000000, today),
    ]);
  });

  afterAll(async () => {
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns multiple categories sorted descending by amount, excluding other days and income", async () => {
    const result = await getTodaySpending(String(userId));

    expect(result.categories).toEqual([
      { category: FOOD_NAME, amount: 80000 },
      { category: TRANSPORT_NAME, amount: 30000 },
    ]);
    expect(result.total).toBe(110000);
  });

  it("returns a single category when only one category has spending today", async () => {
    const soloUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TODAY-SPENDING-SOLO-${Date.now()}` },
    });
    const soloAccount = await prisma.financeAccount.create({
      data: { userId: soloUser.id, name: "حساب تست", type: "cash" },
    });
    const soloCategory = await prisma.category.create({
      data: { userId: soloUser.id, name: "دسته تست تنها", icon: "🎯", color: "#000004", type: "expense" },
    });
    await prisma.transaction.create({
      data: {
        userId: soloUser.id,
        accountId: soloAccount.id,
        categoryId: soloCategory.id,
        amount: 45000,
        type: "expense",
        rawInput: "تست",
        date: new Date(),
      },
    });

    const result = await getTodaySpending(String(soloUser.id));

    expect(result.categories).toEqual([{ category: "دسته تست تنها", amount: 45000 }]);
    expect(result.total).toBe(45000);

    await prisma.transaction.deleteMany({ where: { userId: soloUser.id } });
    await prisma.category.deleteMany({ where: { userId: soloUser.id } });
    await prisma.financeAccount.deleteMany({ where: { userId: soloUser.id } });
    await prisma.user.delete({ where: { id: soloUser.id } });
  });

  it("returns an empty categories list and zero total when a user has no transactions today", async () => {
    const emptyUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TODAY-SPENDING-EMPTY-${Date.now()}` },
    });

    const result = await getTodaySpending(String(emptyUser.id));

    expect(result.categories).toEqual([]);
    expect(result.total).toBe(0);

    await prisma.user.delete({ where: { id: emptyUser.id } });
  });
});
