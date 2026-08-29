import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { TEST_DB_URL } from "./test/setup/test-db-path";

// Force every test run onto the isolated local SQLite file (schema applied
// + seeded by test/setup/global-setup.ts), never the live Turso DB that
// .env's TURSO_DATABASE_URL points at - lib/prisma.ts (and everything that
// imports it, directly or via lib/data/*) reads these two vars at import
// time with no other override point. Plain assignment, not something
// merged through dotenv above: dotenv only fills in vars that aren't
// already set, so if this ran *before* "dotenv/config" a real .env value
// would win; running after and assigning directly guarantees this always
// wins instead, regardless of what .env contains.
process.env.TURSO_DATABASE_URL = TEST_DB_URL;
process.env.TURSO_AUTH_TOKEN = "unused-for-local-sqlite-tests";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // The `server-only` package (see 4.2.6 - lib/data/* and lib/auth/*
      // each start with `import "server-only"`) only no-ops under Next's
      // own webpack/Turbopack build, which resolves it to an empty module
      // via a "react-server" export condition set on the server compiler
      // graph. Vitest's plain Node resolution doesn't set that condition,
      // so without this alias it falls through to server-only's default
      // export - which unconditionally throws "This module cannot be
      // imported from a Client Component module" - on every test file that
      // imports one of those modules, even though a vitest run is itself
      // as server-side as it gets. Aliasing straight to the package's own
      // empty module is the same fix Next's official Jest docs use
      // (`'server-only': '<rootDir>/__mocks__/empty.js'`), just pointed at
      // the real file instead of a hand-copied mock.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
      // Phase 16: importing `next-auth` for real (needed to unit-test
      // auth.ts's authorize() functions directly - see auth.test.ts) fails
      // under Vitest's plain Node ESM resolution with "Cannot find module
      // .../node_modules/next/server imported from
      // .../node_modules/next-auth/lib/env.js" - confirmed via a standalone
      // probe import, not assumed. Root cause is on next-auth's side, not
      // this alias working around a real problem in `next` itself:
      // next-auth/lib/env.js imports the extension-less specifier
      // "next/server" with its own `@ts-expect-error Next.js does not yet
      // correctly use the package.json#exports field` comment acknowledging
      // this - and this installed `next` (16.2.12) really has no `exports`
      // field in its package.json at all (confirmed directly), so Node's
      // strict ESM resolver has nothing to fall back to for a bare subpath
      // import with no extension, even though `next/server.js` (the real
      // file) exists right there. Next's own webpack/Turbopack build (and
      // presumably whatever resolution Vercel's hosting runtime uses) never
      // hits this, since neither does strict Node-spec ESM resolution - so
      // this is a Vitest-only gap, same category as the server-only alias
      // above. Fixed the same way: alias the exact bare specifier straight
      // at the real file next-auth is actually trying to reach.
      "next/server": path.resolve(__dirname, "node_modules/next/server.js"),
    },
  },
  test: {
    // Needed for the "next/server" alias above to actually take effect for
    // next-auth's own internal import of it: Vitest externalizes
    // node_modules packages by default (loaded natively by Node, bypassing
    // Vite's resolver/alias handling entirely) unless told to inline them.
    // Confirmed empirically - the alias alone, without this, left the same
    // "Cannot find module .../next/server" failure unchanged.
    server: {
      deps: {
        inline: ["next-auth"],
      },
    },
    globalSetup: ["./test/setup/global-setup.ts"],
    // A local SQLite file (unlike the real, server-backed Turso DB) throws
    // SQLITE_BUSY under concurrent access from multiple test files running
    // in parallel workers - this is a limitation of the local file
    // specifically, not a concurrency bug the app needs to handle.
    fileParallelism: false,
  },
});
