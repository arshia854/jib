import { describe, it, expect, vi, beforeEach } from "vitest";

// Without the Workflow DevKit compiler "use workflow"/"use step" are no-ops,
// so enrichTransactionWorkflow (which only calls steps) runs as a plain
// async function - the unit-testing approach node_modules/workflow/docs/
// testing/index.mdx documents. Everything with I/O is mocked; the rate
// limiter is the real in-memory one.
vi.mock("@/lib/ai/parse-transaction", () => ({
  parseTransactionWithAI: vi.fn(),
}));
vi.mock("@/lib/data/categories", () => ({
  listCategories: vi.fn(async () => []),
  toCategoryOptions: vi.fn(() => []),
}));
vi.mock("@/lib/data/transactions", () => ({
  applyTransactionEnrichment: vi.fn(async () => {}),
  markEnrichmentFailed: vi.fn(async () => {}),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: vi.fn(),
}));

import { parseTransactionWithAI } from "@/lib/ai/parse-transaction";
import { applyTransactionEnrichment, markEnrichmentFailed } from "@/lib/data/transactions";
import { reportError } from "@/lib/observability/report-error";
import { checkRateLimit, TRANSACTION_PARSE_USER_RULE } from "@/lib/rate-limit";
import { enrichTransactionWorkflow } from "@/lib/workflows/enrich-transaction";

const mockedParse = vi.mocked(parseTransactionWithAI);

// Unique per test so the shared in-memory rate-limit store never carries
// state between cases.
let nextUserId = 900_000;

beforeEach(() => {
  vi.clearAllMocks();
  mockedParse.mockResolvedValue({
    amount: 50000,
    type: "expense",
    category: "خوراک",
    description: "ناهار",
    date: "2026-09-25",
  } as Awaited<ReturnType<typeof parseTransactionWithAI>>);
});

describe("enrichTransactionWorkflow - in-step AI rate limit", () => {
  it("calls the AI parser and applies enrichment while under the per-user limit", async () => {
    const userId = nextUserId++;

    await enrichTransactionWorkflow(userId, 1, "ناهار ۵۰ تومن");

    expect(mockedParse).toHaveBeenCalledTimes(1);
    expect(applyTransactionEnrichment).toHaveBeenCalledTimes(1);
    expect(markEnrichmentFailed).not.toHaveBeenCalled();
  });

  it("skips the AI call and marks enrichment failed once the per-user limit is exhausted", async () => {
    const userId = nextUserId++;
    for (let i = 0; i < TRANSACTION_PARSE_USER_RULE.limit; i++) {
      checkRateLimit(`transaction-parse:user:${userId}`, TRANSACTION_PARSE_USER_RULE);
    }

    await enrichTransactionWorkflow(userId, 2, "ناهار ۵۰ تومن");

    expect(mockedParse).not.toHaveBeenCalled();
    expect(applyTransactionEnrichment).not.toHaveBeenCalled();
    expect(markEnrichmentFailed).toHaveBeenCalledWith(userId, 2, "ناهار ۵۰ تومن");
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ userId, context: { transactionId: 2 } })
    );
  });

  it("does not consume another user's budget", async () => {
    const exhaustedUserId = nextUserId++;
    const otherUserId = nextUserId++;
    for (let i = 0; i < TRANSACTION_PARSE_USER_RULE.limit; i++) {
      checkRateLimit(`transaction-parse:user:${exhaustedUserId}`, TRANSACTION_PARSE_USER_RULE);
    }

    await enrichTransactionWorkflow(otherUserId, 3, "ناهار ۵۰ تومن");

    expect(mockedParse).toHaveBeenCalledTimes(1);
    expect(markEnrichmentFailed).not.toHaveBeenCalled();
  });
});

describe("enrichTransactionWorkflow - keepDate", () => {
  it("applies the AI's date by default", async () => {
    await enrichTransactionWorkflow(nextUserId++, 4, "ناهار ۵۰ تومن");

    expect(applyTransactionEnrichment).toHaveBeenCalledWith(
      expect.any(Number),
      4,
      expect.objectContaining({ date: new Date("2026-09-25") })
    );
  });

  it("leaves the date out of the patch when the user picked it by hand", async () => {
    await enrichTransactionWorkflow(nextUserId++, 5, "ناهار ۵۰ تومن", { keepDate: true });

    const patch = vi.mocked(applyTransactionEnrichment).mock.calls[0][2];
    expect(patch.date).toBeUndefined();
    expect(patch.amount).toBe(50000);
  });
});
