import "server-only";
import { prisma } from "@/lib/prisma";
import type { CategoryType } from "@/lib/categories";
import { FALLBACK_INCOME_CATEGORY } from "@/lib/categories";
import { hasStrongIncomeSignal } from "@/lib/extract-income-signal";
import { buildMerchantKey } from "@/lib/merchant-lookup";
import { DEFAULT_TRANSACTIONS_PAGE_SIZE, MAX_TRANSACTIONS_PAGE_SIZE } from "@/lib/limits";
import { invalidateSpendingSummaryCache } from "@/lib/analytics/spending-summary";
import { isUniqueConstraintError } from "@/lib/observability/classify-error";
import { buildAssetCreateData } from "@/lib/data/assets";
import type { LivePricedAssetType } from "@/lib/assets";
import { logger } from "@/lib/observability/logger"; // TEMP-LATENCY
import { getRequestId } from "@/lib/observability/request-context"; // TEMP-LATENCY

export interface TransactionFilters {
  type?: CategoryType;
  categoryId?: number;
  from?: Date;
  to?: Date;
}

// page/pageSize (not raw take/skip) to match the existing pagination idiom
// in lib/data/admin-users.ts/admin-logs.ts (PaginatedResult<T>-shaped:
// page, pageSize, total, totalPages) - skip/take is still what actually
// goes to Prisma underneath, just derived from page rather than taken
// as-is from the caller. pageSize is hard-clamped to
// MAX_TRANSACTIONS_PAGE_SIZE here (not just wherever callers parse query
// params) since this is the one place both callers - the GET route and
// app/app/transactions/page.tsx - are guaranteed to go through.
export async function listTransactions(
  userId: number,
  filters: TransactionFilters = {},
  page = 1,
  pageSize = DEFAULT_TRANSACTIONS_PAGE_SIZE
) {
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(Math.max(1, pageSize), MAX_TRANSACTIONS_PAGE_SIZE);
  const skip = (safePage - 1) * safePageSize;

  const where = {
    userId,
    type: filters.type,
    categoryId: filters.categoryId,
    date: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
  };

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      // account (id/name only, not the full FinanceAccount row) added
      // alongside the pre-existing `category` include - Phase A3
      // (docs/roadmap-status.md savings roadmap) needs each leg's account
      // name to render a merged transferGroupId pair as "از X به Y" (see
      // lib/transactions/group-transfer-pairs.ts, called by this
      // function's own callers - app/app/dashboard/page.tsx). Purely
      // additive: existing consumers of this result (GET
      // /api/transactions) just see one new field per transaction, nothing
      // removed or renamed.
      include: { category: true, account: { select: { id: true, name: true } } },
      orderBy: { date: "desc" },
      skip,
      take: safePageSize,
    }),
    prisma.transaction.count({ where }),
  ]);

  return {
    transactions,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  };
}

export async function getTransaction(userId: number, id: number) {
  return prisma.transaction.findFirst({ where: { id, userId }, include: { category: true } });
}

export class TransactionNotFoundError extends Error {}

export async function deleteTransaction(userId: number, id: number) {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  const deleted = await prisma.transaction.delete({ where: { id } });
  // The deleted transaction's month may have an already-cached spending
  // summary (see invalidateSpendingSummaryCache's doc comment) - without
  // this, deleting an old transaction would leave that month's cached
  // totals overstated forever.
  await invalidateSpendingSummaryCache(userId, existing.date);
  return deleted;
}

// Closed set, validated at the API boundary (see app/api/transactions/route.ts)
// rather than trusted as an arbitrary string - keeps this column meaningful
// instead of becoming a free-text field callers can put anything into.
export type TransactionSource = "assistant-suggestion";

