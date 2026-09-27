/**
 * Shared logic for the Turso -> local SQLite copy tooling (F3-prep):
 *   scripts/load-backup-into-sqlite.ts  - loads a backup-live-db.ts JSON into a fresh `migrate deploy` file
 *   scripts/verify-sqlite-copy.ts       - checks the result
 *   scripts/rehearse-sqlite-copy.ts     - end-to-end rehearsal on synthetic data
 * (scripts/snapshot-live-schema.ts is the one live-capable script and
 * deliberately does NOT import this module - it stays standalone and
 * minimal so what it runs against production is auditable at a glance.)
 *
 * Every database this module opens is a LOCAL FILE: resolveLocalDbPath()
 * rejects anything URL-shaped (libsql://, https://, file:, ...) before a
 * client is ever created, and buildMigrateDeployDb() runs the Prisma CLI
 * with a minimal environment from a directory with no .env, so the live
 * TURSO_DATABASE_URL in the repo's .env is never loaded by any of it.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type Client, type InValue } from "@libsql/client";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");

// Tables a migration.sql itself inserts rows into (20260802175335_... seeds
// an early DefaultCategory snapshot), so a fresh `migrate deploy` file is
// expected to be non-empty there. The loader replaces their content
// wholesale with the backup's (delete, then insert) - every other user table
// must be empty in the target.
export const MIGRATION_SEEDED_TABLES = ["DefaultCategory"];

// Phase 17's covering index for getTotalBalance() - never applied to live
// Turso (see scripts/backfill-migration-history.ts), so its presence in the
// target is the clearest sign the target's schema came from the migrations,
// not from a copy of live's DDL.
export const REQUIRED_INDEXES = ["Transaction_userId_accountId_type_amount_idx"];

export type Row = Record<string, unknown>;
export type Backup = Record<string, Row[]>;
export type Manifest = { takenAt?: string; sourceUrl?: string; tableRowCounts: Record<string, number> };
export type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
export type MigrationRow = {
  migration_name: string;
  checksum: string;
  finished_at: unknown;
  rolled_back_at: unknown;
  applied_steps_count: unknown;
};
export type Snapshot = {
  takenAt?: string;
  sourceUrl?: string;
  sqliteMaster: SchemaObject[];
  sqliteSequence: { name: string; seq: number }[] | null;
  prismaMigrations: MigrationRow[] | null;
  tableRowCounts: Record<string, number>;
};
export type TargetColumn = { name: string; type: string; notNull: boolean; defaultValue: unknown; pk: number };

/** Same exclusion rule as scripts/backup-live-db.ts's table list. */
export function isInternalTable(name: string): boolean {
  return /^(sqlite_|_prisma_|libsql_)/.test(name);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Refuses anything that isn't a plain local filesystem path - a URL of any
 * scheme (libsql://, https://, file:, ...) is rejected before a client is
 * ever created. Returns the absolute path.
 */
export function resolveLocalDbPath(input: string, opts: { mustExist: boolean }): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  if (scheme) {
    throw new Error(
      `Refusing "${input}": expected a plain local file path, not a URL (scheme "${scheme[1]}:"). ` +
        `These tools only ever open local SQLite files.`
    );
  }
  if (/[?#]/.test(input)) throw new Error(`Refusing "${input}": '?' and '#' are not allowed in the path.`);
  const abs = resolve(input);
  if (opts.mustExist && !existsSync(abs)) throw new Error(`No such file: ${abs}`);
  return abs;
}

export function openLocalDb(absPath: string): Client {
  return createClient({ url: `file:${absPath}` });
}

export function readJsonFile<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${(e as Error).message}`);
  }
}

/** Every prisma/migrations/<folder>, oldest first, with the SHA-256 of its migration.sql - same checksum scripts/backfill-migration-history.ts writes and `migrate deploy` itself records. */
export function listMigrationFolders(dir = MIGRATIONS_DIR): { name: string; checksum: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      checksum: createHash("sha256").update(readFileSync(join(dir, name, "migration.sql"))).digest("hex"),
    }));
}

/**
 * A child-process env built from scratch - PATH/HOME plus exactly what's
 * passed - so nothing (live TURSO_* vars, DOTENV_CONFIG_* overrides) leaks in
 * from the parent. Cast: Next's type augmentation makes NODE_ENV a required
 * ProcessEnv key, and leaving it out is the point.
 */
export function minimalChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra } as unknown as NodeJS.ProcessEnv;
}

/**
 * Runs `prisma migrate deploy` against a brand-new local file. Child env is
 * built from scratch (PATH/HOME + an explicit file: URL, no auth token) and
 * cwd is a temp dir with no .env, with the repo's prisma.config.ts passed via
 * --config - so its `import "dotenv/config"` finds nothing to load, and the
 * live TURSO_DATABASE_URL can't reach the CLI by any route.
 */
export function buildMigrateDeployDb(absPath: string): string {
  if (existsSync(absPath)) throw new Error(`Refusing to run migrate deploy: ${absPath} already exists.`);
  const url = `file:${absPath}`;
  if (!url.startsWith("file:/")) throw new Error(`Refusing to run migrate deploy against non-file URL: ${url}`);
  const cwd = mkdtempSync(join(tmpdir(), "jib-migrate-deploy-cwd-"));
  try {
    const result = spawnSync(
      join(REPO_ROOT, "node_modules", ".bin", "prisma"),
      ["migrate", "deploy", "--config", join(REPO_ROOT, "prisma.config.ts")],
      {
        cwd,
        env: minimalChildEnv({ TURSO_DATABASE_URL: url }),
        encoding: "utf8",
      }
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0) throw new Error(`prisma migrate deploy failed for ${url}:\n${output}`);
    return output;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reading a local DB
// ---------------------------------------------------------------------------

export async function readSchemaObjects(client: Client): Promise<SchemaObject[]> {
  const res = await client.execute(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`);
  return res.rows.map((r) => ({
    type: String(r.type),
    name: String(r.name),
    tbl_name: String(r.tbl_name),
    sql: r.sql === null ? null : String(r.sql),
  }));
}

export async function readColumns(client: Client, table: string): Promise<TargetColumn[]> {
  const res = await client.execute(`PRAGMA table_info(${quoteIdent(table)})`);
  return res.rows.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    notNull: Number(r.notnull) === 1,
    defaultValue: r.dflt_value,
    pk: Number(r.pk),
  }));
}

