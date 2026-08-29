import { describe, it, expect, vi, beforeEach } from "vitest";

// pino writes real JSON to stdout in this test env (see logger.ts's own
// doc comment / the Phase 12 roadmap-status.md verification note), so the
// logger itself is mocked here purely to make the exact `msg` argument it
// receives assertable, not because pino needs stubbing to run safely.
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { logger } from "@/lib/observability/logger";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Phase 6 privacy-audit regression coverage: pino's `formatters.log()` only
// ever sees the merged *fields* object (the first argument to
// logger.error()), never the `msg` string itself (confirmed against pino's
// own source - see report-error.ts's comment) - so redact() must be
// applied to `message` explicitly before it reaches logger.error(), or a
// raw upstream error string (e.g. a JSON.parse SyntaxError quoting a
// snippet of the AI's response) would reach stdout unredacted regardless
// of how thoroughly `context` is scrubbed.
describe("reportError - Phase 6 message redaction", () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  it("redacts a financial-identifier-shaped digit run out of the logged message", () => {
    reportError({
      errorType: ERROR_TYPES.PARSER_ERROR,
      route: "ai/parse-transaction",
      message: "prefix 610433781234",
      error: new Error("prefix 610433781234"),
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [, loggedMessage] = vi.mocked(logger.error).mock.calls[0];
    expect(loggedMessage).not.toContain("610433781234");
    expect(loggedMessage).toBe("prefix [REDACTED_NUMBER]");
  });

  it("leaves an ordinary message untouched", () => {
    reportError({
      errorType: ERROR_TYPES.API_ERROR,
      route: "transactions",
      message: "Unexpected error creating transaction",
      error: new Error("Unexpected error creating transaction"),
    });

    const [, loggedMessage] = vi.mocked(logger.error).mock.calls[0];
    expect(loggedMessage).toBe("Unexpected error creating transaction");
  });
});