// See lib/ai/parse-transaction.ts's AssetPurchaseSuggestion - the same
// (type, quantity, purchasePricePerUnit) shape, already fully resolved
// against a live price by the time it reaches here. Declared separately
// (not imported from that AI-layer module) to keep this data-layer file's
// own types self-contained, same precedent as ParsedTransaction.type vs
// CreateTransactionInput.type both independently typing the same
// "income" | "expense" shape.
export interface AssetPurchaseInput {
  type: LivePricedAssetType;
  quantity: number;
  purchasePricePerUnit: number;
}

export interface CreateTransactionInput {
  amount: number;
  type: CategoryType;
  categoryName: string;
  accountId: number;
  description?: string;
  rawInput: string;
  date: Date;
  // Provenance of this transaction. Undefined for the original manual-entry/
  // AI-preview flow (stored as null - see schema.prisma's comment on
  // Transaction.source) - only ever "assistant-suggestion" so far, set when
  // the create call originates from the chat assistant's suggest_transaction
  // confirm ("بله") or its "ویرایش کن" -> AddTransactionForm handoff.
  source?: TransactionSource;
  // SEC-10 (docs/roadmap-status.md): optional client-generated idempotency
  // key. Undefined for any caller that doesn't send one - createTransaction()
  // below skips the idempotency check entirely in that case, so this is a
  // fully backward-compatible addition (an older/cached PWA client that
  // predates this field behaves exactly as before). See that function's own
  // comment for the replay/dedup behavior.
  idempotencyKey?: string;
  // Set to "pending" only by the "ثبت سریع" quick-submit path (POST
  // /api/transactions with `quick: true`) - see schema.prisma's own comment
  // on Transaction.enrichmentStatus and lib/workflows/enrich-transaction.ts.
  // Undefined for every other caller, which leaves the column null exactly
  // as before this field existed.
  enrichmentStatus?: "pending";
  // Set when this transaction represents buying a live-priced asset
  // (lib/ai/parse-transaction.ts's assetSuggestion, surfaced through the
  // add-transaction form or the chat assistant's confirm flow) - see
  // createTransaction()'s own comment for how this creates a matching Asset
  // row atomically alongside the Transaction row. Undefined for every other
  // caller, same "additive, opt-in" shape as source/idempotencyKey above.
  assetPurchase?: AssetPurchaseInput;
}

export interface UpdateTransactionInput {
  amount: number;
  type: CategoryType;
  categoryName: string;
  accountId: number;
  description?: string;
  date: Date;
}

export class InvalidCategoryError extends Error {}
export class InvalidAccountError extends Error {}

