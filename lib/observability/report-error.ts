import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/observability/logger";
import { redact } from "@/lib/observability/redact";
import { getRequestId } from "@/lib/observability/request-context";
import type { ErrorType } from "@/lib/observability/error-types";

export interface ReportErrorParams {
  errorType: ErrorType;
  route: string;
  message: string;
  error: unknown;
  userId?: number | null;
  duration?: number;
  context?: Record<string, unknown>;
}

// One place that both (a) writes a structured pino error log line and (b)
// reports the same failure to Sentry with requestId/userId attached via
// scope - added so every instrumented call site across Phase 12.4 (AI) and
// 12.5 (DB/parser/API/SMS) does both consistently, instead of re-deriving
// this exact pairing at each one (the Phase 12 spec asks for requestId +
// userId on "every log line and Sentry report", at every one of those sites).
//
// Redaction (lib/observability/redact.ts, Phase 12.1) already runs inside
// both logger.ts (a pino formatter) and the Sentry config files
// (beforeSend/beforeSendTransaction, Phase 12.3) - so `context` is passed
// straight through to both and gets masked there, once, not a second time.
//
// `message`, however, does not go through logger.ts's formatter: pino only
// runs `formatters.log()` over the *merged fields object* (the first
// argument), never over the `msg` string itself (confirmed against pino's
// own source, lib/tools.js's `_asJson` - `formatters.log(obj)` runs before
// `msg` is even read) - so a `message` string built from `error.message`
// (e.g. a JSON.parse SyntaxError quoting a snippet of the AI's response,
// or NVIDIA NIM's own raw error-response text) would otherwise reach
// stdout completely unredacted regardless of what logger.ts/redact.ts do
// to `context`. Explicitly redacted here (Phase 6 privacy-audit finding)
// before it becomes pino's msg argument. Sentry's copy of the same string
// (`error.message`, surfaced via `Sentry.captureException(error)` below)
// doesn't need the same explicit treatment - it flows through
// `event.exception.values[].value`, which beforeSend's `redact(event)`
// already walks as an ordinary string value.
export function reportError({ errorType, route, message, error, userId, duration, context }: ReportErrorParams): void {
  const requestId = getRequestId();

  logger.error({ requestId, route, userId: userId ?? undefined, errorType, duration, context }, redact(message));

  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("requestId", requestId);
    if (userId != null) scope.setUser({ id: userId });
    scope.setTag("errorType", errorType);
    scope.setTag("route", route);
    if (context) scope.setContext("details", context);
    Sentry.captureException(error);
  });
}
