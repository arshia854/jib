import path from "node:path";

// Single source of truth for where the isolated test SQLite file lives, so
// vitest.config.ts (which points TURSO_DATABASE_URL at it) and
// global-setup.ts (which creates/seeds/deletes it) can't drift apart. Flat
// file at the repo root, gitignored - same convention as the existing
// dev.db artifact. Never the live Turso DB .env's TURSO_DATABASE_URL points
// at; see global-setup.ts for how this file gets its schema.
export const TEST_DB_PATH = path.join(process.cwd(), ".vitest-test.db");
export const TEST_DB_URL = `file:${TEST_DB_PATH}`;