export async function updateTransaction(userId: number, id: number, input: UpdateTransactionInput) {
  const [existing, category, account] = await Promise.all([
    prisma.transaction.findFirst({ where: { id, userId } }),
    prisma.category.findFirst({ where: { userId, name: input.categoryName, type: input.type } }),
    prisma.financeAccount.findFirst({ where: { id: input.accountId, userId } }),
  ]);

  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  if (!category) {
    throw new InvalidCategoryError("دسته‌بندی نامعتبر است.");
  }
  if (!account) {
    throw new InvalidAccountError("حساب نامعتبر است.");
  }

  const categoryChanged = existing.categoryId !== category.id;
  // buildMerchantKey (lib/merchant-lookup.ts) strips amount digits and
  // relative-date words from rawInput before this is stored - see that
  // function's own comment for why (docs/roadmap-status.md, Phase 7/8
  // correction: merchantKey used to be the raw text verbatim, amount
  // included, so a learned mapping only ever re-matched an identical
  // amount). Guarded on non-empty same as existing.rawInput below: a
  // rawInput that's e.g. entirely digits/date-words would otherwise
  // collapse to an empty key shared by unrelated transactions.
  const merchantKey = existing.rawInput ? buildMerchantKey(existing.rawInput) : "";

  const [updated] = await prisma.$transaction([
    prisma.transaction.update({
      where: { id },
      data: {
        amount: input.amount,
        type: input.type,
        description: input.description,
        date: input.date,
        categoryId: category.id,
        accountId: account.id,
        // A manual edit finalizes this row's values - if it was a
        // quick-submit transaction still waiting on background AI
        // enrichment (see Transaction.enrichmentStatus in schema.prisma),
        // that background result must never overwrite what the user just
        // set by hand. applyTransactionEnrichment/markEnrichmentFailed
        // below both check this is still "pending" before writing, so
        // clearing it here is what makes that check actually stop them.
        enrichmentStatus: null,
        // Same reasoning: a manual edit has already resolved whatever
        // category the AI would have suggested (see schema.prisma's own
        // comment on these four columns) - clear them so a stale banner
        // from a previous background enrichment never lingers past a
        // deliberate user correction.
        suggestedCategoryName: null,
        suggestedCategoryParentName: null,
        suggestedCategoryReason: null,
        suggestedCategoryIcon: null,
      },
      include: { category: true },
    }),
    ...(categoryChanged && merchantKey
      ? [
          prisma.merchantMapping.upsert({
            where: {
              userId_merchantKey: { userId, merchantKey },
            },
            update: { categoryId: category.id },
            create: { userId, merchantKey, categoryId: category.id },
          }),
        ]
      : []),
  ]);

  // Amount, category, and date can all change here, and neither the old
  // nor the new date is restricted to the current (never-cached) month -
  // invalidate whichever cached month(s) this edit could have affected. A
  // no-op if a given month has no cached row (e.g. both dates are in the
  // current month).
  await Promise.all([
    invalidateSpendingSummaryCache(userId, existing.date),
    invalidateSpendingSummaryCache(userId, input.date),
  ]);

  return updated;
}

