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
import { parseTransactionWithAI, type ParsedTransaction } from "@/lib/ai/parse-transaction";
import { listCategories } from "@/lib/data/categories";
import { applyTransactionEnrichment, markEnrichmentFailed } from "@/lib/data/transactions";
import type { CategoryType } from "@/lib/categories";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

export async function enrichTransactionWorkflow(userId: number, transactionId: number, rawInput: string) {
  "use workflow";

  try {
    const parsed = await runAiParse(userId, rawInput);
    await applyEnrichment(userId, transactionId, parsed);
  } catch (error) {
    // Reached once runAiParse's own retries are exhausted, or if
    // applyEnrichment itself throws (e.g. the AI-resolved category no
    // longer exists - see applyTransactionEnrichment's own comment). Either
    // way the quick-submit's deterministic best-guess values are left
    // standing; this just flips the row out of "pending" so the UI stops
    // showing a spinner that will never resolve.
    await recordFailure(userId, transactionId, error);
  }
}

// Same categories-then-parse shape app/api/transactions/parse/route.ts
// already uses for the live-preview endpoint - kept as one step (not split
// further) since both calls are cheap DB/AI I/O with nothing worth
// resuming independently between them.
async function runAiParse(userId: number, rawInput: string): Promise<ParsedTransaction> {
  "use step";

  const categories = await listCategories(userId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const categoryOptions = categories.map((c) => ({
    name: c.name,
    type: c.type as CategoryType,
    parentName: c.parentId ? categoryById.get(c.parentId)?.name : undefined,
  }));

  return parseTransactionWithAI(userId, rawInput, categoryOptions);
}

async function applyEnrichment(userId: number, transactionId: number, parsed: ParsedTransaction) {
  "use step";

  await applyTransactionEnrichment(userId, transactionId, {
    amount: parsed.amount,
    type: parsed.type,
    categoryName: parsed.category,
    description: parsed.description,
    date: new Date(parsed.date),
  });
}

async function recordFailure(userId: number, transactionId: number, error: unknown) {
  "use step";

  reportError({
    errorType: ERROR_TYPES.AI_ERROR,
    route: "workflows/enrich-transaction",
    userId,
    message: error instanceof Error ? error.message : "Background transaction enrichment failed",
    error,
    context: { transactionId },
  });
  await markEnrichmentFailed(userId, transactionId);
}
