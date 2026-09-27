/**
 * F3-prep rehearsal - OFFLINE, SYNTHETIC DATA ONLY. Exercises the whole
 * Turso -> local SQLite copy path end to end without touching live:
 *
 *  1. builds a "live-like" local file with `prisma migrate deploy`, fills it
 *     through the app's own Prisma Client + libSQL adapter (so DateTime/
 *     BigInt/Float/Boolean storage is exactly what the app writes), and
 *     mimics live's known drift (no Phase 17 groupby index, no
 *     _prisma_migrations rows for the two migrations live's bookkeeping lacks);
 *  2. runs the EXISTING scripts/backup-live-db.ts and the new
 *     scripts/snapshot-live-schema.ts against that file;
 *  3. loads the result into a fresh `migrate deploy` file with
 *     scripts/load-backup-into-sqlite.ts (dry run, then --execute) and checks
 *     it with scripts/verify-sqlite-copy.ts - everything must pass;
 *  4. runs the negative cases, each of which must fail loudly with a
 *     specific message.
 *
 * Isolation: every child process gets a from-scratch env (PATH/HOME plus,
 * where needed, an explicit file: TURSO_DATABASE_URL and a dummy token) and
 * runs from an empty directory, so the repo's .env (live credentials) is
 * never loaded; each URL is asserted to be file: and printed before spawning.
 *
 * Usage: npx tsx scripts/rehearse-sqlite-copy.ts [workDir]
 *   (workDir must not exist yet; defaults to a fresh dir under the OS temp dir, kept afterwards for inspection)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/prisma/client";
import { buildMigrateDeployDb, MIGRATIONS_DIR, minimalChildEnv, REPO_ROOT, type Backup, type Manifest } from "./lib/sqlite-copy";

const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
// The only non-file: URL any child ever sees: an unreachable local port, used
// solely to prove snapshot-live-schema.ts refuses before connecting.
const REFUSAL_PROBE_URL = "http://127.0.0.1:1";
const script = (name: string) => join(REPO_ROOT, "scripts", name);

// Live's _prisma_migrations has no rows for these (see MIGRATION_NAMES in
// scripts/backfill-migration-history.ts), and the groupby index was never
// applied there - mimicked on the live-like file so the drift report has
// something real to find.
const LIVE_UNRECORDED_MIGRATIONS = [
  "20260823072849_add_transaction_balance_groupby_index",
  "20260912165902_add_live_price_quota_exceeded_until",
];

type Outcome = { label: string; ok: boolean; detail: string };
const outcomes: Outcome[] = [];

function fileUrl(path: string): string {
  const url = `file:${path}`;
  if (!url.startsWith("file:/")) throw new Error(`refusing non-file URL ${url}`);
  return url;
}

function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): { status: number | null; output: string } {
  if (env.TURSO_DATABASE_URL !== undefined) {
    if (!env.TURSO_DATABASE_URL.startsWith("file:/") && env.TURSO_DATABASE_URL !== REFUSAL_PROBE_URL) throw new Error(`ABORT: child TURSO_DATABASE_URL is not file: (${env.TURSO_DATABASE_URL})`);
    console.log(`  (child TURSO_DATABASE_URL=${env.TURSO_DATABASE_URL})`);
  }
  const result = spawnSync(TSX, args, {
    cwd,
    env: minimalChildEnv(env),
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function expectRun(
  label: string,
  cwd: string,
  args: string[],
  expect: { exit: 0 | 1; contains: string[] },
  env: Record<string, string> = {}
) {
  console.log(`\n=== ${label}\n$ tsx ${args.map((a) => a.replace(REPO_ROOT + "/", "")).join(" ")}`);
  const { status, output } = run(cwd, args, env);
  console.log(output.replace(/^/gm, "  | ").trimEnd());
  const missing = expect.contains.filter((s) => !output.includes(s));
  const ok = status === expect.exit && missing.length === 0;
  const detail = `exit ${status} (expected ${expect.exit})${missing.length ? `; missing text: ${missing.map((m) => JSON.stringify(m)).join(", ")}` : ""}`;
  outcomes.push({ label, ok, detail });
  console.log(`  => ${ok ? "OK" : "UNEXPECTED"}: ${detail}`);
  return output;
}

function check(label: string, ok: boolean, detail: string) {
  outcomes.push({ label, ok, detail });
  console.log(`  => ${ok ? "OK" : "UNEXPECTED"}: ${label} - ${detail}`);
}

async function populateSynthetic(dbPath: string) {
  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: fileUrl(dbPath) }) });
  try {
    // DefaultCategory diverges from the migration's own seed, as live's did.
    const firstDefault = await prisma.defaultCategory.findFirstOrThrow({ orderBy: { id: "asc" } });
    await prisma.defaultCategory.update({ where: { id: firstDefault.id }, data: { icon: "🏠", isEssential: false } });
    const leaf = await prisma.defaultCategory.findFirstOrThrow({ where: { children: { none: {} } }, orderBy: { id: "desc" } });
    await prisma.defaultCategory.delete({ where: { id: leaf.id } });
    const dcParent = await prisma.defaultCategory.create({ data: { name: "سرگرمی تست", icon: "🎮", color: "#123456", type: "expense" } });
    await prisma.defaultCategory.create({ data: { name: "بازی تست", icon: "🕹️", color: "#654321", type: "expense", parentId: dcParent.id } });

    const admin = await prisma.user.create({
      data: { email: "admin@example.test", name: "Admin", role: "admin", passwordHash: "$2b$10$synthetic", emailVerified: new Date("2026-08-01T10:00:00Z") },
    });
    const u1 = await prisma.user.create({ data: { phoneNumber: "09120000001", name: "کاربر یک", age: 31, showBalanceInAssets: true } });
    const u2 = await prisma.user.create({
      data: { email: "g@example.test", image: "https://example.test/a.png", blockedAt: new Date("2026-09-01T08:30:00.123Z") },
    });
    const gone = await prisma.user.create({ data: { phoneNumber: "09120000009" } });

    await prisma.account.create({
      data: { userId: u2.id, type: "oidc", provider: "google", providerAccountId: "g-123", access_token: "tok", expires_at: 1790000000, scope: "openid email", id_token: "x.y.z" },
    });

    const checking = await prisma.financeAccount.create({ data: { userId: u1.id, name: "حساب جاری", type: "bank", initialBalance: 5_000_000 } });
    const savings = await prisma.financeAccount.create({ data: { userId: u1.id, name: "پس‌انداز", type: "bank" } });
    const cash = await prisma.financeAccount.create({ data: { userId: u2.id, name: "نقد", type: "cash", initialBalance: -20_000 } });
    const goneAcct = await prisma.financeAccount.create({ data: { userId: gone.id, name: "x", type: "cash" } });

    const food = await prisma.category.create({ data: { userId: u1.id, name: "خوراک", icon: "🍔", color: "#f00", type: "expense" } });
    const restaurant = await prisma.category.create({ data: { userId: u1.id, name: "رستوران", icon: "🍽️", color: "#f10", type: "expense", parentId: food.id, isEssential: false } });
    const salary = await prisma.category.create({ data: { userId: u1.id, name: "حقوق", icon: "💰", color: "#0f0", type: "income" } });
    const trOut = await prisma.category.create({ data: { userId: u1.id, name: "انتقال", icon: "↔️", color: "#999", type: "expense", isTransfer: true } });
    const trIn = await prisma.category.create({ data: { userId: u1.id, name: "انتقال", icon: "↔️", color: "#999", type: "income", isTransfer: true } });
    // Stale: an old-named category nothing references any more.
    await prisma.category.create({ data: { userId: u1.id, name: "خانه و زندگی", icon: "🏠", color: "#00f", type: "expense" } });
    const transport = await prisma.category.create({ data: { userId: u2.id, name: "حمل و نقل", icon: "🚕", color: "#ff0", type: "expense" } });
    const goneCat = await prisma.category.create({ data: { userId: gone.id, name: "x", icon: "x", color: "#000", type: "expense" } });

    await prisma.transaction.create({
      data: { userId: u1.id, accountId: checking.id, categoryId: restaurant.id, amount: 250_000, type: "expense", rawInput: "ناهار ۲۵۰ تومن", description: "ناهار", date: new Date("2026-09-10T12:00:00Z") },
    });
    await prisma.transaction.create({
      data: { userId: u1.id, accountId: checking.id, categoryId: salary.id, amount: 30_000_000, type: "income", rawInput: "حقوق", source: "assistant-suggestion", idempotencyKey: "idem-1" },
    });
    await prisma.transaction.create({
      data: {
        userId: u1.id, accountId: checking.id, categoryId: food.id, amount: 90_000, type: "expense", rawInput: "کافه ۹۰", enrichmentStatus: "pending",
        suggestedCategoryName: "کافه", suggestedCategoryParentName: "خوراک", suggestedCategoryReason: "تکرار", suggestedCategoryIcon: "☕",
      },
    });
    // Transfer pair: one expense + one income sharing transferGroupId.
    await prisma.transaction.create({
      data: { userId: u1.id, accountId: checking.id, categoryId: trOut.id, amount: 1_000_000, type: "expense", rawInput: "انتقال به پس‌انداز", transferGroupId: "tg-synthetic-1" },
    });
    await prisma.transaction.create({
      data: { userId: u1.id, accountId: savings.id, categoryId: trIn.id, amount: 1_000_000, type: "income", rawInput: "انتقال به پس‌انداز", transferGroupId: "tg-synthetic-1" },
    });
    await prisma.transaction.create({ data: { userId: u2.id, accountId: cash.id, categoryId: transport.id, amount: 45_000, type: "expense", rawInput: "اسنپ" } });
    await prisma.transaction.create({ data: { userId: gone.id, accountId: goneAcct.id, categoryId: goneCat.id, amount: 1, type: "expense", rawInput: "x" } });
    // Two more rows, then deleted: live's sqlite_sequence ends up above max(id).
    const d1 = await prisma.transaction.create({ data: { userId: u1.id, accountId: checking.id, categoryId: food.id, amount: 1, type: "expense", rawInput: "del" } });
    const d2 = await prisma.transaction.create({ data: { userId: u1.id, accountId: checking.id, categoryId: food.id, amount: 2, type: "expense", rawInput: "del" } });
    await prisma.transaction.deleteMany({ where: { id: { in: [d1.id, d2.id] } } });

    await prisma.merchantMapping.create({ data: { userId: u1.id, merchantKey: "snapp", categoryId: restaurant.id } });
    const conv = await prisma.conversation.create({ data: { userId: u1.id, title: "بودجه ماه" } });
    await prisma.conversation.create({ data: { userId: u1.id } });
    await prisma.chatMessage.create({ data: { userId: u1.id, conversationId: conv.id, role: "user", content: "این ماه چقدر خرج کردم؟" } });
    await prisma.chatMessage.create({ data: { userId: u1.id, conversationId: conv.id, role: "assistant", content: "۱٬۳۴۰٬۰۰۰ تومان" } });
    await prisma.spendingSummaryCache.create({ data: { userId: u1.id, monthKey: "1405-05", payload: JSON.stringify({ total: 1340000, nested: { a: [1, 2] } }) } });
    await prisma.userFact.create({ data: { userId: u1.id, key: "has_car", value: "false", source: "user_stated" } });
    await prisma.userFact.create({ data: { userId: u1.id, key: "income_regularity", value: "regular", source: "inferred", confidence: 0.85, note: "3 salaries in 90 days" } });
    await prisma.errorLog.create({ data: { route: "transactions/parse", message: "boom", stack: "Error: boom\n    at x (y.ts:1:1)" } });
    await prisma.errorLog.create({ data: { route: "chat", message: "timeout", userId: u1.id } });
    await prisma.asset.create({ data: { userId: u1.id, type: "gold", quantity: 12.5, purchasePricePerUnit: BigInt("7500000") } });
    // > Int32 (the reason these columns are BigInt), still < 2^53.
    await prisma.asset.create({ data: { userId: u1.id, type: "bitcoin", quantity: 0.015, purchasePricePerUnit: BigInt("9500000000000") } });
    await prisma.asset.create({
      data: { userId: u1.id, type: "custom", name: "خودرو", quantity: 1, purchasePricePerUnit: BigInt("2500000000"), currentPricePerUnit: BigInt("3100000000"), note: "پراید" },
    });
    await prisma.livePriceCache.create({
      data: { id: 1, goldGramPricePerUnit: BigInt("7600000"), usdPricePerUnit: BigInt("98000"), bitcoinPricePerUnit: BigInt("9700000000000"), fetchedAt: new Date("2026-09-20T09:00:00Z") },
    });
    await prisma.goal.create({
      data: { userId: u1.id, name: "مک‌بوک", category: "device", targetAmount: 60_000_000, initialAmount: 10_000_000, deadline: new Date("2027-03-01T00:00:00Z"), savingsAccountId: savings.id },
    });
    await prisma.goal.create({ data: { userId: u1.id, name: "سفر", category: "travel", targetAmount: 20_000_000, deadline: new Date("2026-12-01T00:00:00Z"), status: "achieved" } });
    await prisma.savingsStrategy.create({ data: { userId: u1.id, formulaType: "fifty_thirty_twenty", targetPercent: 20 } });
    await prisma.savingsStrategy.create({ data: { userId: u1.id, formulaType: "pay_yourself_first", targetAmount: 2_000_000, status: "paused" } });

    // User (and FinanceAccount/Category via cascade) also end up with
    // sqlite_sequence > max(id). Transactions first: Transaction.accountId
    // is RESTRICT, so the cascade can't go through the account.
    await prisma.transaction.deleteMany({ where: { userId: gone.id } });
    await prisma.user.delete({ where: { id: gone.id } });
    console.log(`  populated: users ${admin.id},${u1.id},${u2.id} (user ${gone.id} created then deleted)`);
  } finally {
    await prisma.$disconnect();
  }
}

async function sql(dbPath: string, statements: string[]) {
  const client = createClient({ url: fileUrl(dbPath) });
  try {
    for (const s of statements) await client.execute(s);
  } finally {
    client.close();
  }
}

async function scalar(dbPath: string, query: string): Promise<unknown> {
  const client = createClient({ url: fileUrl(dbPath) });
  try {
    const res = await client.execute(query);
    return res.rows[0]?.[0] ?? null;
  } finally {
    client.close();
  }
}

function findOne(dir: string, pattern: RegExp): string {
  const matches = readdirSync(dir).filter((f) => pattern.test(f));
  if (matches.length !== 1) throw new Error(`expected exactly one ${pattern} in ${dir}, found ${matches.length}`);
  return join(dir, matches[0]);
}

async function main() {
  const workDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "jib-sqlite-copy-rehearsal-")));
  if (process.argv[2]) {
    if (existsSync(workDir)) throw new Error(`workDir must not exist yet: ${workDir}`);
    mkdirSync(workDir, { recursive: true });
  }
  const emptyCwd = join(workDir, "cwd-no-dotenv");
  const backupDir = join(workDir, "backup");
  mkdirSync(emptyCwd);
  mkdirSync(backupDir);
  console.log(`Rehearsal work dir: ${workDir}`);

  // 1. Synthetic live-like DB.
  const liveLike = join(workDir, "live-like.db");
  console.log(`\n=== build live-like DB (${liveLike})`);
  buildMigrateDeployDb(liveLike);
  await populateSynthetic(liveLike);
  await sql(liveLike, [
    `DROP INDEX "Transaction_userId_accountId_type_amount_idx"`,
    `DELETE FROM "_prisma_migrations" WHERE migration_name IN (${LIVE_UNRECORDED_MIGRATIONS.map((m) => `'${m}'`).join(", ")})`,
  ]);
  const liveEnv = { TURSO_DATABASE_URL: fileUrl(liveLike), TURSO_AUTH_TOKEN: "dummy-token-not-used" };

  // 2. Existing backup script + new snapshot script, against the file.
  expectRun("backup-live-db.ts (EXISTING, unmodified) against live-like file", emptyCwd, [script("backup-live-db.ts"), backupDir], { exit: 0, contains: [`Connecting to: file:`, "Backup written"] }, liveEnv);
  const backupFile = findOne(backupDir, /^jib-live-backup-.*\d{3}Z\.json$/);
  const manifestFile = findOne(backupDir, /^jib-live-backup-.*\.manifest\.json$/);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  check("backup manifest sourceUrl is the live-like file", manifest.sourceUrl === liveEnv.TURSO_DATABASE_URL, String(manifest.sourceUrl));

  expectRun("snapshot-live-schema.ts against live-like file", emptyCwd, [script("snapshot-live-schema.ts"), backupDir], { exit: 0, contains: ["Resolved TURSO_DATABASE_URL: file:", "Snapshot written"] }, liveEnv);
  const snapshotFile = findOne(backupDir, /^jib-live-schema-.*\.json$/);
  expectRun(
    "snapshot-live-schema.ts refuses a non-file URL without --allow-remote (local http URL, never contacted)",
    emptyCwd,
    [script("snapshot-live-schema.ts"), backupDir],
    { exit: 1, contains: [`Resolved TURSO_DATABASE_URL: ${REFUSAL_PROBE_URL}`, "Refusing: this is not a local file: URL"] },
    { TURSO_DATABASE_URL: REFUSAL_PROBE_URL, TURSO_AUTH_TOKEN: "dummy" }
  );

  // Pristine migrate-deploy file, copied for every load below.
  const pristine = join(workDir, "pristine-migrate-deploy.db");
  buildMigrateDeployDb(pristine);
  let n = 0;
  const freshTarget = () => {
    const p = join(workDir, `target-${++n}.db`);
    copyFileSync(pristine, p);
    return p;
  };
  const load = (backup: string, target: string, extra: string[] = []) => [script("load-backup-into-sqlite.ts"), backup, manifestFile, target, ...extra];
  const verify = (target: string, extra: string[] = []) => [script("verify-sqlite-copy.ts"), target, manifestFile, ...extra];

  // 3. Happy path.
  const target = freshTarget();
  expectRun("loader DRY RUN (default)", emptyCwd, load(backupFile, target, ["--snapshot", snapshotFile]), { exit: 0, contains: ["Preflight OK", "ROLLED BACK"] });
  check("dry run left the target untouched", Number(await scalar(target, `SELECT count(*) FROM "User"`)) === 0, `User rows: ${await scalar(target, `SELECT count(*) FROM "User"`)}`);
  expectRun("loader --execute --snapshot", emptyCwd, load(backupFile, target, ["--snapshot", snapshotFile, "--execute"]), { exit: 0, contains: ["COMMITTED", "0 violations"] });
  expectRun("verifier --snapshot --backup (expect all PASS)", emptyCwd, verify(target, ["--snapshot", snapshotFile, "--backup", backupFile]), {
    exit: 0,
    contains: ["VERIFICATION PASSED", "0 fail", "index Transaction_userId_accountId_type_amount_idx"],
  });
  for (const table of ["Transaction", "User"]) {
    const liveSeq = Number(await scalar(liveLike, `SELECT seq FROM sqlite_sequence WHERE name='${table}'`));
    const liveMax = Number(await scalar(liveLike, `SELECT max(id) FROM "${table}"`));
    const copySeq = Number(await scalar(target, `SELECT seq FROM sqlite_sequence WHERE name='${table}'`));
    check(`${table} sqlite_sequence carried over from snapshot`, copySeq === liveSeq && liveSeq > liveMax, `live seq ${liveSeq} (max id ${liveMax}), copy seq ${copySeq}`);
  }
  const noSnap = freshTarget();
  expectRun("loader --execute WITHOUT --snapshot (seq only raised to max(id))", emptyCwd, load(backupFile, noSnap, ["--execute"]), { exit: 0, contains: ["COMMITTED"] });
  const noSnapSeq = Number(await scalar(noSnap, `SELECT seq FROM sqlite_sequence WHERE name='Transaction'`));
  const liveTxMax = Number(await scalar(liveLike, `SELECT max(id) FROM "Transaction"`));
  check("without snapshot, Transaction seq == max(id) (deleted ids reusable - why --snapshot matters)", noSnapSeq === liveTxMax, `seq ${noSnapSeq}, max id ${liveTxMax}`);

  // 4. Negative cases.
  const good = JSON.parse(readFileSync(backupFile, "utf8")) as Backup;
  const variant = (name: string, mutate: (b: Backup) => void) => {
    const b = JSON.parse(JSON.stringify(good)) as Backup;
    mutate(b);
    const p = join(workDir, `backup-${name}.json`);
    writeFileSync(p, JSON.stringify(b, null, 2));
    return p;
  };

  expectRun("NEG extra column in JSON", emptyCwd, load(variant("extra-col", (b) => b.Transaction.forEach((r) => (r.legacyNote = "x"))), freshTarget()), {
    exit: 1,
    contains: ["REFUSING TO LOAD", "Transaction.legacyNote: column is in the backup but NOT in the target"],
  });
  expectRun("NEG JSON missing a NOT NULL column", emptyCwd, load(variant("missing-notnull", (b) => b.Transaction.forEach((r) => delete r.rawInput)), freshTarget()), {
    exit: 1,
    contains: ["REFUSING TO LOAD", "Transaction.rawInput: NOT NULL column in the target is absent from the backup"],
  });
  const missingNullable = variant("missing-nullable", (b) => b.Transaction.forEach((r) => delete r.source));
  expectRun("NEG JSON missing a nullable column", emptyCwd, load(missingNullable, freshTarget()), {
    exit: 1,
    contains: ["Transaction.source: nullable column in the target is absent from the backup"],
  });
  expectRun("   ...accepted explicitly with --accept-missing", emptyCwd, load(missingNullable, freshTarget(), ["--accept-missing", "Transaction.source"]), {
    exit: 0,
    contains: ["accepted via --accept-missing", "ROLLED BACK"],
  });
  expectRun("NEG BLOB-shaped {} value", emptyCwd, load(variant("blob", (b) => (b.ErrorLog[0].stack = {} as unknown as string)), freshTarget()), {
    exit: 1,
    contains: ["ErrorLog.stack (row #0): non-scalar value {}"],
  });
  expectRun("NEG non-empty target (the already-loaded copy)", emptyCwd, load(backupFile, target, ["--execute"]), {
    exit: 1,
    contains: ["target is not empty: User already has"],
  });

  const rawApplied = join(workDir, "raw-applied.db");
  {
    const client = createClient({ url: fileUrl(rawApplied) });
    try {
      for (const folder of readdirSync(MIGRATIONS_DIR).filter((f) => f !== "migration_lock.toml").sort()) {
        await client.executeMultiple(readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8"));
      }
    } finally {
      client.close();
    }
  }
  expectRun("NEG target not built by migrate deploy (migrations applied by raw SQL, no _prisma_migrations)", emptyCwd, load(backupFile, rawApplied), {
    exit: 1,
    contains: ["_prisma_migrations table does not exist"],
  });
  const partial = freshTarget();
  await sql(partial, [`DELETE FROM "_prisma_migrations" WHERE migration_name = '20260917211853_add_savings_strategy'`]);
  expectRun("NEG target's _prisma_migrations short one migration", emptyCwd, load(backupFile, partial), {
    exit: 1,
    contains: ["migration not applied: 20260917211853_add_savings_strategy"],
  });

  const fkTarget = freshTarget();
  expectRun("NEG FK violation in the data (loader: foreign_key_check before commit)", emptyCwd, load(variant("fk", (b) => (b.Transaction[0].accountId = 999999)), fkTarget, ["--execute"]), {
    exit: 1,
    contains: ["LOAD FAILED: PRAGMA foreign_key_check found 1 violation(s) - rolled back", "Transaction rowid="],
  });
  check("FK-violating load left the target untouched", Number(await scalar(fkTarget, `SELECT count(*) FROM "User"`)) === 0, "User rows 0");

  const corrupted = join(workDir, "corrupted-fk.db");
  copyFileSync(target, corrupted);
  await sql(corrupted, ["PRAGMA foreign_keys = OFF", `UPDATE "Transaction" SET "accountId" = 999999 WHERE id = (SELECT min(id) FROM "Transaction")`]);
  expectRun("NEG FK violation in a copy (verifier)", emptyCwd, verify(corrupted), {
    exit: 1,
    contains: ["[FAIL] PRAGMA foreign_key_check (1 violation(s))", "VERIFICATION FAILED"],
  });
  const noIndex = join(workDir, "no-groupby-index.db");
  copyFileSync(target, noIndex);
  await sql(noIndex, [`DROP INDEX "Transaction_userId_accountId_type_amount_idx"`]);
  expectRun("NEG copy missing the groupby index (verifier)", emptyCwd, verify(noIndex), {
    exit: 1,
    contains: ["missing from target: index Transaction_userId_accountId_type_amount_idx", "missing: Transaction_userId_accountId_type_amount_idx"],
  });
  const fewer = join(workDir, "fewer-rows.db");
  copyFileSync(target, fewer);
  await sql(fewer, [`DELETE FROM "ChatMessage" WHERE id = (SELECT max(id) FROM "ChatMessage")`]);
  expectRun("NEG copy with a missing row (verifier: counts + content)", emptyCwd, verify(fewer, ["--backup", backupFile]), {
    exit: 1,
    contains: ["ChatMessage: target 1, manifest 2", "missing from target"],
  });
  expectRun("NEG target given as a URL", emptyCwd, load(backupFile, `file:${freshTarget()}`), {
    exit: 1,
    contains: ["expected a plain local file path, not a URL"],
  });

  console.log("\n=================== REHEARSAL SUMMARY ===================");
  for (const o of outcomes) console.log(`${o.ok ? "OK        " : "UNEXPECTED"}  ${o.label}${o.ok ? "" : `  (${o.detail})`}`);
  const bad = outcomes.filter((o) => !o.ok).length;
  console.log(`\n${outcomes.length - bad}/${outcomes.length} as expected. Work dir kept: ${workDir}`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