// SEC-10 idempotency (docs/roadmap-status.md). `input.idempotencyKey` is
// optional and, when absent, this function's behavior is completely
// unchanged from before this sub-task - the catch branch below only runs
// when a caller actually sends one and the insert it wraps collides.
//
// Turso latency fix: this used to also read-first (a `prisma.transaction.
// findFirst` by {userId, idempotencyKey}, returned as-is on a hit) before
// ever attempting the insert, on every call that carried a key. Removed -
// that pre-read only ever existed to shortcut the *replay* case (a client
// retrying a request whose response it never saw), but the catch-and-
// refetch path below already handles that exact case correctly on its own:
// inserting an already-used idempotencyKey hits the same unique-index
// violation either way, replay or genuine race, and the catch block below
// reacts to it. Removing the pre-read costs one extra (fast-failing) insert
// attempt on the rare replay path, in exchange for one fewer round-trip on
// every single non-replay call - the overwhelming majority.
//
// The one dedup path left, catch-and-refetch on the unique-index violation
// (Transaction_userId_idempotencyKey_key), also covers the true-concurrent
// case: two requests with the same key both pass validation and proceed to
// insert; the DB's unique index is the actual guarantee, and whichever
// request loses the race gets a unique-constraint error here instead of a
// duplicate row. Reusing isUniqueConstraintError()'s exact
// P2039-plus-message-sniffing check (lib/observability/classify-error.ts) -
// this codebase's own precedent for what a unique violation actually looks
// like through @prisma/adapter-libsql, not the P2002 code Prisma's native
// engine would use.
//
// The refetched row is returned in place of the create's own result,
// matching this function's normal return shape unchanged (no
// {transaction, replayed} wrapper) - from the caller's point of view,
// asking to create an already-created transaction looks exactly like the
// create succeeding, which is the point of an idempotency key. `asset:
// null` on this replay path is a known, accepted gap: there's no FK from
// Transaction to the Asset row a first, successful call might have created
// (see the assetPurchase branch below's own comment on why), so a retry
// can't look it up to echo back - the asset itself is unaffected (it was
// already created once, for real, on the original request), only this
// response's best-effort confirmation detail is missing on a replay.
//
// input.assetPurchase (set only when the AI detected this text as buying a
// live-priced asset - lib/ai/parse-transaction.ts's assetSuggestion) makes
// this also create a matching Asset row (lib/data/assets.ts), in the same
// prisma.$transaction([...]) call as the Transaction row so a mid-request
// failure can never save one without the other. The two rows aren't linked
// by any FK (schema.prisma has none, and adding one is a live-DB schema
// migration out of scope here - see AGENTS.md's migration process), so
// this is best-effort atomic pairing, not a foreign-key-enforced
// relationship - deleting/editing the transaction later doesn't touch the
// asset it created, same as the Assets page's own manually-entered rows.
export async function createTransaction(userId: number, input: CreateTransactionInput) {
  const createTransactionStartedAt = Date.now(); // TEMP-LATENCY

  const lookupStartedAt = Date.now(); // TEMP-LATENCY
  const [account, category] = await Promise.all([
    prisma.financeAccount.findFirst({ where: { id: input.accountId, userId } }),
    prisma.category.findFirst({ where: { userId, name: input.categoryName, type: input.type } }),
  ]);
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "data/transactions.createTransaction", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "accountAndCategoryLookup", // TEMP-LATENCY
      duration: Date.now() - lookupStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "createTransaction step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY

  if (!account) {
    throw new InvalidAccountError("حساب نامعتبر است.");
  }
  if (!category) {
    throw new InvalidCategoryError("دسته‌بندی نامعتبر است.");
  }

  const transactionData = {
    amount: input.amount,
    type: input.type,
    description: input.description,
    rawInput: input.rawInput,
    date: input.date,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    enrichmentStatus: input.enrichmentStatus,
    userId,
    accountId: account.id,
    categoryId: category.id,
  };

  try {
    if (input.assetPurchase) {
      const createStartedAt = Date.now(); // TEMP-LATENCY
      const [transaction, asset] = await prisma.$transaction([
        // No `include: { category: true }` - `category` was already fully
        // loaded a few lines above (accountAndCategoryLookup) and is
        // attached to the returned row by hand below, in the exact shape
        // Prisma's include would have produced, saving a redundant
        // re-fetch of the same row.
        prisma.transaction.create({ data: transactionData }),
        prisma.asset.create({
          data: buildAssetCreateData(userId, { ...input.assetPurchase, purchaseDate: input.date }),
        }),
      ]);
      logger.info( // TEMP-LATENCY
        { // TEMP-LATENCY
          requestId: getRequestId(), // TEMP-LATENCY
          route: "data/transactions.createTransaction", // TEMP-LATENCY
          userId, // TEMP-LATENCY
          step: "create", // TEMP-LATENCY
          duration: Date.now() - createStartedAt, // TEMP-LATENCY
          withAsset: true, // TEMP-LATENCY
        }, // TEMP-LATENCY
        "createTransaction step timing" // TEMP-LATENCY
      ); // TEMP-LATENCY
      // A transaction can be logged retroactively into an already-cached
      // past month (e.g. parsing an old bank SMS) - see
      // invalidateSpendingSummaryCache's doc comment.
      const invalidateStartedAt = Date.now(); // TEMP-LATENCY
      await invalidateSpendingSummaryCache(userId, input.date);
      logger.info( // TEMP-LATENCY
        { // TEMP-LATENCY
          requestId: getRequestId(), // TEMP-LATENCY
          route: "data/transactions.createTransaction", // TEMP-LATENCY
          userId, // TEMP-LATENCY
          step: "invalidateSpendingSummaryCache", // TEMP-LATENCY
          duration: Date.now() - invalidateStartedAt, // TEMP-LATENCY
        }, // TEMP-LATENCY
        "createTransaction step timing" // TEMP-LATENCY
      ); // TEMP-LATENCY
      logger.info( // TEMP-LATENCY
        { // TEMP-LATENCY
          requestId: getRequestId(), // TEMP-LATENCY
          route: "data/transactions.createTransaction", // TEMP-LATENCY
          userId, // TEMP-LATENCY
          step: "total", // TEMP-LATENCY
          duration: Date.now() - createTransactionStartedAt, // TEMP-LATENCY
        }, // TEMP-LATENCY
        "createTransaction step timing" // TEMP-LATENCY
      ); // TEMP-LATENCY
      return { ...transaction, category, asset };
    }

    const createStartedAt = Date.now(); // TEMP-LATENCY
    // Same redundant-include removal as the assetPurchase branch above -
    // `category` is attached by hand from the already-fetched row.
    const transaction = await prisma.transaction.create({ data: transactionData });
    logger.info( // TEMP-LATENCY
      { // TEMP-LATENCY
        requestId: getRequestId(), // TEMP-LATENCY
        route: "data/transactions.createTransaction", // TEMP-LATENCY
        userId, // TEMP-LATENCY
        step: "create", // TEMP-LATENCY
        duration: Date.now() - createStartedAt, // TEMP-LATENCY
        withAsset: false, // TEMP-LATENCY
      }, // TEMP-LATENCY
      "createTransaction step timing" // TEMP-LATENCY
    ); // TEMP-LATENCY
    const invalidateStartedAt = Date.now(); // TEMP-LATENCY
    await invalidateSpendingSummaryCache(userId, input.date);
    logger.info( // TEMP-LATENCY
      { // TEMP-LATENCY
        requestId: getRequestId(), // TEMP-LATENCY
        route: "data/transactions.createTransaction", // TEMP-LATENCY
        userId, // TEMP-LATENCY
        step: "invalidateSpendingSummaryCache", // TEMP-LATENCY
        duration: Date.now() - invalidateStartedAt, // TEMP-LATENCY
      }, // TEMP-LATENCY
      "createTransaction step timing" // TEMP-LATENCY
    ); // TEMP-LATENCY
    logger.info( // TEMP-LATENCY
      { // TEMP-LATENCY
        requestId: getRequestId(), // TEMP-LATENCY
        route: "data/transactions.createTransaction", // TEMP-LATENCY
        userId, // TEMP-LATENCY
        step: "total", // TEMP-LATENCY
        duration: Date.now() - createTransactionStartedAt, // TEMP-LATENCY
      }, // TEMP-LATENCY
      "createTransaction step timing" // TEMP-LATENCY
    ); // TEMP-LATENCY
    return { ...transaction, category, asset: null };
  } catch (error) {
    if (input.idempotencyKey && isUniqueConstraintError(error)) {
      const existing = await prisma.transaction.findFirst({
        where: { userId, idempotencyKey: input.idempotencyKey },
        include: { category: true },
      });
      if (existing) {
        return { ...existing, asset: null };
      }
    }
    throw error;
  }
}