export async function readMigrationRows(client: Client, objects: SchemaObject[]): Promise<MigrationRow[] | null> {
  if (!objects.some((o) => o.type === "table" && o.name === "_prisma_migrations")) return null;
  const res = await client.execute(
    `SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`
  );
  return res.rows.map((r) => ({
    migration_name: String(r.migration_name),
    checksum: String(r.checksum),
    finished_at: r.finished_at,
    rolled_back_at: r.rolled_back_at,
    applied_steps_count: r.applied_steps_count,
  }));
}

export async function readSequence(client: Client, objects: SchemaObject[]): Promise<Map<string, number>> {
  if (!objects.some((o) => o.type === "table" && o.name === "sqlite_sequence")) return new Map();
  const res = await client.execute(`SELECT name, seq FROM sqlite_sequence`);
  return new Map(res.rows.map((r) => [String(r.name), Number(r.seq)]));
}

export async function countRows(client: Client, tables: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const res = await client.execute(`SELECT count(*) AS n FROM ${quoteIdent(table)}`);
    counts.set(table, Number(res.rows[0].n));
  }
  return counts;
}

export function userTables(objects: SchemaObject[]): string[] {
  return objects.filter((o) => o.type === "table" && !isInternalTable(o.name)).map((o) => o.name);
}

/** Tables declared AUTOINCREMENT - the only ones SQLite keeps a sqlite_sequence row for. */
export function autoincrementTables(objects: SchemaObject[]): string[] {
  return objects
    .filter((o) => o.type === "table" && o.sql !== null && /\bAUTOINCREMENT\b/i.test(o.sql))
    .map((o) => o.name);
}

// ---------------------------------------------------------------------------
// Pure checks (unit-tested in sqlite-copy.test.ts)
// ---------------------------------------------------------------------------

