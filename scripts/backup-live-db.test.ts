// Tests for the hardening in scripts/backup-live-db.ts. Never touches the
// live DB or the shared .vitest-test.db - every DB here is a throwaway
// local SQLite file in its own temp dir, and the one test that spawns the
// script itself passes a non-file URL that's refused before any connection
// is attempted (see "refuses a non-file URL").
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertJsonSafe, readAllTablesConsistently, TABLE_LIST_SQL } from "./backup-live-db";
import { minimalChildEnv } from "./lib/sqlite-copy";

describe("assertJsonSafe", () => {
  it("passes through ordinary JSON-safe values unchanged", () => {
    expect(assertJsonSafe("T", "c", "hello")).toBe("hello");
    expect(assertJsonSafe("T", "c", 42)).toBe(42);
    expect(assertJsonSafe("T", "c", 1.5)).toBe(1.5);
    expect(assertJsonSafe("T", "c", null)).toBeNull();
  });

  it("throws on a bigint, naming table.column", () => {
    expect(() => assertJsonSafe("Asset", "purchasePricePerUnit", BigInt(7000000))).toThrow(
      "Asset.purchasePricePerUnit: value is a bigint (7000000) - JSON.stringify would throw on it."
    );
  });

  it("throws on an ArrayBuffer (BLOB), naming table.column", () => {
    expect(() => assertJsonSafe("ErrorLog", "stack", new ArrayBuffer(4))).toThrow(
      "ErrorLog.stack: value is a BLOB - JSON.stringify would silently turn it into {}."
    );
  });

  it("throws on a Uint8Array (BLOB), naming table.column", () => {
    expect(() => assertJsonSafe("ErrorLog", "stack", new Uint8Array([1, 2]))).toThrow(
      "ErrorLog.stack: value is a BLOB - JSON.stringify would silently turn it into {}."
    );
  });

  it.each([
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
  ])("throws on %s, naming table.column", (value, label) => {
    expect(() => assertJsonSafe("Asset", "quantity", value)).toThrow(
      `Asset.quantity: value is ${label} - JSON.stringify would silently turn it into null.`
    );
  });
});

describe("assertJsonSafe against a real scratch DB (proves what @libsql/client actually returns, not just what we assume)", () => {
  let dir: string;
  let client: Client;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jib-backup-live-db-test-"));
    client = createClient({ url: `file:${join(dir, "scratch.db")}` });
  });
  afterEach(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws the exact BLOB message for a BLOB literal stored in a TEXT-declared column", async () => {
    await client.execute(`CREATE TABLE "ErrorLog" (id INTEGER PRIMARY KEY, stack TEXT)`);
    // Same shape as the real schema (ErrorLog.stack is TEXT) - SQLite is
    // dynamically typed, so a BLOB literal still stores as a BLOB.
    await client.execute(`INSERT INTO "ErrorLog" (id, stack) VALUES (1, x'0102ff')`);
    const res = await client.execute(`SELECT stack FROM "ErrorLog" WHERE id = 1`);
    const value = res.rows[0].stack;
    expect(value).toBeInstanceOf(ArrayBuffer);
    expect(() => assertJsonSafe("ErrorLog", "stack", value)).toThrow(
      "ErrorLog.stack: value is a BLOB - JSON.stringify would silently turn it into {}."
    );
  });

  it("throws the exact non-finite message for an out-of-range REAL literal that SQLite stores as Infinity", async () => {
    await client.execute(`CREATE TABLE "Asset" (id INTEGER PRIMARY KEY, quantity REAL)`);
    // 9e999 overflows a double on the way in and SQLite stores the result
    // (confirmed empirically, not assumed) - unlike binding Infinity as a
    // parameter, which @libsql/client itself rejects.
    await client.execute(`INSERT INTO "Asset" (id, quantity) VALUES (1, 9e999)`);
    const res = await client.execute(`SELECT quantity FROM "Asset" WHERE id = 1`);
    const value = res.rows[0].quantity;
    expect(value).toBe(Infinity);
    expect(() => assertJsonSafe("Asset", "quantity", value)).toThrow(
      "Asset.quantity: value is Infinity - JSON.stringify would silently turn it into null."
    );
  });
});

describe("readAllTablesConsistently", () => {
  const stubClient = (batchResults: Awaited<ReturnType<Client["batch"]>>): Pick<Client, "batch"> => ({
    batch: async () => batchResults,
  });
  const resultSet = (rows: Record<string, unknown>[]) =>
    ({ rows, columns: rows[0] ? Object.keys(rows[0]) : [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON: () => ({}) }) as unknown as Awaited<ReturnType<Client["batch"]>>[number];

  it("returns the per-table results (in order) when the table list is unchanged", async () => {
    const tableNames = ["Category", "User"];
    const client = stubClient([
      resultSet([{ name: "Category" }, { name: "User" }]),
      resultSet([{ id: 1 }]),
      resultSet([{ id: 2 }, { id: 3 }]),
    ]);
    const results = await readAllTablesConsistently(client, tableNames);
    expect(results.map((r) => r.rows)).toEqual([[{ id: 1 }], [{ id: 2 }, { id: 3 }]]);
  });

  it("throws when the table list from inside the batch differs from what the caller read first", async () => {
    const tableNames = ["Category", "User"];
    // Simulates a table appearing (e.g. a migration running concurrently)
    // between the caller's own table-list read and this batch's.
    const client = stubClient([
      resultSet([{ name: "Category" }, { name: "NewTable" }, { name: "User" }]),
      resultSet([{ id: 1 }]),
      resultSet([{ id: 2 }]),
    ]);
    await expect(readAllTablesConsistently(client, tableNames)).rejects.toThrow(
      "Table list changed mid-backup (schema changed while this was running) - was [Category, User], is now [Category, NewTable, User]. Re-run."
    );
  });

  it("issues exactly one batch call containing the table-list SQL plus one SELECT * per table", async () => {
    const tableNames = ["Category", "User"];
    let capturedStmts: unknown;
    let capturedMode: unknown;
    const client: Pick<Client, "batch"> = {
      batch: async (stmts, mode) => {
        capturedStmts = stmts;
        capturedMode = mode;
        return [resultSet([{ name: "Category" }, { name: "User" }]), resultSet([]), resultSet([])];
      },
    };
    await readAllTablesConsistently(client, tableNames);
    expect(capturedStmts).toEqual([TABLE_LIST_SQL, `SELECT * FROM "Category"`, `SELECT * FROM "User"`]);
    expect(capturedMode).toBe("read");
  });
});

describe("CLI: refuses a non-file URL without --allow-remote (spawned, same pattern as scripts/rehearse-sqlite-copy.ts uses for scripts/snapshot-live-schema.ts)", () => {
  it("refuses before attempting any connection", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jib-backup-live-db-test-cwd-"));
    try {
      const result = spawnSync(
        join(resolve(__dirname, ".."), "node_modules", ".bin", "tsx"),
        [resolve(__dirname, "backup-live-db.ts"), cwd],
        {
          cwd,
          env: minimalChildEnv({ TURSO_DATABASE_URL: "http://127.0.0.1:1", TURSO_AUTH_TOKEN: "dummy" }),
          encoding: "utf8",
          timeout: 15000,
        }
      );
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // Proves it never tried to connect: a real attempt against a closed
      // local port would fail with a connection error, not this message.
      expect(output).toContain("Connecting to: http://127.0.0.1:1");
      expect(output).toContain(
        "Refusing: this is not a local file: URL. Reading the live DB (even SELECT-only) needs explicit approval per AGENTS.md - once approved, re-run with --allow-remote."
      );
      expect(result.status).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
