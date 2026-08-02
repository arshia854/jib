import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { normalizeText } from "@/lib/normalize";
import { updateTransaction } from "@/lib/data/transactions";

describe("updateTransaction (merchant-mapping learning)", () => {
  let userId: number;
  let accountId: number;
  let categoryAId: number;
  let categoryBId: number;
  const categoryAName = "دسته الف تست";
  const categoryBName = "دسته ب تست";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: `TEST-UPDATE-TRANSACTION-${Date.now()}` },
    });
    userId = user.id;

    const account = await prisma.financeAccount.create({
      data: { userId, name: "حساب تست", type: "cash" },
    });
    accountId = account.id;

    const categoryA = await prisma.category.create({
      data: { userId, name: categoryAName, icon: "🧪", color: "#000000", type: "expense" },
    });
    categoryAId = categoryA.id;

    const categoryB = await prisma.category.create({
      data: { userId, name: categoryBName, icon: "🧪", color: "#111111", type: "expense" },
    });
    categoryBId = categoryB.id;
  });

  afterAll(async () => {
    await prisma.merchantMapping.deleteMany({ where: { userId } });
    await prisma.transaction.deleteMany({ where: { userId } });
    await prisma.category.deleteMany({ where: { userId } });
    await prisma.financeAccount.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("creates a MerchantMapping when the category changes on a transaction with non-empty rawInput", async () => {
    const rawInput = "فروشگاه یک ۵۰۰۰۰";
    const merchantKey = normalizeText(rawInput);

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 50000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-01"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 60000,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      description: "خرید یک",
      date: new Date("2026-01-02"),
    });

    expect(updated.amount).toBe(60000);
    expect(updated.description).toBe("خرید یک");
    expect(updated.date.toISOString()).toBe(new Date("2026-01-02").toISOString());
    expect(updated.categoryId).toBe(categoryBId);
    expect(updated.category.name).toBe(categoryBName);

    const mapping = await prisma.merchantMapping.findUnique({
      where: { userId_merchantKey: { userId, merchantKey } },
    });
    expect(mapping).not.toBeNull();
    expect(mapping?.categoryId).toBe(categoryBId);
  });

  it("updates (not duplicates) an existing MerchantMapping when a later change resolves to the same merchantKey", async () => {
    const rawInput = "کافه دو ۲۰۰۰۰";
    const merchantKey = normalizeText(rawInput);

    await prisma.merchantMapping.create({
      data: { userId, merchantKey, categoryId: categoryAId },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 20000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-03"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 20000,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      date: new Date("2026-01-03"),
    });

    expect(updated.categoryId).toBe(categoryBId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey } });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].categoryId).toBe(categoryBId);
  });

  it("leaves MerchantMapping untouched when the category is unchanged", async () => {
    const rawInput = "سوپرمارکت سه ۱۰۰۰۰";
    const merchantKey = normalizeText(rawInput);

    const existingMapping = await prisma.merchantMapping.create({
      data: { userId, merchantKey, categoryId: categoryBId },
    });

    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 10000,
        type: "expense",
        rawInput,
        date: new Date("2026-01-04"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 15000,
      type: "expense",
      categoryName: categoryAName,
      accountId,
      description: "بدون تغییر دسته",
      date: new Date("2026-01-05"),
    });

    expect(updated.amount).toBe(15000);
    expect(updated.description).toBe("بدون تغییر دسته");
    expect(updated.date.toISOString()).toBe(new Date("2026-01-05").toISOString());
    expect(updated.categoryId).toBe(categoryAId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey } });
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toEqual(existingMapping);
  });

  it("does not create or modify a MerchantMapping when rawInput is empty, even if the category changes", async () => {
    const txn = await prisma.transaction.create({
      data: {
        userId,
        accountId,
        categoryId: categoryAId,
        amount: 5000,
        type: "expense",
        rawInput: "",
        date: new Date("2026-01-06"),
      },
    });

    const updated = await updateTransaction(userId, txn.id, {
      amount: 5500,
      type: "expense",
      categoryName: categoryBName,
      accountId,
      date: new Date("2026-01-07"),
    });

    expect(updated.amount).toBe(5500);
    expect(updated.categoryId).toBe(categoryBId);

    const mappings = await prisma.merchantMapping.findMany({ where: { userId, merchantKey: "" } });
    expect(mappings).toHaveLength(0);
  });
});