/** Problems that mean the target was NOT produced by `prisma migrate deploy` of exactly this repo's migrations. Empty array = OK. */
export function checkMigrateDeployBookkeeping(
  rows: MigrationRow[] | null,
  folders: { name: string; checksum: string }[]
): string[] {
  if (rows === null) {
    return [`_prisma_migrations table does not exist - target was not built by \`prisma migrate deploy\`.`];
  }
  const problems: string[] = [];
  if (rows.length !== folders.length) {
    problems.push(
      `_prisma_migrations has ${rows.length} row(s) but prisma/migrations has ${folders.length} folder(s).`
    );
  }
  const byName = new Map<string, MigrationRow[]>();
  for (const row of rows) byName.set(row.migration_name, [...(byName.get(row.migration_name) ?? []), row]);
  const folderNames = new Set(folders.map((f) => f.name));
  for (const folder of folders) {
    const matches = byName.get(folder.name) ?? [];
    if (matches.length === 0) {
      problems.push(`migration not applied: ${folder.name}`);
      continue;
    }
    if (matches.length > 1) problems.push(`migration recorded ${matches.length} times: ${folder.name}`);
    for (const row of matches) {
      if (row.finished_at === null) problems.push(`migration never finished: ${folder.name}`);
      if (row.rolled_back_at !== null) problems.push(`migration rolled back: ${folder.name}`);
      if (row.checksum !== folder.checksum) {
        problems.push(`checksum mismatch for ${folder.name} (db ${row.checksum}, file ${folder.checksum})`);
      }
    }
  }
  for (const name of byName.keys()) {
    if (!folderNames.has(name)) problems.push(`_prisma_migrations has a row with no matching folder: ${name}`);
  }
  return problems;
}

export type ColumnDiff = {
  table: string;
  /** null when the backup has 0 rows for this table - no column info available from the JSON. */
  jsonColumns: string[] | null;
  extraInJson: string[];
  missingNotNull: string[];
  missingNullable: string[];
  inconsistentRows: { index: number; keys: string[] }[];
};

/** Compares the backup's column set for one table against the target's actual columns. */
export function diffBackupColumns(table: string, rows: Row[], target: TargetColumn[]): ColumnDiff {
  const diff: ColumnDiff = {
    table,
    jsonColumns: null,
    extraInJson: [],
    missingNotNull: [],
    missingNullable: [],
    inconsistentRows: [],
  };
  if (rows.length === 0) return diff;

  const first = Object.keys(rows[0]);
  const firstKey = [...first].sort().join("\u0000");
  rows.forEach((row, index) => {
    const keys = Object.keys(row);
    if ([...keys].sort().join("\u0000") !== firstKey && diff.inconsistentRows.length < 5) {
      diff.inconsistentRows.push({ index, keys });
    }
  });

  diff.jsonColumns = first;
  const targetNames = new Set(target.map((c) => c.name));
  const jsonNames = new Set(first);
  diff.extraInJson = first.filter((c) => !targetNames.has(c));
  for (const col of target) {
    if (jsonNames.has(col.name)) continue;
    // An INTEGER PRIMARY KEY is NOT NULL in practice (it's the rowid) even
    // though PRAGMA table_info reports notnull=0 for it - treat it as such,
    // so a backup missing `id` fails instead of getting fresh ids silently.
    if (col.notNull || col.pk > 0) diff.missingNotNull.push(col.name);
    else diff.missingNullable.push(col.name);
  }
  return diff;
}

/**
 * Values the loader can bind faithfully are exactly what JSON.parse yields
 * for a libsql scalar: string, number or null. Anything else is a sign of a
 * lossy round-trip - notably a BLOB, which @libsql/client returns as an
 * ArrayBuffer and JSON.stringify writes as `{}`.
 */
export function findNonScalarValues(rows: Row[], limit = 5): { rowIndex: number; column: string; value: unknown }[] {
  const found: { rowIndex: number; column: string; value: unknown }[] = [];
  rows.forEach((row, rowIndex) => {
    for (const [column, value] of Object.entries(row)) {
      const ok = value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
      if (!ok && found.length < limit) found.push({ rowIndex, column, value });
    }
  });
  return found;
}

