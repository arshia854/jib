// Unit tests for the Turso -> local SQLite copy tooling's logic (see
// sqlite-copy.ts). Only temp files and in-memory DBs - never the live DB,
// and not the shared .vitest-test.db either. The end-to-end path
// (migrate deploy + backup-live-db.ts + loader + verifier) is covered by
// scripts/rehearse-sqlite-copy.ts instead, which needs the Prisma CLI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  applyLoad,
  checkManifestMatchesBackup,
  checkMigrateDeployBookkeeping,
  describeStructure,
  diffBackupColumns,
  diffSchemaObjects,
  diffStructures,
  findNonScalarValues,
  inspectTarget,
  LoadError,
  openLocalDb,
  planSequence,
  preflightLoad,
  readSchemaObjects,
  resolveLocalDbPath,
  structureFromSnapshot,
  type MigrationRow,
  type SchemaObject,
  type Snapshot,
  type TargetColumn,
  type TargetInfo,
} from "./sqlite-copy";

const col = (name: string, notNull = false, pk = 0): TargetColumn => ({ name, type: "TEXT", notNull, defaultValue: null, pk });
const folders = [
  { name: "20260101000000_a", checksum: "aaa" },
  { name: "20260102000000_b", checksum: "bbb" },
];
const migRow = (name: string, checksum: string, extra: Partial<MigrationRow> = {}): MigrationRow => ({
  migration_name: name,
  checksum,
  finished_at: 1,
  rolled_back_at: null,
  applied_steps_count: 1,
  ...extra,
});
const okMigrations = [migRow("20260101000000_a", "aaa"), migRow("20260102000000_b", "bbb")];

describe("resolveLocalDbPath", () => {
  it.each(["libsql://db-org.turso.io", "file:/tmp/x.db", "https://example.com/db", "http://127.0.0.1:8080"])(
    "refuses URL %s before anything is opened",
    (url) => {
      expect(() => resolveLocalDbPath(url, { mustExist: false })).toThrow(/not a URL/);
    }
  );

  it("resolves a relative path to an absolute one", () => {
    expect(resolveLocalDbPath("some/dir/copy.db", { mustExist: false })).toBe(resolve("some/dir/copy.db"));
  });

  it("requires the file to exist when asked", () => {
    expect(() => resolveLocalDbPath("/definitely/not/here.db", { mustExist: true })).toThrow(/No such file/);
  });
});

describe("checkMigrateDeployBookkeeping", () => {
  it("accepts an exact match", () => {
    expect(checkMigrateDeployBookkeeping(okMigrations, folders)).toEqual([]);
  });

  it("rejects a DB without _prisma_migrations", () => {
    expect(checkMigrateDeployBookkeeping(null, folders)[0]).toMatch(/does not exist/);
  });

  it("rejects a missing migration and reports the count mismatch", () => {
    const problems = checkMigrateDeployBookkeeping([okMigrations[0]], folders);
    expect(problems).toContain("_prisma_migrations has 1 row(s) but prisma/migrations has 2 folder(s).");
    expect(problems).toContain("migration not applied: 20260102000000_b");
  });

  it("rejects checksum drift, rolled-back and unfinished rows, and unknown names", () => {
    const problems = checkMigrateDeployBookkeeping(
      [
        migRow("20260101000000_a", "zzz"),
        migRow("20260102000000_b", "bbb", { rolled_back_at: 5, finished_at: null }),
        migRow("20250101000000_unknown", "x"),
      ],
      folders
    );
    expect(problems.join("\n")).toMatch(/checksum mismatch for 20260101000000_a/);
    expect(problems.join("\n")).toMatch(/rolled back: 20260102000000_b/);
    expect(problems.join("\n")).toMatch(/never finished: 20260102000000_b/);
    expect(problems.join("\n")).toMatch(/no matching folder: 20250101000000_unknown/);
  });
});