export interface TransactionEnrichmentPatch {
  amount: number;
  type: CategoryType;
  categoryName: string;
  description?: string;
  // Omitted when the user picked the date themselves on quick submit (see
  // lib/workflows/enrich-transaction.ts's keepDate) - the row's own date
  // then stays as saved instead of being replaced by the AI's reading of
  // rawInput, which never saw the picked date.
  date?: Date;
  // Mirrors lib/ai/parse-transaction.ts's SuggestedCategoryWithIcon
  // field-for-field. Set only when parseTransactionWithAI's result carried
  // a suggestedCategory that this workflow run could not resolve to an
  // existing category (see lib/workflows/enrich-transaction.ts) - undefined
  // otherwise, which applyTransactionEnrichment below writes as all-null,
  // same as schema.prisma's own comment on these four Transaction columns.
  suggestedCategory?: { name: string; parentName: string | null; reason: string; icon: string };
}

// Applies the background AI-parse result from lib/workflows/enrich-transaction.ts
// to a "quick submit" transaction (see createTransaction's enrichmentStatus
// input and schema.prisma's own comment on the column).
//
// Guarded on enrichmentStatus still being "pending", read fresh right here
// rather than trusted from the workflow's own stale copy - two things can
// have already resolved this row by the time the background AI call
// finishes: the user editing it by hand (updateTransaction clears the flag
// unconditionally), or this same workflow's own recordFailure step having
// already run once (shouldn't happen twice for one workflow run, but this
// makes the guard the actual source of truth either way, not an assumption
// about call order). A no-op in either case - never overwrite a value the
// user already corrected, and never fight a terminal failure that already
// landed.
//
// Deliberately not touching merchantMapping the way updateTransaction does
// - that table is meant to capture a deliberate user re-categorization
// signal, not an automated one this function makes on its own.
export async function applyTransactionEnrichment(
  userId: number,
  id: number,
  patch: TransactionEnrichmentPatch
): Promise<void> {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing || existing.enrichmentStatus !== "pending") return;

  const category = await prisma.category.findFirst({
    where: { userId, name: patch.categoryName, type: patch.type },
  });
  // The AI-resolved category should always exist (parseTransactionWithAI
  // only ever returns a validated category or resolveFallbackCategory's own
  // fallback - see lib/ai/parse-transaction.ts) - but if it doesn't (e.g.
  // deleted between the quick-submit and this background result landing),
  // leave the quick-submit's own best-guess values in place rather than
  // throwing away a saved transaction's category for nothing. The caller
  // (lib/workflows/enrich-transaction.ts) still marks this outcome, since
  // from its point of view enrichment didn't actually apply.
  if (!category) {
    throw new InvalidCategoryError("دسته‌بندی نامعتبر است.");
  }

  await prisma.transaction.update({
    where: { id },
    data: {
      amount: patch.amount,
      type: patch.type,
      description: patch.description,
      ...(patch.date ? { date: patch.date } : {}),
      categoryId: category.id,
      enrichmentStatus: null,
      // Written unconditionally (not just when patch.suggestedCategory is
      // present) - this update only ever runs once per transaction (guarded
      // by the still-"pending" check above, and this call itself clears
      // enrichmentStatus to null, so a second run can never reach past that
      // guard again for the same row) - so there is no prior suggestion
      // that could otherwise go stale here; explicitly nulling on the
      // "absent" branch is just this write's normal shape, not a
      // speculative reset for a re-enrichment path that doesn't exist.
      suggestedCategoryName: patch.suggestedCategory?.name ?? null,
      suggestedCategoryParentName: patch.suggestedCategory?.parentName ?? null,
      suggestedCategoryReason: patch.suggestedCategory?.reason ?? null,
      suggestedCategoryIcon: patch.suggestedCategory?.icon ?? null,
    },
  });

  // The quick-submit guess and the AI-refined result can land in different
  // months (a relative date like "دیروز" resolving across a month
  // boundary) - invalidate both, same reasoning as updateTransaction above.
  await Promise.all([
    invalidateSpendingSummaryCache(userId, existing.date),
    ...(patch.date ? [invalidateSpendingSummaryCache(userId, patch.date)] : []),
  ]);
}

