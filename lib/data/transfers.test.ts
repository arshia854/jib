import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTransfer,
  deleteTransfer,
  SameAccountTransferError,
  InvalidTransferAmountError,
  TransferCategoryMissingError,
  TransferNotFoundError,
} from "@/lib/data/transfers";
import { AccountNotFoundError } from "@/lib/data/accounts";
import { MAX_TRANSACTION_AMOUNT } from "@/lib/limits";

const TRANSFER_CATEGORY_NAME = "انتقال بین حساب‌ها";

describe("createTransfer / deleteTransfer", () => {
  let userId: number;
  let otherUserId: number;
  let fromAccountId: number;
  let toAccountId: number;
  let otherUserAccountId: number;
  // A second user who deliberately never gets the transfer categories
  // seeded - covers TransferCategoryMissingError below (the Phase A1
  // backfill-not-reached-this-user case).
  let noCategoriesUserId: number;
  let noCategoriesAccountAId: number;
  let noCategoriesAccountBId: number;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { phoneNumber: `TEST-TRANSFERS-${Date.now()}` } });
    userId = user.id;

    const otherUser = await prisma.user.create({ data: { phoneNumber: `TEST-TRANSFERS-OTHER-${Date.now()}` } });
    otherUserId = otherUser.id;

    const noCategoriesUser = await prisma.user.create({
      data: { phoneNumber: `TEST-TRANSFERS-NOCAT-${Date.now()}` },
    });
    noCategoriesUserId = noCategoriesUser.id;

    const fromAccount = await prisma.financeAccount.create({
      data: { userId, name: "حساب مبدا تست", type: "cash", initialBalance: 1_000_000 },
    });
    fromAccountId = fromAccount.id;

    const toAccount = await prisma.financeAccount.create({
      data: { userId, name: "حساب مقصد تست", type: "bank", initialBalance: 0 },
    });
    toAccountId = toAccount.id;

    const otherUserAccount = await prisma.financeAccount.create({
      data: { userId: otherUserId, name: "حساب کاربر دیگر", type: "cash" },
    });
    otherUserAccountId = otherUserAccount.id;

    const noCategoriesAccountA = await prisma.financeAccount.create({
      data: { userId: noCategoriesUserId, name: "حساب الف بدون دسته", type: "cash" },
    });
    noCategoriesAccountAId = noCategoriesAccountA.id;
    const noCategoriesAccountB = await prisma.financeAccount.create({
      data: { userId: noCategoriesUserId, name: "حساب ب بدون دسته", type: "bank" },
    });
    noCategoriesAccountBId = noCategoriesAccountB.id;

    // The transfer category pair - only for `userId`, deliberately not
    // created for `noCategoriesUserId` (see above).
    await prisma.category.create({
      data: { userId, name: TRANSFER_CATEGORY_NAME, icon: "🔁", color: "#94A3B8", type: "expense", isTransfer: true },
    });
    await prisma.category.create({
      data: { userId, name: TRANSFER_CATEGORY_NAME, icon: "🔁", color: "#10B981", type: "income", isTransfer: true },
    });
  }, 20000);

  afterAll(async () => {
    const allUserIds = [userId, otherUserId, noCategoriesUserId];
    await prisma.transaction.deleteMany({ where: { userId: { in: allUserIds } } });
    await prisma.category.deleteMany({ where: { userId: { in: allUserIds } } });
    await prisma.financeAccount.deleteMany({ where: { userId: { in: allUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
    await prisma.$disconnect();
  }, 20000);

  it(
    "creates two linked Transaction rows sharing one transferGroupId, expense on the source, income on the destination",
    async () => {
      const result = await createTransfer(userId, {
        fromAccountId,
        toAccountId,
        amount: 250000,
        note: "پرداخت قسط",
      });

      expect(result.expenseTransaction.transferGroupId).toBe(result.transferGroupId);
      expect(result.incomeTransaction.transferGroupId).toBe(result.transferGroupId);
      expect(result.expenseTransaction.type).toBe("expense");
      expect(result.expenseTransaction.accountId).toBe(fromAccountId);
      expect(result.expenseTransaction.amount).toBe(250000);
      expect(result.expenseTransaction.category.name).toBe(TRANSFER_CATEGORY_NAME);
      expect(result.expenseTransaction.category.isTransfer).toBe(true);
      expect(result.incomeTransaction.type).toBe("income");
      expect(result.incomeTransaction.accountId).toBe(toAccountId);
      expect(result.incomeTransaction.amount).toBe(250000);
      expect(result.incomeTransaction.category.name).toBe(TRANSFER_CATEGORY_NAME);
      expect(result.expenseTransaction.description).toBe("پرداخت قسط");
      expect(result.incomeTransaction.description).toBe("پرداخت قسط");

      const rows = await prisma.transaction.findMany({
        where: { userId, transferGroupId: result.transferGroupId },
      });
      expect(rows).toHaveLength(2);
    },
    20000
  );

  it("defaults description/rawInput to the standard transfer label when no note is given", async () => {
    const result = await createTransfer(userId, { fromAccountId, toAccountId, amount: 1000 });
    expect(result.expenseTransaction.description).toBe(TRANSFER_CATEGORY_NAME);
    expect(result.incomeTransaction.rawInput).toBe(TRANSFER_CATEGORY_NAME);
  });

  it("rejects a transfer where fromAccountId === toAccountId, without writing anything", async () => {
    await expect(
      createTransfer(userId, { fromAccountId, toAccountId: fromAccountId, amount: 1000 })
    ).rejects.toBeInstanceOf(SameAccountTransferError);
  });

  it.each([0, -1000, MAX_TRANSACTION_AMOUNT + 1])("rejects an out-of-range amount (%s)", async (amount) => {
    await expect(createTransfer(userId, { fromAccountId, toAccountId, amount })).rejects.toBeInstanceOf(
      InvalidTransferAmountError
    );
  });

  it("accepts an amount exactly at MAX_TRANSACTION_AMOUNT", async () => {
    const result = await createTransfer(userId, { fromAccountId, toAccountId, amount: MAX_TRANSACTION_AMOUNT });
    expect(result.expenseTransaction.amount).toBe(MAX_TRANSACTION_AMOUNT);
  });

  it(
    "rejects a transfer referencing another user's account (fromAccountId), without writing anything",
    async () => {
      await expect(
        createTransfer(userId, { fromAccountId: otherUserAccountId, toAccountId, amount: 1000 })
      ).rejects.toBeInstanceOf(AccountNotFoundError);
    },
    20000
  );

  it("rejects a transfer referencing another user's account (toAccountId)", async () => {
    await expect(
      createTransfer(userId, { fromAccountId, toAccountId: otherUserAccountId, amount: 1000 })
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("rejects a transfer for a nonexistent accountId", async () => {
    await expect(
      createTransfer(userId, { fromAccountId, toAccountId: 999_999_999, amount: 1000 })
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it(
    "throws TransferCategoryMissingError when this user has no transfer category pair yet, without writing anything",
    async () => {
      await expect(
        createTransfer(noCategoriesUserId, {
          fromAccountId: noCategoriesAccountAId,
          toAccountId: noCategoriesAccountBId,
          amount: 1000,
        })
      ).rejects.toBeInstanceOf(TransferCategoryMissingError);

      const rows = await prisma.transaction.findMany({ where: { userId: noCategoriesUserId } });
      expect(rows).toHaveLength(0);
    },
    20000
  );

  it("deletes both rows of an existing transfer pair atomically", async () => {
    const created = await createTransfer(userId, { fromAccountId, toAccountId, amount: 5000 });

    const deleted = await deleteTransfer(userId, created.transferGroupId);
    expect(deleted).toHaveLength(2);

    const remaining = await prisma.transaction.findMany({
      where: { userId, transferGroupId: created.transferGroupId },
    });
    expect(remaining).toHaveLength(0);
  });

  it("throws TransferNotFoundError for an unknown transferGroupId", async () => {
    await expect(deleteTransfer(userId, "no-such-transfer-group-id")).rejects.toBeInstanceOf(TransferNotFoundError);
  });

  it(
    "throws TransferNotFoundError and deletes nothing when only one leg of the pair still exists (partial row)",
    async () => {
      const created = await createTransfer(userId, { fromAccountId, toAccountId, amount: 7000 });
      // Simulate a partial/broken pair by deleting one leg directly.
      await prisma.transaction.delete({ where: { id: created.incomeTransaction.id } });

      await expect(deleteTransfer(userId, created.transferGroupId)).rejects.toBeInstanceOf(TransferNotFoundError);

      const remaining = await prisma.transaction.findMany({
        where: { userId, transferGroupId: created.transferGroupId },
      });
      // The one surviving leg must still be there - the guard must not
      // have deleted it either.
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(created.expenseTransaction.id);
    },
    20000
  );

  it("does not let another user delete this user's transfer pair", async () => {
    const created = await createTransfer(userId, { fromAccountId, toAccountId, amount: 8000 });

    await expect(deleteTransfer(otherUserId, created.transferGroupId)).rejects.toBeInstanceOf(TransferNotFoundError);

    const remaining = await prisma.transaction.findMany({
      where: { userId, transferGroupId: created.transferGroupId },
    });
    expect(remaining).toHaveLength(2);
  });
});
