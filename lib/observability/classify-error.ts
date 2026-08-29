// True when `error` looks like a Prisma/driver-level failure - i.e. it
// carries Prisma's own error-code shape (a string matching /^P\d{4}$/, e.g.
// P2002, P2025, or - per the Phase 12 audit - P2039, the code this
// codebase's driver adapter (@prisma/adapter-libsql) actually wraps every
// raw database error in (confirmed in app/api/categories/route.ts's own
// isUniqueConstraintError() comment: "P2002 alone never actually fires
// here"). Used at each route's existing catch-all (the final `throw error`
// after all known domain-error `instanceof` checks) to classify an
// otherwise-unhandled failure as DB_ERROR vs. the more generic API_ERROR
// fallback for anything else - never used to change what response is
// returned, only how it's logged/reported.
const PRISMA_ERROR_CODE_PATTERN = /^P\d{4}$/;

export function isPrismaErrorCode(error: unknown): error is { code: string } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    PRISMA_ERROR_CODE_PATTERN.test((error as { code: string }).code)
  );
}

// Same detection logic as app/api/categories/route.ts's own (local, not
// exported) isUniqueConstraintError() - P2002 is Prisma's standard
// unique-constraint code for its native query engine, but this project's
// driver adapter (@prisma/adapter-libsql) routes every raw database error
// through the generic P2039 "driver adapter error" wrapper instead, so
// P2002 alone never actually fires here (confirmed by that route's own
// comment). P2039 also wraps unrelated driver errors (timeouts, syntax
// errors, ...), so it's only treated as a collision once the underlying
// SQLite message confirms a UNIQUE constraint violation. Homed here
// (rather than a third near-duplicate copy) since SEC-10's idempotency-key
// unique index (Transaction_userId_idempotencyKey_key, see
// lib/data/transactions.ts's createTransaction()) needs the identical
// check and this module is already this codebase's shared home for
// Prisma-error classification (isPrismaErrorCode above) - categories/route.ts's
// own copy is left exactly as it was, not migrated to import this, since
// that's outside this change's scope.
export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2002") return true;
  return (
    error.code === "P2039" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("UNIQUE constraint failed")
  );
}