// Terminal failure path for lib/workflows/enrich-transaction.ts - the AI
// parse step exhausted its retries, or was skipped outright by the same
// per-user rate limit the live-preview endpoint uses (see POST
// /api/transactions). Same "still pending" guard as
// applyTransactionEnrichment above and for the same reason: a manual edit
// that already landed must win.
//
// `rawInput` is the same free text createTransaction stored on this row
// (quick-submit only - see CreateTransactionInput.rawInput's own comment) -
// checked here against hasStrongIncomeSignal (lib/extract-income-signal.ts)
// as a last-resort correction. Without this, a quick-submit transaction
// whose AI enrichment never completes is stuck on handleQuickSubmit's
// hardcoded type: "expense" guess forever, silently corrupting every
// downstream balance calculation (getTotalBalance in lib/data/accounts.ts
// sums by `type` unconditionally, feeding straight into goal feasibility -
// see lib/goals/feasibility.ts). This is deliberately narrow (only the
// clearest, unambiguous keyword matches flip type/category - see that
// function's own comment) and is belt-and-suspenders with, not a
// replacement for, enrichmentStatus: "failed"'s own UI nudge
// (transaction-row.tsx) - the row still lands on "failed" either way so the
// user is still prompted to double-check it by hand.
export async function markEnrichmentFailed(userId: number, id: number, rawInput: string): Promise<void> {
  let correction: { type: "income"; categoryId: number } | undefined;
  if (hasStrongIncomeSignal(rawInput)) {
    const incomeCategory = await prisma.category.findFirst({
      where: { userId, name: FALLBACK_INCOME_CATEGORY, type: "income" },
    });
    // Same "never throw away a saved transaction over a missing category"
    // reasoning as applyTransactionEnrichment's own category lookup above -
    // if the seeded fallback category is somehow missing for this user,
    // leave the row exactly as the guard below would with no correction at
    // all, rather than fail this whole call.
    if (incomeCategory) {
      correction = { type: "income", categoryId: incomeCategory.id };
    }
  }

  const result = await prisma.transaction.updateMany({
    where: { id, userId, enrichmentStatus: "pending" },
    data: { enrichmentStatus: "failed", ...correction },
  });

  // Only reachable once the update above actually applied (guarded by the
  // still-"pending" where clause) and it actually changed `type` - a plain
  // status flip with no correction doesn't change any month's income/
  // expense totals, so there's nothing to invalidate.
  if (result.count > 0 && correction) {
    const updated = await prisma.transaction.findFirst({ where: { id, userId }, select: { date: true } });
    if (updated) await invalidateSpendingSummaryCache(userId, updated.date);
  }
}

