import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/error-log";

// Phase 6 privacy-audit regression coverage: logError() writes directly to
// the ErrorLog table (app/app/admin/logs), bypassing the pino/Sentry
// pipeline (lib/observability/report-error.ts) entirely - so it needs its
// own redact() call, not a shared one. Locks in that a raw financial
// identifier reaching this path (via an upstream error's .message, or via
// app/api/log-error/route.ts's unauthenticated client-submitted input)
// doesn't end up sitting unredacted in a table the admin UI displays.
describe("logError - Phase 6 redaction", () => {
  const testRoute = `TEST-ERROR-LOG-REDACTION-${Date.now()}`;

  afterAll(async () => {
    await prisma.errorLog.deleteMany({ where: { route: testRoute } });
    await prisma.$disconnect();
  });

  it("redacts a financial-identifier-shaped digit run out of message and stack before storing", async () => {
    const message = "card 610433781234 declined";
    const stack = "Error: card 610433781234 declined\n    at charge (lib/x.ts:1:1)";

    await logError({ route: testRoute, message, stack });

    const row = await prisma.errorLog.findFirst({ where: { route: testRoute }, orderBy: { id: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.message).not.toContain("610433781234");
    expect(row!.message).toContain("[REDACTED_NUMBER]");
    expect(row!.stack).not.toContain("610433781234");
    expect(row!.stack).toContain("[REDACTED_NUMBER]");
    // Everything else around the redacted number is preserved, not the
    // whole message thrown away - the point is closing the leak, not
    // making the table useless for debugging.
    expect(row!.message).toBe("card [REDACTED_NUMBER] declined");
  });

  it("leaves an ordinary, non-identifier-shaped message untouched", async () => {
    const message = "ارسال پیامک OTP ناموفق بود.";
    await logError({ route: testRoute, message });

    const row = await prisma.errorLog.findFirst({ where: { route: testRoute, message }, orderBy: { id: "desc" } });
    expect(row).not.toBeNull();
    expect(row!.message).toBe(message);
  });
});
