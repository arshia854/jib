import "server-only";
import { prisma } from "@/lib/prisma";
import { AccountNotFoundError } from "@/lib/data/accounts";
import { MAX_TRANSACTION_AMOUNT } from "@/lib/limits";
import { invalidateSpendingSummaryCache } from "@/lib/analytics/spending-summary";

type PrismaClient = typeof prisma;

// Phase A2 (docs/roadmap-status.md savings roadmap): the system category
// pair backfilled onto every user by prisma/backfill-transfer-categories.ts
// (one type="expense", one type="income", both isTransfer: true) - see that
// script's own header comment and prisma/default-categories.ts. Kept as a
// local const, same as that backfill script's own TRANSFER_CATEGORY_NAME,
// rather than a shared lib/limits.ts-style export - nothing else in the
// codebase needs this literal outside these two places.
const TRANSFER_CATEGORY_NAME = "انتقال بین حساب‌ها";

// Same "not the caller's fault, but a real named condition" character as
// AccountInUseError (lib/data/accounts.ts) - thrown when fromAccountId and
// toAccountId are the same id. Kept distinct from AccountNotFoundError
// (reused as-is per this phase's instructions for the "doesn't exist/isn't
// owned by this user" case) since this is a different failure: both ids are
// perfectly valid accounts, just not a valid *pair*.
export class SameAccountTransferError extends Error {}

// amount <= 0 or > MAX_TRANSACTION_AMOUNT. Unlike createTransaction
// (lib/data/transactions.ts), which leaves amount-range validation entirely
// to the API route, this phase's spec explicitly asks createTransfer itself
// to enforce it - so this exists as the data-layer half of that check
// (app/api/transfers/route.ts's own pre-check is the friendly-400 half,
// this is the defense-in-depth backstop for any other caller of this
// function).
export class InvalidTransferAmountError extends Error {}

// Thrown only when this user is missing one or both of the system transfer
// categories - i.e. prisma/backfill-transfer-categories.ts hasn't reached
// them yet (see that script's own comment). Deliberately a hard failure
// rather than silently falling back to some other category, which would
// misfile the transaction as real spending/income instead of a transfer.
export class TransferCategoryMissingError extends Error {}

// deleteTransfer's own not-found case - kept distinct from
// TransactionNotFoundError (lib/data/transactions.ts) since a transfer is a
// pair of rows identified by transferGroupId, not a single row identified
// by its own id, and "found only one of the two rows" is a real, distinct
// failure mode (see deleteTransfer's own comment) that a single-row lookup
// can never hit.
export class TransferNotFoundError extends Error {}

export interface CreateTransferInput {
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  date?: Date;
  note?: string;
}

// Creates the two-Transaction-row pair (one type="expense" on
// fromAccountId, one type="income" on toAccountId, both sharing a freshly
// generated transferGroupId) that represents one internal account-to-
// account transfer - see prisma/schema.prisma's own comment on
// Transaction.transferGroupId for why a transfer is modeled as two rows
// rather than a new dedicated model.
//
// Validation order matters: same-account and amount checks first (cheap,
// no DB round-trip, and same-account is nonsensical regardless of whether
// either account/category lookup would otherwise succeed), then the two
// account ownership lookups and the two category lookups together (four
// independent reads, no reason to serialize them).
export async function createTransfer(
  userId: number,
  input: CreateTransferInput,
  client: PrismaClient = prisma
) {
  const { fromAccountId, toAccountId, amount, date = new Date(), note } = input;

  if (fromAccountId === toAccountId) {
    throw new SameAccountTransferError("حساب مبدا و مقصد نمی‌توانند یکسان باشند.");
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TRANSACTION_AMOUNT) {
    throw new InvalidTransferAmountError("مبلغ انتقال نامعتبر است.");
  }

  const [fromAccount, toAccount, expenseCategory, incomeCategory] = await Promise.all([
    client.financeAccount.findFirst({ where: { id: fromAccountId, userId } }),
    client.financeAccount.findFirst({ where: { id: toAccountId, userId } }),
    client.category.findFirst({
      where: { userId, name: TRANSFER_CATEGORY_NAME, type: "expense", isTransfer: true },
    }),
    client.category.findFirst({
      where: { userId, name: TRANSFER_CATEGORY_NAME, type: "income", isTransfer: true },
    }),
  ]);

  if (!fromAccount || !toAccount) {
    throw new AccountNotFoundError("حساب یافت نشد.");
  }
  if (!expenseCategory || !incomeCategory) {
    throw new TransferCategoryMissingError("دسته‌بندی انتقال بین حساب‌ها برای این کاربر یافت نشد.");
  }

  const transferGroupId = crypto.randomUUID();
  const description = note ?? "انتقال بین حساب‌ها";
  // Transaction.amount is Int (prisma/schema.prisma) - same rounding
  // createTransaction's own API route already applies before calling in
  // (Math.round(amount)), reapplied here since this function is the one
  // actually writing the row and may be called directly, not just through
  // the route.
  const roundedAmount = Math.round(amount);

  const [expenseTransaction, incomeTransaction] = await client.$transaction([
    client.transaction.create({
      data: {
        userId,
        accountId: fromAccount.id,
        categoryId: expenseCategory.id,
        amount: roundedAmount,
        type: "expense",
        description,
        // No free-text input exists for a transfer the way a parsed bank
        // SMS/typed sentence does for a regular transaction - rawInput is
        // non-nullable (prisma/schema.prisma), so it gets the same
        // description text rather than an empty string.
        rawInput: description,
        date,
        transferGroupId,
      },
      include: { category: true },
    }),
    client.transaction.create({
      data: {
        userId,
        accountId: toAccount.id,
        categoryId: incomeCategory.id,
        amount: roundedAmount,
        type: "income",
        description,
        rawInput: description,
        date,
        transferGroupId,
      },
      include: { category: true },
    }),
  ]);

  // Both isTransfer categories are already excluded from every spending-
  // summary aggregation (see e.g. lib/data/dashboard.ts, lib/reports/*),
  // so a cached past month's numbers can't actually change from this - but
  // createTransaction() invalidates unconditionally on every create
  // regardless of category, and this is a no-op deleteMany when there's no
  // cached row either way, so this matches that same blanket precedent
  // rather than being a special case that has to reason about isTransfer.
  await invalidateSpendingSummaryCache(userId, date, client);

  return { transferGroupId, expenseTransaction, incomeTransaction };
}

// Deletes both rows of a transfer pair atomically. Scoped by userId +
// transferGroupId (not a single row id) - findMany, not findFirst, since
// finding fewer than 2 rows (0, one leg already deleted/never existed, or
// - shouldn't happen given how createTransfer only ever writes exactly 2 -
// a genuinely broken pair) must fail loudly rather than deleting whatever
// partial state exists.
export async function deleteTransfer(userId: number, transferGroupId: string, client: PrismaClient = prisma) {
  const rows = await client.transaction.findMany({ where: { userId, transferGroupId } });
  if (rows.length < 2) {
    throw new TransferNotFoundError("انتقال یافت نشد.");
  }

  const deleted = await client.$transaction(rows.map((row) => client.transaction.delete({ where: { id: row.id } })));

  // Both legs always share the same `date` (createTransfer writes it
  // identically onto both rows), so this is a single invalidation call in
  // practice - iterating `rows` rather than assuming that anyway, in case a
  // future change ever lets the two legs' dates diverge.
  await Promise.all(
    [...new Set(rows.map((row) => row.date.getTime()))].map((t) => invalidateSpendingSummaryCache(userId, new Date(t), client))
  );

  return deleted;
}