export function checkManifestMatchesBackup(backup: Backup, manifest: Manifest): string[] {
  const problems: string[] = [];
  const counts = manifest.tableRowCounts ?? {};
  for (const [table, rows] of Object.entries(backup)) {
    if (!(table in counts)) problems.push(`backup has table ${table} but the manifest doesn't list it.`);
    else if (counts[table] !== rows.length) {
      problems.push(`${table}: backup has ${rows.length} row(s), manifest says ${counts[table]}.`);
    }
  }
  for (const table of Object.keys(counts)) {
    if (!(table in backup)) problems.push(`manifest lists table ${table} but the backup has no such key.`);
  }
  return problems;
}

export type LoadOptions = {
  /** "Table.column" entries the operator has explicitly accepted being absent from the backup (nullable columns only - they'll be NULL). */
  acceptMissingColumns: string[];
  /** Target tables the operator has explicitly accepted being absent from the backup (they stay empty). */
  allowMissingTables: string[];
};

export type TargetInfo = {
  objects: SchemaObject[];
  columns: Map<string, TargetColumn[]>;
  rowCounts: Map<string, number>;
  migrations: MigrationRow[] | null;
};

export type Preflight = { errors: string[]; warnings: string[]; notes: string[] };

/**
 * Every check the loader runs before writing anything. Pure: all DB reads
 * happen beforehand (see inspectTarget), so this is unit-testable.
 */
export function preflightLoad(args: {
  backup: Backup;
  manifest: Manifest;
  snapshot: Snapshot | null;
  target: TargetInfo;
  folders: { name: string; checksum: string }[];
  options: LoadOptions;
}): Preflight {
  const { backup, manifest, snapshot, target, folders, options } = args;
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  for (const p of checkManifestMatchesBackup(backup, manifest)) errors.push(`backup/manifest mismatch: ${p}`);

  for (const p of checkMigrateDeployBookkeeping(target.migrations, folders)) {
    errors.push(`target not built by \`prisma migrate deploy\` of this repo: ${p}`);
  }

  const tables = userTables(target.objects);
  const targetTableSet = new Set(tables);

  for (const table of tables) {
    const n = target.rowCounts.get(table) ?? 0;
    if (n === 0) continue;
    if (MIGRATION_SEEDED_TABLES.includes(table)) {
      notes.push(`${table}: ${n} migration-seeded row(s) in target will be deleted and replaced by the backup's.`);
    } else {
      errors.push(`target is not empty: ${table} already has ${n} row(s). Load only into a fresh \`migrate deploy\` file.`);
    }
  }

  for (const table of Object.keys(backup)) {
    if (!targetTableSet.has(table)) {
      errors.push(`backup table ${table} does not exist in the target (live has a table the migrations don't create).`);
    }
  }
  for (const table of tables) {
    if (table in backup) continue;
    if (options.allowMissingTables.includes(table)) {
      warnings.push(`target table ${table} is absent from the backup - accepted via --allow-missing-table; it will be left as-is.`);
    } else {
      errors.push(
        `target table ${table} is absent from the backup (live doesn't have it?). Re-run with --allow-missing-table ${table} to accept leaving it empty.`
      );
    }
  }

  for (const [table, rows] of Object.entries(backup)) {
    const cols = target.columns.get(table);
    if (!cols) continue;
    const diff = diffBackupColumns(table, rows, cols);
    if (diff.jsonColumns === null) {
      notes.push(`${table}: 0 rows in backup - the JSON carries no column info for it (run verify with --snapshot for a DDL-level drift check).`);
      continue;
    }
    for (const row of diff.inconsistentRows) {
      errors.push(`${table}: row #${row.index} has a different column set than row #0 (${row.keys.join(", ")}).`);
    }
    for (const col of diff.extraInJson) {
      errors.push(`${table}.${col}: column is in the backup but NOT in the target - its data would be dropped.`);
    }
    for (const col of diff.missingNotNull) {
      errors.push(`${table}.${col}: NOT NULL column in the target is absent from the backup - refusing to invent values.`);
    }
    for (const col of diff.missingNullable) {
      const key = `${table}.${col}`;
      if (options.acceptMissingColumns.includes(key)) {
        warnings.push(`${key}: absent from the backup - accepted via --accept-missing; will be NULL on every row.`);
      } else {
        errors.push(`${key}: nullable column in the target is absent from the backup. Re-run with --accept-missing ${key} to accept NULLs.`);
      }
    }
    for (const bad of findNonScalarValues(rows)) {
      errors.push(
        `${table}.${bad.column} (row #${bad.rowIndex}): non-scalar value ${JSON.stringify(bad.value)} - ` +
          `likely a BLOB that JSON.stringify turned into {}; the backup is lossy for this column.`
      );
    }
  }

  if (snapshot) {
    const autoinc = new Set(autoincrementTables(target.objects));
    for (const { name } of snapshot.sqliteSequence ?? []) {
      if (!targetTableSet.has(name)) warnings.push(`snapshot has a sqlite_sequence entry for ${name}, which isn't a target table.`);
      else if (!autoinc.has(name)) warnings.push(`snapshot has a sqlite_sequence entry for ${name}, but ${name} isn't AUTOINCREMENT in the target (DDL drift).`);
    }
    for (const [table, n] of Object.entries(manifest.tableRowCounts ?? {})) {
      const s = snapshot.tableRowCounts?.[table];
      if (s !== undefined && s !== n) {
        warnings.push(`${table}: snapshot counted ${s} row(s), backup has ${n} - the two were taken at different moments; re-take both back to back.`);
      }
    }
  }

  return { errors, warnings, notes };
}

