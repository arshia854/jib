import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/nvidia-ai", () => ({
  chatCompletion: vi.fn(),
  AI_PROVIDER: "nvidia-nim",
}));

// Mocked purely to make the exact fields logger.info() receives assertable
// (same rationale/pattern as lib/observability/report-error.test.ts) - pino
// itself needs no stubbing to run safely under vitest.
vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { chatCompletion } from "@/lib/nvidia-ai";
import { logger } from "@/lib/observability/logger";
import { detectTransactionIntent } from "@/lib/ai/detect-transaction-intent";

describe("detectTransactionIntent", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  it("returns true for a clear past unlogged expense", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": true}');
    const result = await detectTransactionIntent("دیروز ۲۰۰ تومن آبمیوه خوردم یادم رفت ثبت کنم", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: true });
  });

  it("returns false for a general financial question", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": false}');
    const result = await detectTransactionIntent("این ماه بیشتر کجا خرج کردم؟", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("strips a ```json fence the same way parse-transaction's extractJson does", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('```json\n{"isPastUnloggedTransaction": true}\n```');
    const result = await detectTransactionIntent("پریروز ۵۰ تومن قهوه خوردم، ثبت نکردم", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: true });
  });

  it("fails safe to false on malformed JSON", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("not json at all");
    const result = await detectTransactionIntent("سلام", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("fails safe to false when the key is missing", async () => {
    vi.mocked(chatCompletion).mockResolvedValue("{}");
    const result = await detectTransactionIntent("سلام", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("fails safe to false when the upstream call throws", async () => {
    vi.mocked(chatCompletion).mockRejectedValue(new Error("network error"));
    const result = await detectTransactionIntent("سلام", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  it("treats any non-true value for the key as false (not just literal false)", async () => {
    vi.mocked(chatCompletion).mockResolvedValue('{"isPastUnloggedTransaction": "yes"}');
    const result = await detectTransactionIntent("سلام", 1);
    expect(result).toEqual({ isPastUnloggedTransaction: false });
  });

  // Phase 9.4 - detectTransactionIntent() wires chatCompletion's onUsage
  // callback into its existing success log line (additive field, not a new
  // logger.info call).
  it("includes token usage in the success log line when chatCompletion reports one", async () => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(chatCompletion).mockImplementation(async (_messages, options) => {
      options?.onUsage?.({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
      return '{"isPastUnloggedTransaction": false}';
    });

    await detectTransactionIntent("سلام", 1);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(logger.info).mock.calls[0];
    expect(fields).toMatchObject({ usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 } });
  });
});
