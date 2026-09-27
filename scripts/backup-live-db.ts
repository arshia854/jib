/**
 * Pre-write backup of the live Turso DB via @libsql/client directly
 * (same connection path lib/prisma.ts uses at runtime) - NOT via Turso
 * CLI/`turso db shell .dump`, which needs a CLI login this environment
 * doesn't have.
 *
 * READ-ONLY: issues nothing but SELECTs. For every user table (excludes
 * sqlite_/libsql_/_prisma_ internal tables), dumps every row to a single
 * JSON file: { <tableName>: [ {..row}, ... ], ... }, plus a manifest with
 * per-table row counts so the backup's completeness can be checked at a
 * glance without re-opening the DB.
 *
 * Consistency: after the initial table-list query (used only to print the
 * table count/names before the real read), every table is read in ONE
 * client.batch(..., "read") call alongside a repeat of the table-list query -
 * so every row comes from the same DB snapshot, and a schema change
 * mid-backup (the table list differing between the two reads) is caught
 * and fails loudly instead of producing a torn dump.
 *
 * Value safety: scripts/load-backup-into-sqlite.ts loads this JSON verbatim,
 * so a value JSON.stringify would corrupt or drop silently - a BLOB
 * (ArrayBuffer/Uint8Array; JSON.stringify turns it into `{}`), a non-finite
 * number (NaN/Infinity/-Infinity; JSON.stringify turns it into `null`), or a
 * bigint (JSON.stringify throws on it directly) - makes this script throw
 * immediately, naming the exact table.column, rather than writing a lossy
 * backup that would look complete. This schema has no BLOB/Bytes columns
 * today and the libsql client's default intMode never returns a bigint, so
 * neither is expected to actually fire - the check exists for if that
 * changes.
 *
 * SAFETY: prints the resolved URL first, and refuses anything but a local
 * file: URL unless --allow-remote is passed. Per AGENTS.md, running this
 * against the live Turso DB (even though it's SELECT-only) needs explicit
 * approval first - --allow-remote exists so that can't happen by accident.
 *
 * Usage:
 *   npx tsx scripts/backup-live-db.ts [outDir] [--allow-remote]
 *   (outDir defaults to ./backups, gitignored - see .gitignore)
 */
import "dotenv/config";
import { createClient, type Client, type ResultSet } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const TABLE_LIST_SQL = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' AND name NOT LIKE 'libsql_%' ORDER BY name`;

/**
 * Throws on any value JSON.stringify would silently corrupt or drop -
 * naming the exact table.column so the failure is actionable. Returns the
 * value unchanged otherwise (mirrors the original loop's straight
 * pass-through of row[col]).
 */
export function assertJsonSafe(table: string, col: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    throw new Error(`${table}.${col}: value is a bigint (${value}) - JSON.stringify would throw on it.`);
  }
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    throw new Error(`${table}.${col}: value is a BLOB - JSON.stringify would silently turn it into {}.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${table}.${col}: value is ${value} - JSON.stringify would silently turn it into null.`);
  }
  return value;
}

/**
 * Reads every table named in `tableNames` in a single read-mode batch (one
 * read transaction), alongside a repeat of TABLE_LIST_SQL used only to
 * detect a schema change mid-backup - if the table list from inside the
 * batch differs from `tableNames` (what the caller read just before calling
 * this), throws rather than returning a dump built from two different DB
 * states. Returns one ResultSet per name in `tableNames`, same order.
 *
 * Takes only `batch` (not a full Client) so a unit test can stub it without
 * a real connection.
 */
export async function readAllTablesConsistently(
  client: Pick<Client, "batch">,
  tableNames: string[]
): Promise<ResultSet[]> {
  const [tableListCheck, ...tableResults] = await client.batch(
    [TABLE_LIST_SQL, ...tableNames.map((table) => `SELECT * FROM "${table}"`)],
    "read"
  );
  const tableNamesNow = tableListCheck.rows.map((r) => String(r.name));
  if (tableNamesNow.join("\u0000") !== tableNames.join("\u0000")) {
    throw new Error(
      `Table list changed mid-backup (schema changed while this was running) - was [${tableNames.join(", ")}], ` +
        `is now [${tableNamesNow.join(", ")}]. Re-run.`
    );
  }
  return tableResults;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "allow-remote": { type: "boolean", default: false } },
  });

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set.");

  console.log(`Connecting to: ${url}`);

  const isLocalFile = url.startsWith("file:");
  if (!isLocalFile && !values["allow-remote"]) {
    console.error(
      "Refusing: this is not a local file: URL. Reading the live DB (even SELECT-only) needs explicit approval " +
        "per AGENTS.md - once approved, re-run with --allow-remote."
    );
    process.exit(1);
  }

  const outDir = positionals[0] || join(process.cwd(), "backups");
  mkdirSync(outDir, { recursive: true });

  const client = createClient({ url, authToken });

  const tablesRes = await client.execute(TABLE_LIST_SQL);
  const tableNames = tablesRes.rows.map((r) => String(r.name));
  console.log(`Found ${tableNames.length} tables: ${tableNames.join(", ")}\n`);

  const tableResults = await readAllTablesConsistently(client, tableNames);

  const dump: Record<string, unknown[]> = {};
  const manifest: Record<string, number> = {};

  tableNames.forEach((table, i) => {
    const res = tableResults[i];
    dump[table] = res.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      for (const col of res.columns) obj[col] = assertJsonSafe(table, col, row[col]);
      return obj;
    });
    manifest[table] = res.rows.length;
    console.log(` - ${table}: ${res.rows.length} rows`);
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataFile = join(outDir, `jib-live-backup-${timestamp}.json`);
  const manifestFile = join(outDir, `jib-live-backup-${timestamp}.manifest.json`);

  writeFileSync(dataFile, JSON.stringify(dump, null, 2));
  writeFileSync(
    manifestFile,
    JSON.stringify({ takenAt: new Date().toISOString(), sourceUrl: url, tableRowCounts: manifest }, null, 2)
  );

  console.log(`\nBackup written:`);
  console.log(` - ${dataFile}`);
  console.log(` - ${manifestFile}`);
}

// Only run when executed directly (`npx tsx scripts/backup-live-db.ts` /
// `node ...`), not when imported - so scripts/backup-live-db.test.ts can
// import assertJsonSafe/readAllTablesConsistently above without main()
// running as an import side effect (it would immediately throw on missing
// TURSO_DATABASE_URL/exit(1), same as the file's original, unguarded
// `main().catch(...)` would have done under import).
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