export type SeqPlanRow = {
  table: string;
  current: number | null;
  maxId: number | null;
  snapshot: number | null;
  target: number;
};

/**
 * sqlite_sequence value each AUTOINCREMENT table should end up with: at
 * least max(id) (so the next insert never collides), at least live's own
 * seq from the snapshot (so ids of rows deleted on live are never reused),
 * and never lower than whatever the target already has.
 */
export function planSequence(
  tables: string[],
  current: Map<string, number>,
  maxIds: Map<string, number | null>,
  snapshot: Map<string, number> | null
): SeqPlanRow[] {
  return tables.map((table) => {
    const cur = current.get(table) ?? null;
    const maxId = maxIds.get(table) ?? null;
    const snap = snapshot?.get(table) ?? null;
    return { table, current: cur, maxId, snapshot: snap, target: Math.max(cur ?? 0, maxId ?? 0, snap ?? 0) };
  });
}

export function diffSchemaObjects(
  expected: SchemaObject[],
  actual: SchemaObject[],
  opts: { normalizeSql?: boolean } = {}
): { missing: SchemaObject[]; unexpected: SchemaObject[]; changed: { expected: SchemaObject; actual: SchemaObject }[] } {
  const key = (o: SchemaObject) => `${o.type}\u0000${o.name}`;
  const norm = (sql: string | null) => (sql === null ? null : opts.normalizeSql ? sql.replace(/\s+/g, " ").trim() : sql);
  const actualByKey = new Map(actual.map((o) => [key(o), o]));
  const expectedKeys = new Set(expected.map(key));
  const missing: SchemaObject[] = [];
  const changed: { expected: SchemaObject; actual: SchemaObject }[] = [];
  for (const e of expected) {
    const a = actualByKey.get(key(e));
    if (!a) missing.push(e);
    else if (a.tbl_name !== e.tbl_name || norm(a.sql) !== norm(e.sql)) changed.push({ expected: e, actual: a });
  }
  const unexpected = actual.filter((a) => !expectedKeys.has(key(a)));
  return { missing, unexpected, changed };
}

// ---------------------------------------------------------------------------
// Structural (PRAGMA-level) description, for live-vs-target drift reports
// ---------------------------------------------------------------------------

export type Structure = {
  tables: Map<string, { columns: TargetColumn[]; foreignKeys: string[] }>;
  indexes: Map<string, { table: string; unique: boolean; columns: string[] }>;
};