describe("diffBackupColumns", () => {
  const target = [col("id", false, 1), col("name", true), col("note")];

  it("finds extra JSON columns, missing NOT NULL and missing nullable ones", () => {
    const diff = diffBackupColumns("T", [{ id: 1, legacy: "x" }], target);
    expect(diff.extraInJson).toEqual(["legacy"]);
    expect(diff.missingNotNull).toEqual(["name"]);
    expect(diff.missingNullable).toEqual(["note"]);
  });

  it("treats a missing INTEGER PRIMARY KEY as NOT NULL (ids must never be regenerated)", () => {
    expect(diffBackupColumns("T", [{ name: "a", note: null }], target).missingNotNull).toEqual(["id"]);
  });

  it("flags rows whose key set differs from the first row", () => {
    const diff = diffBackupColumns("T", [{ id: 1, name: "a", note: null }, { id: 2, name: "b" }], target);
    expect(diff.inconsistentRows).toEqual([{ index: 1, keys: ["id", "name"] }]);
  });

  it("has no column info for an empty table", () => {
    expect(diffBackupColumns("T", [], target).jsonColumns).toBeNull();
  });
});

describe("findNonScalarValues", () => {
  it("flags {} (a BLOB after JSON.stringify) and arrays, accepts JSON scalars", () => {
    const found = findNonScalarValues([{ a: "x", b: 1.5, c: null, d: {} }, { a: [1] }]);
    expect(found.map((f) => `${f.rowIndex}.${f.column}`)).toEqual(["0.d", "1.a"]);
  });
});

describe("checkManifestMatchesBackup", () => {
  it("reports count and table-set disagreements both ways", () => {
    const problems = checkManifestMatchesBackup({ A: [{}, {}], B: [] }, { tableRowCounts: { A: 3, C: 0 } });
    expect(problems).toEqual([
      "A: backup has 2 row(s), manifest says 3.",
      "backup has table B but the manifest doesn't list it.",
      "manifest lists table C but the backup has no such key.",
    ]);
  });
});

describe("planSequence", () => {
  it("takes the max of current, max(id) and live's snapshot value", () => {
    const plan = planSequence(
      ["A", "B", "C"],
      new Map([["A", 43]]),
      new Map<string, number | null>([["A", 10], ["B", 5], ["C", null]]),
      new Map([["B", 9]])
    );
    expect(plan.map((p) => [p.table, p.target])).toEqual([["A", 43], ["B", 9], ["C", 0]]);
  });
});

describe("diffSchemaObjects", () => {
  const obj = (name: string, sql: string | null, type = "table"): SchemaObject => ({ type, name, tbl_name: name, sql });

  it("reports missing, unexpected and changed objects", () => {
    const diff = diffSchemaObjects([obj("A", "CREATE TABLE A (x)"), obj("B", "CREATE TABLE B (y)")], [obj("A", "CREATE TABLE A (x, z)"), obj("C", "CREATE TABLE C (q)")]);
    expect(diff.missing.map((o) => o.name)).toEqual(["B"]);
    expect(diff.unexpected.map((o) => o.name)).toEqual(["C"]);
    expect(diff.changed.map((c) => c.expected.name)).toEqual(["A"]);
  });

  it("compares SQL exactly unless asked to normalize whitespace", () => {
    const a = [obj("A", "CREATE TABLE A (\n  x\n)")];
    const b = [obj("A", "CREATE TABLE A ( x )")];
    expect(diffSchemaObjects(a, b).changed).toHaveLength(1);
    expect(diffSchemaObjects(a, b, { normalizeSql: true }).changed).toHaveLength(0);
  });
});

