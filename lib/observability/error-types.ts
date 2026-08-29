// Error-type tags attached to structured log lines (see logger.ts) and
// Sentry reports, so failures can be filtered/grouped by what actually
// failed (an AI call vs. a DB write vs. an SMS send, ...) independent of
// the free-text `message`. One flat, shared set - Phase 12's own spec (not
// a per-route/per-file drifting string), matching how lib/limits.ts (Phase
// 4) already centralizes shared constants instead of letting each route
// invent its own number/string.
//
// A plain `as const` object, not a TS `enum`/`const enum`: this project
// builds through Next.js's SWC/Turbopack compiler, which transpiles file by
// file without whole-program type info - `const enum` specifically needs
// that and isn't supported there. A string-union *type* alone (this
// codebase's own precedent for a small closed set of strings - see
// `UserRole` in lib/auth/session.ts) isn't enough here either, since call
// sites need an actual runtime value to write (`errorType:
// ERROR_TYPES.AI_ERROR`), not just a type to check against - hence the
// `as const` object below plus a type derived from it.
export const ERROR_TYPES = {
  AUTH_ERROR: "AUTH_ERROR",
  PARSER_ERROR: "PARSER_ERROR",
  AI_ERROR: "AI_ERROR",
  DB_ERROR: "DB_ERROR",
  SMS_ERROR: "SMS_ERROR",
  API_ERROR: "API_ERROR",
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];