export async function describeStructure(client: Client, objects: SchemaObject[]): Promise<Structure> {
  const structure: Structure = { tables: new Map(), indexes: new Map() };
  for (const table of objects.filter((o) => o.type === "table" && !o.name.startsWith("sqlite_"))) {
    const fk = await client.execute(`PRAGMA foreign_key_list(${quoteIdent(table.name)})`);
    structure.tables.set(table.name, {
      columns: await readColumns(client, table.name),
      foreignKeys: fk.rows
        .map((r) => `${r.from} -> ${r.table}(${r.to}) ON DELETE ${r.on_delete} ON UPDATE ${r.on_update}`)
        .sort(),
    });
    const idx = await client.execute(`PRAGMA index_list(${quoteIdent(table.name)})`);
    for (const r of idx.rows) {
      const info = await client.execute(`PRAGMA index_info(${quoteIdent(String(r.name))})`);
      structure.indexes.set(String(r.name), {
        table: table.name,
        unique: Number(r.unique) === 1,
        columns: info.rows.map((c) => String(c.name)),
      });
    }
  }
  return structure;
}

/**
 * Rebuilds a snapshot's DDL in an in-memory SQLite DB so it can be described
 * with the same PRAGMAs as the target - the snapshot itself is SELECT-only
 * (no PRAGMAs run against live). Statements that fail are reported, not thrown.
 */
export async function structureFromSnapshot(snapshot: Snapshot): Promise<{ structure: Structure; failures: string[] }> {
  const client = createClient({ url: ":memory:" });
  const failures: string[] = [];
  try {
    const order = ["table", "index", "view", "trigger"];
    const creatable = snapshot.sqliteMaster
      .filter((o) => o.sql !== null && !o.name.startsWith("sqlite_"))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const o of creatable) {
      try {
        await client.execute(o.sql as string);
      } catch (e) {
        failures.push(`${o.type} ${o.name}: ${(e as Error).message}`);
      }
    }
    const objects = await readSchemaObjects(client);
    return { structure: await describeStructure(client, objects), failures };
  } finally {
    client.close();
  }
}

