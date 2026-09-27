// Minimal production logger: JSON lines to stdout, nothing else. Per the
// Phase 12 spec - "Keep the logger config minimal... no extra transports" -
// this deliberately does NOT add pino-pretty (or any other transport) for
// dev either: pino with no `transport` configured already just writes raw
// JSON straight to stdout, which is exactly "JSON to stdout only, no
// pretty-printing in production" with zero extra dependencies beyond pino
// itself (the only one this sub-task is scoped to add).
//
// Every call site is expected to pass its own fields object, e.g.
// `logger.error({ requestId, route, userId, errorType: ERROR_TYPES.AI_ERROR, duration, ...context }, "message text")`
// - this module does not reach into lib/observability/request-context.ts
// (a different sub-task's file) to auto-inject requestId; callers that
// have one (via getRequestId(), added in 12.2) pass it explicitly like any
// other field.
import pino from "pino";
import { redact } from "@/lib/observability/redact";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),

  // Per-entry field list the Phase 12 spec asks for is: timestamp, level,
  // requestId, route, userId, duration, errorType, message. `base: null`
  // drops pino's own default `pid`/`hostname` bindings, which aren't in
  // that list and aren't otherwise useful for this app's scale (a single
  // Vercel function per request, not a long-lived multi-process host).
  base: null,

  // Renames pino's default "msg" key to "message", matching the spec's
  // field name exactly - the value itself still comes from the normal
  // pino calling convention (`logger.info(fields, "the message")`).
  messageKey: "message",

  // Renames pino's default "time" key (a raw epoch-ms number) to
  // "timestamp" (an ISO-8601 string), again to match the spec's field
  // name/shape exactly rather than pino's own default.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

  formatters: {
    // Default level shape is a bare number (e.g. 30); this makes it the
    // human-readable label ("info", "error", ...) instead, matching the
    // spec's plain `level` field.
    level(label) {
      return { level: label };
    },
    // Runs on every log call's fields object before it's written -
    // exactly the "before anything is written, not after" requirement.
    // Reuses lib/observability/redact.ts as the one, shared redaction
    // implementation (see redact.ts's own doc comment) rather than a
    // second copy of the same logic.
    log(object) {
      return redact(object);
    },
  },

  // pino's own well-known convention for logging an Error under the `err`
  // key (`logger.error({ err }, "...")`) - reused as-is rather than
  // reinventing Error -> {type, message, stack} serialization inside
  // redact.ts, which only needs to handle plain data shapes (see its own
  // doc comment).
  serializers: {
    err: pino.stdSerializers.err,
  },
});
