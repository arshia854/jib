// Side-effect-only module: must be imported BEFORE anything that imports
// "@/lib/prisma" (including transitively, e.g. via lib/data/onboarding.ts) -
// see refresh-user-categories.ts's own import order for why this matters
// (ESM import statements evaluate in declaration order, so this file's
// top-level assignment below has to run first).
//
// lib/data/onboarding.ts's seedDefaultCategoriesForUser() wraps its ~40
// sequential create/createMany round trips (23 top-level categories, ~17
// with children) in one `prisma.$transaction(async (tx) => ...)` with no
// explicit options, so it inherits Prisma's default interactive-transaction
// timeout - 5000ms. Measured against live Turso: the very first user's call
// took 5354ms and was aborted (P2028 "query cannot be executed on an
// expired transaction"), which then rolled back cleanly (verified: all 74
// users sat at exactly 0 categories afterward, not a partial count) but
// meant zero users actually got reseeded.
//
// lib/prisma.ts already has a global-singleton reuse hook
// (`globalForPrisma.prisma ?? new PrismaClient(...)`) - originally there
// for Next.js dev-mode HMR dedup, but it doubles as exactly the injection
// point needed here. Setting `globalThis.prisma` to a client constructed
// with a longer `transactionOptions.timeout` means lib/prisma.ts's own
// `export const prisma = globalForPrisma.prisma ?? new PrismaClient(...)`
// picks this one up instead of constructing its own - so every
// `prisma.$transaction()` call made through that shared export (including
// inside seedDefaultCategoriesForUser, unmodified) gets the longer timeout,
// without editing lib/prisma.ts or lib/data/onboarding.ts, neither of which
// is in this task's approved file list.
import "dotenv/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const adapter = new PrismaLibSql({
  url: requireEnv("TURSO_DATABASE_URL"),
  authToken: requireEnv("TURSO_AUTH_TOKEN"),
});

(globalThis as unknown as { prisma?: PrismaClient }).prisma = new PrismaClient({
  adapter,
  // 60s / 15s - generous headroom over the observed 5354ms for one user's
  // full seed, not tuned to a razor edge.
  transactionOptions: { timeout: 60000, maxWait: 15000 },
});
