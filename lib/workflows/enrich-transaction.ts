// Background AI enrichment for a "ثبت سریع" (quick submit) transaction -
// started (fire-and-forget) from POST /api/transactions right after the
// transaction row is created with enrichmentStatus: "pending" (see
// app/api/transactions/route.ts and schema.prisma's own comment on that
// column). Quick-submit's whole point is saving instantly with a
// deterministic best-guess amount/category (lib/extract-amount.ts,
// lib/extract-date.ts, resolveFallbackCategory) - this workflow is what
// then runs the *real* lib/ai/parse-transaction.ts pass and folds the
// result back in, reliably: Workflow DevKit retries a failing step (default
// 3x, see lib/ai/parse-transaction.ts's own error handling) without any
// hand-rolled retry/queue code here, and survives a serverless instance
// recycling mid-run.
//
// Both step functions below have full Node.js/Prisma access ("use step");
// the outer function is the sandboxed orchestrator ("use workflow") and
// must stay limited to plain control flow - see
// node_modules/workflow/docs/foundations/workflows-and-steps.mdx.
import { FatalError } from "workflow";
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories, toCategoryOptions } from "@/lib/data/categories";
import { applyTransactionEnrichment, markEnrichmentFailed } from "@/lib/data/transactions";
import { checkRateLimit, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { logger } from "@/lib/observability/logger"; // TEMP-LATENCY
import { getRequestId } from "@/lib/observability/request-context"; // TEMP-LATENCY

// `keepDate`: the user picked the transaction's date explicitly (see
// app/api/transactions/route.ts's dateIsManual) - rawInput carries no trace
// of that pick, so the AI's own date (usually just "today") must not replace
// it. Optional, so runs started before this argument existed replay unchanged.
export async function enrichTransactionWorkflow(
  userId: number,
  transactionId: number,
  rawInput: string,
  options: { keepDate?: boolean } = {}
) {
  "use workflow";

  try {
    const parsed = await runAiParse(userId, rawInput);
    await applyEnrichment(userId, transactionId, parsed, options.keepDate === true);
  } catch (error) {
    // Reached once runAiParse's own retries are exhausted, or if
    // applyEnrichment itself throws (e.g. the AI-resolved category no
    // longer exists - see applyTransactionEnrichment's own comment). The
    // quick-submit's deterministic best-guess values are left standing
    // except for markEnrichmentFailed's own narrow heuristic correction
    // (see its own comment) - this just flips the row out of "pending" so
    // the UI stops showing a spinner that will never resolve.
    await recordFailure(userId, transactionId, rawInput, error);
  }
}

// Same categories-then-parse shape app/api/transactions/parse/route.ts
// already uses for the live-preview endpoint - kept as one step (not split
// further) since both calls are cheap DB/AI I/O with nothing worth
// resuming independently between them.
async function runAiParse(userId: number, rawInput: string): Promise<ParsedTransaction> {
  "use step";

  // Defense-in-depth re-check of the same per-user AI-cost budget POST
  // /api/transactions already enforces before start(): the generated
  // /.well-known/workflow/* routes aren't covered by proxy.ts's matcher, so
  // a run started by calling them directly never passed through that check
  // (see docs/deploy-runbook.md §4). This only caps AI spend - it doesn't
  // stop a direct caller from naming another user's userId/transactionId.
  // FatalError, not a plain Error: a plain throw would be retried (default
  // 3x), each retry consuming another unit of this same budget for nothing.
  // Either way the outer try/catch routes it to recordFailure ->
  // markEnrichmentFailed, same terminal outcome as the route's own
  // rate-limited branch.
  const limit = checkRateLimit(`transaction-parse:user:${userId}`, TRANSACTION_PARSE_USER_RULE);
  if (!limit.allowed) {
    throw new FatalError("Transaction enrichment skipped: per-user AI parse rate limit exceeded");
  }

  const listCategoriesStartedAt = Date.now(); // TEMP-LATENCY
  const categories = await listCategories(userId);
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "workflows/enrich-transaction", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "listCategories", // TEMP-LATENCY
      duration: Date.now() - listCategoriesStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "enrichTransactionWorkflow step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
  const categoryOptions = toCategoryOptions(categories);

  // chatCompletion duration + completionTokens are already logged one layer
  // down, inside parseTransactionWithAI itself ("AI call succeeded", see
  // lib/ai/parse-transaction.ts) - not duplicated here, just this call's
  // own total wall time. // TEMP-LATENCY
  const parseStartedAt = Date.now(); // TEMP-LATENCY
  const parsed = await parseTransactionWithAI(userId, rawInput, categoryOptions);
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "workflows/enrich-transaction", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "parseTransactionWithAI", // TEMP-LATENCY
      duration: Date.now() - parseStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "enrichTransactionWorkflow step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
  return parsed;
}

async function applyEnrichment(userId: number, transactionId: number, parsed: ParsedTransaction, keepDate: boolean) {
  "use step";

  const applyEnrichmentStartedAt = Date.now(); // TEMP-LATENCY
  await applyTransactionEnrichment(userId, transactionId, {
    amount: parsed.amount,
    type: parsed.type,
    categoryName: parsed.category,
    description: parsed.description,
    date: keepDate ? undefined : new Date(parsed.date),
    // Only ever set alongside parsed.category already having fallen back to
    // resolveFallbackCategory(type) ("سایر...") - see parseTransactionWithAI's
    // own comment on suggestedCategory being "strictly additive". Passed
    // through as-is; applyTransactionEnrichment/schema.prisma decide what
    // happens with it from here.
    suggestedCategory: parsed.suggestedCategory,
  });
  logger.info( // TEMP-LATENCY
    { // TEMP-LATENCY
      requestId: getRequestId(), // TEMP-LATENCY
      route: "workflows/enrich-transaction", // TEMP-LATENCY
      userId, // TEMP-LATENCY
      step: "applyEnrichment", // TEMP-LATENCY
      duration: Date.now() - applyEnrichmentStartedAt, // TEMP-LATENCY
    }, // TEMP-LATENCY
    "enrichTransactionWorkflow step timing" // TEMP-LATENCY
  ); // TEMP-LATENCY
}

async function recordFailure(userId: number, transactionId: number, rawInput: string, error: unknown) {
  "use step";

  reportError({
    errorType: ERROR_TYPES.AI_ERROR,
    route: "workflows/enrich-transaction",
    userId,
    message: error instanceof Error ? error.message : "Background transaction enrichment failed",
    error,
    context: { transactionId },
  });
  await markEnrichmentFailed(userId, transactionId, rawInput);
}