// Backs POST /api/transactions/[id]/suggested-category's "accept" action -
// `categoryId` is the real category already resolved by that route (via
// lib/data/categories.ts's resolveOrCreateCategoryFromSuggestion), not
// re-validated here beyond ownership since resolving/creating it is that
// route's job, not this data-layer function's.
//
// Guarded on suggestedCategoryName still being non-null, read fresh here
// rather than trusted from the caller - same "source of truth, not an
// assumption about call order" reasoning as applyTransactionEnrichment's
// own "still pending" guard: a transaction whose suggestion was already
// accepted/dismissed (or that never had one) must not be silently
// re-pointed at some other category by a stale/replayed request.
export async function applySuggestedCategory(userId: number, id: number, categoryId: number): Promise<void> {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  if (existing.suggestedCategoryName === null) {
    throw new TransactionNotFoundError("این تراکنش پیشنهاد دسته‌بندی‌ای ندارد.");
  }

  await prisma.transaction.update({
    where: { id },
    data: {
      categoryId,
      suggestedCategoryName: null,
      suggestedCategoryParentName: null,
      suggestedCategoryReason: null,
      suggestedCategoryIcon: null,
    },
  });

  await invalidateSpendingSummaryCache(userId, existing.date);
}

// Backs POST /api/transactions/[id]/suggested-category's "dismiss" action -
// same guard as applySuggestedCategory above, but leaves categoryId (and
// everything else about the row) untouched: dismissing just means "stop
// showing me this banner," not "undo the fallback category enrichment
// already assigned."
export async function dismissSuggestedCategory(userId: number, id: number): Promise<void> {
  const existing = await prisma.transaction.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new TransactionNotFoundError("تراکنش یافت نشد.");
  }
  if (existing.suggestedCategoryName === null) {
    throw new TransactionNotFoundError("این تراکنش پیشنهاد دسته‌بندی‌ای ندارد.");
  }

  await prisma.transaction.update({
    where: { id },
    data: {
      suggestedCategoryName: null,
      suggestedCategoryParentName: null,
      suggestedCategoryReason: null,
      suggestedCategoryIcon: null,
    },
  });
}