/** Human-readable differences between live's structure (from the snapshot) and the target's. */
export function diffStructures(live: Structure, target: Structure): { liveOnly: string[]; targetOnly: string[]; different: string[] } {
  const liveOnly: string[] = [];
  const targetOnly: string[] = [];
  const different: string[] = [];
  const fmtCol = (c: TargetColumn) =>
    `${c.type}${c.notNull ? " NOT NULL" : ""}${c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ""}${c.pk ? ` PK${c.pk}` : ""}`;

  for (const [name, lt] of live.tables) {
    const tt = target.tables.get(name);
    if (!tt) {
      liveOnly.push(`table ${name}`);
      continue;
    }
    const tCols = new Map(tt.columns.map((c) => [c.name, c]));
    const lCols = new Map(lt.columns.map((c) => [c.name, c]));
    for (const [col, lc] of lCols) {
      const tc = tCols.get(col);
      if (!tc) liveOnly.push(`column ${name}.${col} (${fmtCol(lc)})`);
      else if (fmtCol(lc) !== fmtCol(tc)) different.push(`column ${name}.${col}: live ${fmtCol(lc)} | target ${fmtCol(tc)}`);
    }
    for (const [col, tc] of tCols) if (!lCols.has(col)) targetOnly.push(`column ${name}.${col} (${fmtCol(tc)})`);
    const lf = lt.foreignKeys.join("; ");
    const tf = tt.foreignKeys.join("; ");
    if (lf !== tf) different.push(`foreign keys of ${name}: live [${lf}] | target [${tf}]`);
  }
  for (const name of target.tables.keys()) if (!live.tables.has(name)) targetOnly.push(`table ${name}`);

  const fmtIdx = (i: { table: string; unique: boolean; columns: string[] }) =>
    `${i.unique ? "UNIQUE " : ""}ON ${i.table}(${i.columns.join(", ")})`;
  for (const [name, li] of live.indexes) {
    const ti = target.indexes.get(name);
    if (!ti) liveOnly.push(`index ${name} ${fmtIdx(li)}`);
    else if (fmtIdx(li) !== fmtIdx(ti)) different.push(`index ${name}: live ${fmtIdx(li)} | target ${fmtIdx(ti)}`);
  }
  for (const [name, ti] of target.indexes) if (!live.indexes.has(name)) targetOnly.push(`index ${name} ${fmtIdx(ti)}`);

  return { liveOnly, targetOnly, different };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function inspectTarget(client: Client): Promise<TargetInfo> {
  const objects = await readSchemaObjects(client);
  const tables = userTables(objects);
  const columns = new Map<string, TargetColumn[]>();
  for (const table of tables) columns.set(table, await readColumns(client, table));
  return {
    objects,
    columns,
    rowCounts: await countRows(client, tables),
    migrations: await readMigrationRows(client, objects),
  };
}

export type LoadReport = {
  deleted: { table: string; rows: number }[];
  inserted: { table: string; rows: number }[];
  sequence: SeqPlanRow[];
  committed: boolean;
};

export class LoadError extends Error {}

/**
 * Loads every backup table into the target inside ONE transaction, with
 * foreign keys off during the load (so self-references like
 * Category.parentId and any table order work) and a full
 * PRAGMA foreign_key_check before commit - any violation rolls everything
 * back. Ids are inserted verbatim. With execute=false the whole load still
 * runs (so every constraint is exercised) and is then rolled back.
 *
 * Call only after preflightLoad() returned no errors.
 */
export async function applyLoad(
  client: Client,
  backup: Backup,
  target: TargetInfo,
  opts: { snapshotSequence: Map<string, number> | null; execute: boolean }
): Promise<LoadReport> {
  const report: LoadReport = { deleted: [], inserted: [], sequence: [], committed: false };

  await client.execute("PRAGMA foreign_keys = OFF");
  const fkState = await client.execute("PRAGMA foreign_keys");
  if (Number(fkState.rows[0].foreign_keys) !== 0) throw new LoadError("Could not turn foreign_keys off on the target connection.");

  await client.execute("BEGIN IMMEDIATE");
  try {
    for (const table of MIGRATION_SEEDED_TABLES) {
      if (!(table in backup) || !target.columns.has(table)) continue;
      const res = await client.execute(`DELETE FROM ${quoteIdent(table)}`);
      report.deleted.push({ table, rows: res.rowsAffected });
    }

    for (const table of Object.keys(backup).sort()) {
      const rows = backup[table];
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        const sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
        for (const row of rows) await client.execute({ sql, args: cols.map((c) => row[c] as InValue) });
      }
      const count = Number((await client.execute(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)).rows[0].n);
      if (count !== rows.length) throw new LoadError(`${table}: inserted ${rows.length} row(s) but table now has ${count}.`);
      report.inserted.push({ table, rows: rows.length });
    }

    const autoinc = autoincrementTables(target.objects);
    const objectsNow = await readSchemaObjects(client);
    const current = await readSequence(client, objectsNow);
    const maxIds = new Map<string, number | null>();
    for (const table of autoinc) {
      const r = await client.execute(`SELECT max(rowid) AS m FROM ${quoteIdent(table)}`);
      maxIds.set(table, r.rows[0].m === null ? null : Number(r.rows[0].m));
    }
    report.sequence = planSequence(autoinc, current, maxIds, opts.snapshotSequence);
    for (const row of report.sequence) {
      if (row.target === 0 && row.current === null) continue; // nothing to record for an empty, never-used table
      const upd = await client.execute({ sql: `UPDATE sqlite_sequence SET seq = ? WHERE name = ?`, args: [row.target, row.table] });
      if (upd.rowsAffected === 0) {
        await client.execute({ sql: `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, args: [row.table, row.target] });
      }
    }

    const violations = await client.execute("PRAGMA foreign_key_check");
    if (violations.rows.length > 0) {
      const lines = violations.rows
        .slice(0, 20)
        .map((v) => `  ${v.table} rowid=${v.rowid} -> ${v.parent} (fk #${v.fkid})`);
      throw new LoadError(
        `PRAGMA foreign_key_check found ${violations.rows.length} violation(s) - rolled back, target unchanged:\n${lines.join("\n")}`
      );
    }

    if (opts.execute) {
      await client.execute("COMMIT");
      report.committed = true;
    } else {
      await client.execute("ROLLBACK");
    }
    return report;
  } catch (e) {
    try {
      await client.execute("ROLLBACK");
    } catch {
      // already rolled back / no transaction - the original error is what matters
    }
    throw e;
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
}
