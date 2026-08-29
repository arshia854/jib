import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { getSession } from "@/lib/auth/session";
import {
  listTransactions,
  createTransaction,
  markEnrichmentFailed,
  InvalidCategoryError,
  InvalidAccountError,
  type TransactionSource,
  type AssetPurchaseInput,
} from "@/lib/data/transactions";
import { enrichTransactionWorkflow } from "@/lib/workflows/enrich-transaction";
import type { CategoryType } from "@/lib/categories";
import type { LivePricedAssetType } from "@/lib/assets";
import {
  MAX_TRANSACTION_TEXT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_TRANSACTION_AMOUNT,
  MAX_ASSET_QUANTITY,
  MAX_ASSET_PRICE_PER_UNIT,
  DEFAULT_TRANSACTIONS_PAGE_SIZE,
} from "@/lib/limits";
import { checkRateLimit, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

const VALID_SOURCES: TransactionSource[] = ["assistant-suggestion"];
const LIVE_PRICED_ASSET_TYPES: LivePricedAssetType[] = ["gold", "usd", "bitcoin"];

// Same validation lib/ai/parse-transaction.ts's own resolveAssetPurchase()
// already applied server-side before this ever reached the client (see
// ParsedTransaction.assetSuggestion) - re-checked here defensively since
// this body field is client-supplied and this route has no way to know it
// actually came from that trusted path unchanged. Reuses the exact same
// limits app/api/assets/route.ts's own POST enforces for a manually-entered
// asset, so a purchase logged through this path can't exceed what the
// Assets page itself would ever allow. Malformed/absent input is silently
// treated as "no asset purchase" (returns undefined), same permissive-input
// convention already used below for `source`/`quick`.
function parseAssetPurchaseInput(value: unknown): AssetPurchaseInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || !LIVE_PRICED_ASSET_TYPES.includes(v.type as LivePricedAssetType)) {
    return undefined;
  }
  const quantity = Number(v.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_ASSET_QUANTITY) return undefined;
  const purchasePricePerUnit = Number(v.purchasePricePerUnit);
  if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0 || purchasePricePerUnit > MAX_ASSET_PRICE_PER_UNIT) {
    return undefined;
  }
  return { type: v.type as LivePricedAssetType, quantity, purchasePricePerUnit };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const type = params.get("type");
  const categoryIdParam = params.get("categoryId");
  const from = params.get("from");
  const to = params.get("to");

  // Same defensive parse-or-fallback shape already used for `page` in
  // app/app/admin/users/page.tsx and app/app/transactions/page.tsx - invalid
  // input (missing, non-numeric, zero, negative) silently falls back rather
  // than 400ing, matching that existing precedent for pagination params
  // (unlike the content-field length checks elsewhere in this route, which
  // do reject). The hard MAX_TRANSACTIONS_PAGE_SIZE ceiling is enforced
  // inside listTransactions() itself, not here - see its own comment.
  const requestedPage = Number(params.get("page"));
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requestedPageSize = Number(params.get("pageSize"));
  const pageSize =
    Number.isInteger(requestedPageSize) && requestedPageSize > 0
      ? requestedPageSize
      : DEFAULT_TRANSACTIONS_PAGE_SIZE;

  const result = await listTransactions(
    session.userId,
    {
      type: type === "income" || type === "expense" ? type : undefined,
      categoryId: categoryIdParam ? Number(categoryIdParam) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    },
    page,
    pageSize
  );

  // { transactions, page, pageSize, total, totalPages } - `transactions`
  // keeps its exact pre-existing key/position; page/pageSize/total/totalPages
  // are new siblings. No caller of this HTTP endpoint exists in the frontend
  // today to break (the transactions list page calls listTransactions()
  // directly server-side, see app/app/transactions/page.tsx) - confirmed by
  // searching for fetch("/api/transactions") with no id/subpath.
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const amount = Number(body?.amount);
  const type: CategoryType | null = body?.type === "income" || body?.type === "expense" ? body.type : null;
  const categoryName = typeof body?.category === "string" ? body.category : "";
  const accountId = Number(body?.accountId);
  const rawInput = typeof body?.rawInput === "string" ? body.rawInput : "";
  const description = typeof body?.description === "string" ? body.description : undefined;
  const dateInput = typeof body?.date === "string" ? body.date : undefined;
  const source =
    typeof body?.source === "string" && VALID_SOURCES.includes(body.source as TransactionSource)
      ? (body.source as TransactionSource)
      : undefined;
  // SEC-10: optional client-generated idempotency key (crypto.randomUUID(),
  // see components/transactions/add-transaction-form.tsx and
  // components/chat/chat-interface.tsx). Absent entirely for any older
  // caller - createTransaction() treats undefined exactly as before this
  // sub-task, so this is purely additive.
  const idempotencyKey =
    typeof body?.idempotencyKey === "string" && body.idempotencyKey.length > 0 ? body.idempotencyKey : undefined;
  // "ثبت سریع" (quick submit, see components/transactions/add-transaction-form.tsx):
  // the client already resolved amount/type/category/date deterministically
  // (no AI call) - this flag is what tells this route to (a) mark the row
  // enrichmentStatus: "pending" and (b) kick off the background AI-parse
  // workflow below, once the row is actually saved. Anything other than a
  // literal `true` is treated as false, same permissive-input handling as
  // every other body field above.
  const quick = body?.quick === true;
  // See lib/data/transactions.ts's createTransaction() - set only when the
  // AI (lib/ai/parse-transaction.ts) or the user (via the add-transaction
  // form's checkbox) confirmed this transaction is an asset purchase.
  const assetPurchase = parseAssetPurchaseInput(body?.assetPurchase);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_TRANSACTION_AMOUNT ||
    !type ||
    !categoryName ||
    categoryName.length > MAX_NAME_LENGTH ||
    !rawInput ||
    rawInput.length > MAX_TRANSACTION_TEXT_LENGTH ||
    (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) ||
    (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) ||
    !Number.isInteger(accountId)
  ) {
    return NextResponse.json({ error: "اطلاعات تراکنش ناقص یا نامعتبر است." }, { status: 400 });
  }

  const date = dateInput && !Number.isNaN(Date.parse(dateInput)) ? new Date(dateInput) : new Date();

  try {
    const { asset, ...transaction } = await createTransaction(session.userId, {
      amount: Math.round(amount),
      type,
      categoryName,
      accountId,
      description,
      rawInput,
      date,
      source,
      idempotencyKey,
      enrichmentStatus: quick ? "pending" : undefined,
      assetPurchase,
    });

    // Only fires for a transaction still actually "pending" right now -
    // this naturally covers both "not a quick submit at all" (enrichmentStatus
    // is null, createTransaction never set it) and "already resolved by an
    // earlier call" (an idempotent replay after enrichment already
    // succeeded/failed, where re-running it would just waste an AI call -
    // see enrichTransactionWorkflow's own idempotency guards for why even a
    // rare duplicate start here is harmless, not incorrect).
    //
    // Wrapped in its own try/catch, entirely separate from the one around
    // this whole handler: nothing in this block may ever turn a successful
    // save into a failed response - quick-submit's whole point is that the
    // save always succeeds instantly, background enrichment is best-effort
    // on top of that. Any failure here (rate limit, start() itself, or
    // markEnrichmentFailed's own DB write) is reported, not rethrown.
    if (transaction.enrichmentStatus === "pending") {
      try {
        const limit = checkRateLimit(`transaction-parse:user:${session.userId}`, TRANSACTION_PARSE_USER_RULE);
        if (limit.allowed) {
          await start(enrichTransactionWorkflow, [session.userId, transaction.id, rawInput]);
        } else {
          // Same per-user AI-cost budget the live-preview endpoint enforces
          // (lib/rate-limit.ts) - quick-submit must not be a way around it.
          // The transaction itself is already saved either way; this just
          // stops it spinning on "pending" forever.
          await markEnrichmentFailed(session.userId, transaction.id);
        }
      } catch (enrichmentKickoffError) {
        reportError({
          errorType: ERROR_TYPES.API_ERROR,
          route: "transactions",
          userId: session.userId,
          message:
            enrichmentKickoffError instanceof Error
              ? enrichmentKickoffError.message
              : "Failed to start background transaction enrichment",
          error: enrichmentKickoffError,
          context: { operation: "start(enrichTransactionWorkflow)", transactionId: transaction.id },
        });
        await markEnrichmentFailed(session.userId, transaction.id).catch(() => {});
      }
    }

    // Same { transaction } shape and 201 status for a fresh create and an
    // idempotent replay (SEC-10) - deliberate: from the caller's point of
    // view, retrying a create it already made should look exactly like
    // that create succeeding again, not like a different outcome the
    // client would need to branch on. createTransaction() itself is what
    // guarantees no second row is ever actually written. `asset` is new
    // (null unless assetPurchase was set and this was a fresh create - see
    // createTransaction()'s own comment on why a replay can't echo it back)
    // and purely additive - no existing caller reads this key.
    return NextResponse.json({ transaction, asset: asset ?? null }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidCategoryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidAccountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Unhandled/unexpected only - the two known outcomes above are already
    // handled, expected results and aren't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "transactions",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error creating transaction",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createTransaction", model: "Transaction", code: error.code }
        : { operation: "createTransaction", model: "Transaction" },
    });
    throw error;
  }
}
