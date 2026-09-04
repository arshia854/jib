// Vitest global setup: prepares the isolated local SQLite file that every
// test run connects to instead of the live Turso DB - see
// vitest.config.ts (env override) and test-db-path.ts (shared path). Runs
// once, in its own process context, before any test file/worker starts -
// so it's safe to open its own short-lived @libsql/client connection here
// without touching whatever lib/prisma.ts's singleton does later inside
// the actual test workers.
//
// Deliberately does NOT use `prisma migrate dev`/`db push`, even against
// this local file - per AGENTS.md this project standardizes on applying
// migration.sql via the raw libsql client for every environment (that's
// the only path that works at all against the real Turso DB), so doing the
// same here means the test DB's schema is built by the exact same code
// path as production's, not a second one that could quietly drift.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { DEFAULT_CATEGORIES } from "../../prisma/default-categories";
import { TEST_DB_PATH, TEST_DB_URL } from "./test-db-path";

const MIGRATIONS_DIR = join(process.cwd(), "prisma/migrations");

function deleteTestDbFiles() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const filePath = TEST_DB_PATH + suffix;
    if (existsSync(filePath)) rmSync(filePath);
  }
}

// Applies every prisma/migrations/*/migration.sql in order, oldest first.
// Folder names are timestamp-prefixed (YYYYMMDDHHMMSS_name), so a plain
// lexicographic sort matches chronological order - the same assumption
// scripts/backfill-migration-history.ts's hardcoded MIGRATION_NAMES list
// makes, just derived from the filesystem instead of hardcoded here so a
// future migration doesn't need this file edited too.
async function applyMigrations(client: Client) {
  const folders = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
    // executeMultiple runs a whole file's worth of `;`-separated statements
    // (including the `-- Comment` lines migrate diff emits) through the
    // real SQLite parser in one call, rather than this file naively
    // splitting on `;` itself and risking breaking on a semicolon inside a
    // string literal.
    await client.executeMultiple(sql);
  }
}

// Mirrors prisma/seed.ts's own DefaultCategory seeding, using the same
// DEFAULT_CATEGORIES data imported from prisma/default-categories.ts (not a
// copy). Deliberately imports from that pure-data module and NOT from
// prisma/seed.ts itself: seed.ts's module body unconditionally calls and
// runs its own main() as a side effect of being imported at all (even for
// just a named export), which would race this file's applyMigrations()
// against seed.ts's own prisma.defaultCategory.upsert() calls - confirmed
// this races and double-inserts/hits "no such table" depending on timing
// when tried directly. Plain SQL via the same libsql client used for
// applyMigrations() above, not a Prisma Client instance: no test file (and
// therefore no lib/prisma.ts import) exists yet at this point in the run.
//
// Upserts (ON CONFLICT("name","type") DO UPDATE), not plain INSERT, to
// mirror prisma.defaultCategory.upsert()'s own semantics in prisma/seed.ts:
// the second migration (20260802175335_..._default_categories) already
// bakes in an older, differently-named snapshot of this same seed data
// (e.g. "خانه و زندگی" where DEFAULT_CATEGORIES now has "مسکن", and every
// row defaulting to isEssential=true since that column didn't exist yet
// when that migration was written) - several (name, type) pairs collide
// with today's DEFAULT_CATEGORIES, exactly as they would if prisma/seed.ts
// were run for real against a DB that already had that migration applied
// (which is presumably how the live Turso DB itself ended up current - see
// AGENTS.md). A plain INSERT hits a UNIQUE constraint violation on the
// first such collision (confirmed); upserting reconciles matching rows to
// the current data and leaves any now-unused old-named rows in place
// un-referenced, same as the real seed script would.
async function seedDefaultCategories(client: Client) {
  for (const category of DEFAULT_CATEGORIES) {
    const parent = await client.execute({
      // "parentId" = NULL on conflict mirrors prisma/seed.ts's own upsert
      // fix (see its comment) - a (name, type) already present as a child
      // row (stale legacy seed data) must be promoted back to top-level
      // here too, not just have its other columns refreshed, or this test
      // harness would silently diverge from what the real seed script now
      // does.
      sql: `INSERT INTO "DefaultCategory" ("name", "icon", "color", "type", "isEssential") VALUES (?, ?, ?, ?, ?)
            ON CONFLICT("name", "type") DO UPDATE SET "icon" = excluded."icon", "color" = excluded."color", "isEssential" = excluded."isEssential", "parentId" = NULL
            RETURNING "id"`,
      args: [category.name, category.icon, category.color, category.type, category.isEssential ? 1 : 0],
    });
    const parentId = Number(parent.rows[0]?.id);

    for (const child of category.children ?? []) {
      await client.execute({
        sql: `INSERT INTO "DefaultCategory" ("name", "icon", "color", "type", "isEssential", "parentId") VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT("name", "type") DO UPDATE SET "icon" = excluded."icon", "color" = excluded."color", "isEssential" = excluded."isEssential", "parentId" = excluded."parentId"`,
        args: [child.name, child.icon, child.color, category.type, child.isEssential ? 1 : 0, parentId],
      });
    }
  }
}

export async function setup() {
  // Fresh file every run, not an incrementally-reused one - guarantees no
  // state from a previous run (or a previous, since-changed migration set)
  // leaks into this one.
  deleteTestDbFiles();

  const client = createClient({ url: TEST_DB_URL });
  try {
    await applyMigrations(client);
    await seedDefaultCategories(client);
  } finally {
    client.close();
  }
}

export async function teardown() {
  // Don't leave a stray .vitest-test.db sitting in the working tree after
  // the run - the next run's setup() would delete it anyway, but cleaning
  // up here keeps `git status` quiet in between.
  deleteTestDbFiles();
}