describe("preflightLoad", () => {
  const objects: SchemaObject[] = [
    { type: "table", name: "User", tbl_name: "User", sql: "CREATE TABLE User (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)" },
    { type: "table", name: "DefaultCategory", tbl_name: "DefaultCategory", sql: "CREATE TABLE DefaultCategory (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)" },
    { type: "table", name: "Extra", tbl_name: "Extra", sql: "CREATE TABLE Extra (id INTEGER PRIMARY KEY, note TEXT)" },
  ];
  const target = (rowCounts: Record<string, number> = {}): TargetInfo => ({
    objects,
    columns: new Map([
      ["User", [col("id", false, 1), col("name", true)]],
      ["DefaultCategory", [col("id", false, 1), col("name", true)]],
      ["Extra", [col("id", false, 1), col("note")]],
    ]),
    rowCounts: new Map(Object.entries({ User: 0, DefaultCategory: 43, Extra: 0, ...rowCounts })),
    migrations: okMigrations,
  });
  const backup = { User: [{ id: 1, name: "a" }], DefaultCategory: [{ id: 1, name: "c" }], Extra: [{ id: 1, note: null }] };
  const manifest = { tableRowCounts: { User: 1, DefaultCategory: 1, Extra: 1 } };
  const options = { acceptMissingColumns: [], allowMissingTables: [] };

  it("passes a clean fresh target, noting the migration-seeded table will be replaced", () => {
    const pre = preflightLoad({ backup, manifest, snapshot: null, target: target(), folders, options });
    expect(pre.errors).toEqual([]);
    expect(pre.notes.join("\n")).toMatch(/DefaultCategory: 43 migration-seeded row\(s\)/);
  });

  it("refuses a non-empty target", () => {
    const pre = preflightLoad({ backup, manifest, snapshot: null, target: target({ User: 2 }), folders, options });
    expect(pre.errors).toContain("target is not empty: User already has 2 row(s). Load only into a fresh `migrate deploy` file.");
  });

  it("refuses a target not built by migrate deploy", () => {
    const pre = preflightLoad({ backup, manifest, snapshot: null, target: { ...target(), migrations: null }, folders, options });
    expect(pre.errors.join("\n")).toMatch(/_prisma_migrations table does not exist/);
  });

  it("refuses tables present on only one side unless explicitly allowed", () => {
    const partial = { User: backup.User, DefaultCategory: backup.DefaultCategory, Ghost: [] };
    const partialManifest = { tableRowCounts: { User: 1, DefaultCategory: 1, Ghost: 0 } };
    const pre = preflightLoad({ backup: partial, manifest: partialManifest, snapshot: null, target: target(), folders, options });
    expect(pre.errors.join("\n")).toMatch(/backup table Ghost does not exist in the target/);
    expect(pre.errors.join("\n")).toMatch(/target table Extra is absent from the backup/);

    const allowed = preflightLoad({
      backup: { User: backup.User, DefaultCategory: backup.DefaultCategory },
      manifest: { tableRowCounts: { User: 1, DefaultCategory: 1 } },
      snapshot: null,
      target: target(),
      folders,
      options: { acceptMissingColumns: [], allowMissingTables: ["Extra"] },
    });
    expect(allowed.errors).toEqual([]);
  });

  it("requires --accept-missing for a nullable column absent from the backup", () => {
    const noNote = { ...backup, Extra: [{ id: 1 }] };
    expect(preflightLoad({ backup: noNote, manifest, snapshot: null, target: target(), folders, options }).errors).toEqual([
      "Extra.note: nullable column in the target is absent from the backup. Re-run with --accept-missing Extra.note to accept NULLs.",
    ]);
    const accepted = preflightLoad({ backup: noNote, manifest, snapshot: null, target: target(), folders, options: { acceptMissingColumns: ["Extra.note"], allowMissingTables: [] } });
    expect(accepted.errors).toEqual([]);
    expect(accepted.warnings.join("\n")).toMatch(/Extra.note: absent from the backup - accepted/);
  });

  it("warns when the snapshot and backup were taken at different DB states", () => {
    const snapshot: Snapshot = { sqliteMaster: [], sqliteSequence: [{ name: "Extra", seq: 3 }], prismaMigrations: null, tableRowCounts: { User: 2 } };
    const pre = preflightLoad({ backup, manifest, snapshot, target: target(), folders, options });
    expect(pre.errors).toEqual([]);
    expect(pre.warnings.join("\n")).toMatch(/User: snapshot counted 2 row\(s\), backup has 1/);
    expect(pre.warnings.join("\n")).toMatch(/Extra isn't AUTOINCREMENT in the target/);
  });
});

describe("applyLoad (temp-file DB)", () => {
  let dir: string;
  let client: Client;
  const DDL = `
    CREATE TABLE "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
    CREATE TABLE "Category" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" INTEGER NOT NULL, "parentId" INTEGER,
      CONSTRAINT "c_user" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
      CONSTRAINT "c_parent" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE RESTRICT);
    CREATE TABLE "DefaultCategory" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL);
    INSERT INTO "DefaultCategory" ("name") VALUES ('seeded-1'), ('seeded-2');`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "jib-sqlite-copy-test-"));
    client = openLocalDb(join(dir, "t.db"));
    await client.executeMultiple(DDL);
  });
  afterEach(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Child before parent on purpose: works only because FKs are off during the load.
  const backup = {
    User: [{ id: 5, name: "u" }],
    Category: [
      { id: 8, userId: 5, parentId: 7 },
      { id: 7, userId: 5, parentId: null },
    ],
    DefaultCategory: [{ id: 3, name: "live-only" }],
  };
  const count = async (table: string) => Number((await client.execute(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n);
  const seq = async (table: string) => (await client.execute({ sql: `SELECT seq FROM sqlite_sequence WHERE name = ?`, args: [table] })).rows[0]?.seq;

  it("dry run executes the whole load and rolls it back", async () => {
    const report = await applyLoad(client, backup, await inspectTarget(client), { snapshotSequence: null, execute: false });
    expect(report.committed).toBe(false);
    expect(await count("User")).toBe(0);
    expect(await count("DefaultCategory")).toBe(2);
  });

  it("commits ids verbatim, replaces migration-seeded rows and raises sqlite_sequence to live's value", async () => {
    const report = await applyLoad(client, backup, await inspectTarget(client), {
      snapshotSequence: new Map([["Category", 20]]),
      execute: true,
    });
    expect(report.deleted).toEqual([{ table: "DefaultCategory", rows: 2 }]);
    expect((await client.execute(`SELECT id, parentId FROM "Category" ORDER BY id`)).rows.map((r) => [r.id, r.parentId])).toEqual([[7, null], [8, 7]]);
    expect((await client.execute(`SELECT id, name FROM "DefaultCategory"`)).rows.map((r) => [r.id, r.name])).toEqual([[3, "live-only"]]);
    expect(await seq("Category")).toBe(20);
    expect(await seq("User")).toBe(5);
    // Never lowered: the migration seed already pushed DefaultCategory's seq to 2 < 3 = max(id).
    expect(await seq("DefaultCategory")).toBe(3);
    expect(Number((await client.execute("PRAGMA foreign_keys")).rows[0].foreign_keys)).toBe(1);
  });

  it("rolls everything back on a foreign-key violation", async () => {
    const bad = { ...backup, Category: [{ id: 9, userId: 999, parentId: null }] };
    await expect(applyLoad(client, bad, await inspectTarget(client), { snapshotSequence: null, execute: true })).rejects.toThrow(LoadError);
    expect(await count("User")).toBe(0);
    expect(await count("DefaultCategory")).toBe(2);
    expect(Number((await client.execute("PRAGMA foreign_keys")).rows[0].foreign_keys)).toBe(1);
  });
});

describe("structureFromSnapshot + diffStructures", () => {
  it("reports live-only columns and target-only indexes from DDL alone", async () => {
    const liveDdl: SchemaObject[] = [
      { type: "table", name: "T", tbl_name: "T", sql: `CREATE TABLE "T" ("id" INTEGER PRIMARY KEY, "a" TEXT NOT NULL, "legacy" TEXT)` },
    ];
    const { structure: live, failures } = await structureFromSnapshot({ sqliteMaster: liveDdl, sqliteSequence: null, prismaMigrations: null, tableRowCounts: {} });
    expect(failures).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "jib-sqlite-copy-test-"));
    const target = openLocalDb(join(dir, "t.db"));
    try {
      await target.executeMultiple(`CREATE TABLE "T" ("id" INTEGER PRIMARY KEY, "a" TEXT); CREATE INDEX "T_a_idx" ON "T"("a");`);
      const diff = diffStructures(live, await describeStructure(target, await readSchemaObjects(target)));
      expect(diff.liveOnly).toEqual(["column T.legacy (TEXT)"]);
      expect(diff.targetOnly).toEqual(["index T_a_idx ON T(a)"]);
      expect(diff.different).toEqual(["column T.a: live TEXT NOT NULL | target TEXT"]);
    } finally {
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
