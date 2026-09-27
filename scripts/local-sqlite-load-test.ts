/**
 * Standalone, local-only concurrency/load test for a plain local SQLite file
 * accessed via @libsql/client (the same client the app uses at runtime for
 * Turso). Not part of the app; does not import Prisma Client or touch any
 * Turso/remote connection string.
 *
 * Simulates N "users" concurrently inserting Transaction-shaped rows
 * (interleaved with reads) against a single local SQLite file, and reports
 * error counts, SQLITE_BUSY/"database is locked" occurrences, and write
 * latency percentiles.
 *
 * Usage:
 *   npx tsx scripts/local-sqlite-load-test.ts <path-to-db-file> [N] [writesPerUser]
 *
 * Example:
 *   npx tsx scripts/local-sqlite-load-test.ts /tmp/jib-local-test.db 20
 */
import { createClient, type Client } from "@libsql/client";

// Applied to every connection immediately after opening, mirroring the
// PRAGMAs a production single-writer/many-reader Node app would set:
//   - journal_mode = WAL: readers no longer block behind a writer (and vice
//     versa) the way they do under the default rollback journal, which is
//     the main lever for concurrent throughput here.
//   - busy_timeout = 5000: have SQLite internally retry-and-wait up to 5s
//     for a locked resource before raising SQLITE_BUSY, instead of failing
//     immediately - matches @libsql/client's own default retry behavior
//     under contention rather than surfacing spurious errors under load.
//   - synchronous = NORMAL: the standard pairing with WAL mode - safe
//     against app/process crashes (only a full OS crash at the wrong instant
//     can lose the last commit), and much faster than the FULL default
//     since it skips an fsync on every transaction commit.
async function applyPragmas(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL;");
  await client.execute("PRAGMA busy_timeout = 5000;");
  await client.execute("PRAGMA synchronous = NORMAL;");
}

const dbPath = process.argv[2];
const N = Number(process.argv[3] ?? 20);
const writesPerUser = Number(process.argv[4] ?? 10);

if (!dbPath) {
  console.error("Usage: npx tsx scripts/local-sqlite-load-test.ts <path-to-db-file> [N] [writesPerUser]");
  process.exit(1);
}
if (!dbPath.startsWith("/tmp/") && !dbPath.includes("local-test")) {
  console.error(`Refusing to run against "${dbPath}" - path must be under /tmp/ or contain "local-test" as a safety check against accidentally pointing this at a real DB file.`);
  process.exit(1);
}

const url = `file:${dbPath}`;
console.log(`Target: ${url}`);
console.log(`N (concurrent users) = ${N}, writes per user = ${writesPerUser}`);

async function setupFixtures(): Promise<{ userId: number; accountId: number; categoryId: number }> {
  const client = createClient({ url });
  await applyPragmas(client);
  const user = await client.execute({
    sql: `INSERT INTO User (email, name, updatedAt) VALUES (?, ?, datetime('now')) RETURNING id`,
    args: [`load-test-${Date.now()}@example.com`, "Load Test User"],
  });
  const userId = Number(user.rows[0]!["id"]);

  const account = await client.execute({
    sql: `INSERT INTO FinanceAccount (name, type, initialBalance, userId, updatedAt) VALUES (?, ?, ?, ?, datetime('now')) RETURNING id`,
    args: ["Load Test Account", "checking", 0, userId],
  });
  const accountId = Number(account.rows[0]!["id"]);

  const category = await client.execute({
    sql: `INSERT INTO Category (name, icon, color, type, userId) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: ["Load Test Category", "tag", "#000000", "expense", userId],
  });
  const categoryId = Number(category.rows[0]!["id"]);

  client.close();
  return { userId, accountId, categoryId };
}

function toErrorInfo(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;
  return { message, code };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function simulateUser(
  userIndex: number,
  fixtures: { userId: number; accountId: number; categoryId: number },
  writeLatencies: number[],
  errors: { message: string; code?: string }[],
): Promise<void> {
  const client = createClient({ url });
  await applyPragmas(client);
  for (let i = 0; i < writesPerUser; i++) {
    const start = performance.now();
    try {
      await client.execute({
        sql: `INSERT INTO "Transaction" (amount, type, description, rawInput, date, userId, accountId, categoryId, updatedAt)
              VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now'))`,
        args: [
          Math.floor(Math.random() * 1_000_000),
          i % 2 === 0 ? "expense" : "income",
          `load test tx u${userIndex} #${i}`,
          `load test tx u${userIndex} #${i}`,
          fixtures.userId,
          fixtures.accountId,
          fixtures.categoryId,
        ],
      });
      writeLatencies.push(performance.now() - start);
    } catch (err: unknown) {
      errors.push(toErrorInfo(err));
    }

    try {
      await client.execute({
        sql: `SELECT COUNT(*) as c FROM "Transaction" WHERE userId = ?`,
        args: [fixtures.userId],
      });
    } catch (err: unknown) {
      errors.push(toErrorInfo(err));
    }
  }
  client.close();
}

async function main() {
  const fixtures = await setupFixtures();
  console.log(`Fixtures created: userId=${fixtures.userId}, accountId=${fixtures.accountId}, categoryId=${fixtures.categoryId}`);

  const writeLatencies: number[] = [];
  const errors: { message: string; code?: string }[] = [];

  const overallStart = performance.now();
  await Promise.all(
    Array.from({ length: N }, (_, i) => simulateUser(i, fixtures, writeLatencies, errors)),
  );
  const overallMs = performance.now() - overallStart;

  const sorted = [...writeLatencies].sort((a, b) => a - b);
  const busyErrors = errors.filter(
    (e) => e.code === "SQLITE_BUSY" || /database is locked/i.test(e.message),
  );

  console.log("\n=== RESULTS ===");
  console.log(`Total time: ${overallMs.toFixed(1)} ms`);
  console.log(`Total writes attempted: ${N * writesPerUser}`);
  console.log(`Successful writes: ${writeLatencies.length}`);
  console.log(`Total errors: ${errors.length}`);
  console.log(`SQLITE_BUSY / "database is locked" errors: ${busyErrors.length}`);
  console.log(`Write latency p50: ${percentile(sorted, 50).toFixed(2)} ms`);
  console.log(`Write latency p95: ${percentile(sorted, 95).toFixed(2)} ms`);
  if (errors.length > 0) {
    console.log("\nSample errors (up to 10):");
    for (const e of errors.slice(0, 10)) {
      console.log(`  - [${e.code ?? "?"}] ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
