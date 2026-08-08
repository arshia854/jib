<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Applying schema changes to the live database (Turso)

`npx prisma migrate dev`, `migrate deploy`, `migrate status`, `migrate resolve`,
and `db push` **do not work** against this project's live database, and never
have. Root cause: `prisma.config.ts`'s `datasource.url` is the raw
`libsql://...` Turso connection string, and Prisma's CLI (the "schema engine",
a separate Rust binary from the JS driver-adapter path `lib/prisma.ts` uses at
runtime) can only parse a handful of natively-recognized URL schemes
(`file:`, `postgresql://`, `mysql://`, ...) — `libsql://` isn't one of them,
so every schema-engine command fails immediately with `P1013: scheme not
recognized`, regardless of what's actually in the database or in
`_prisma_migrations`. Checked directly against the installed
`@prisma/config` package (v7.9.1): its `Datasource` type is just
`{ url?: string; shadowDatabaseUrl?: string }` — there's no adapter/factory
hook the CLI can use instead, so this isn't a config mistake to fix, it's a
current limitation of Prisma's CLI + libSQL/Turso. Don't touch
`lib/prisma.ts` or `schema.prisma`'s `datasource` block trying to "fix"
this — the app's actual runtime connection (via `@prisma/adapter-libsql`)
already works fine and is unrelated to this limitation.

As of 2026-08-06, `prisma/migrations/` also has some history worth knowing
about: the first two migrations
(`20260802152001_init_postgres`,
`20260802175335_add_admin_role_error_log_default_categories`) contain
Postgres-dialect SQL (`SERIAL`, multi-column `ALTER TABLE ... ADD COLUMN`)
left over from an abandoned attempt to use Postgres, even though
`schema.prisma`'s datasource has said `provider = "sqlite"` in every commit
since the very first one. They were never actually run as-is against
SQLite/Turso (that SQL isn't valid SQLite) — the live schema was brought in
sync with them some other way (most likely a working `db push` from an
environment/point in time where the connection issue above didn't apply).
`migration_lock.toml` had drifted to say `provider = "postgresql"` to match;
it's been corrected back to `"sqlite"` to match the actual schema. The live
DB's `_prisma_migrations` table didn't exist at all until it was backfilled
(see below) — so before that, Prisma had zero bookkeeping of what was
applied, even though the tables/columns were all actually there.

**Update, 2026-08-06:** the two migration.sql files themselves (not the live
DB, not `_prisma_migrations`, not `schema.prisma`) have since been rewritten
in place to valid SQLite/libSQL — `SERIAL` → `INTEGER PRIMARY KEY
AUTOINCREMENT`, multi-column `ALTER TABLE ... ADD COLUMN` split into one
statement per column, foreign keys moved inline into each `CREATE TABLE` as
`CONSTRAINT ... FOREIGN KEY` (SQLite has no `ALTER TABLE ADD CONSTRAINT`),
matching the style already used by the third migration. Each rewritten file
was verified to produce, against a disposable throwaway local SQLite file,
the exact same end-state schema `schema.prisma` described as of that
migration's point in history — same tables, columns, types, indexes, and
(for the second migration) the same seeded `DefaultCategory` rows. Nothing
about the live Turso schema or data changed. Rewriting the files changed
their SHA-256 checksums, so the `checksum` column of their two rows in
Turso's `_prisma_migrations` was updated to match (via
`scripts/backfill-migration-history.ts --fix-checksums`, see below) — that
was the one live-DB write this involved, and only after an explicit
dry-run review. If you're reading these two files and their content looks
"too clean"/recent for a mid-2026-08-02 timestamp, that's why — the
migration *names*/dates are original, the SQL inside was corrected later.
Don't repeat the original mistake: never hand-write or copy-paste
Postgres-dialect DDL into a migration here, even as a stopgap — this
project's `provider` is `"sqlite"` and always has been.

## Applying a *new* schema change

1. Edit `prisma/schema.prisma` as normal.
2. Generate the migration SQL **offline**, without touching the live DB —
   `migrate diff` between the schema before and after your change doesn't
   need a working datasource connection:
   ```bash
   git show HEAD:prisma/schema.prisma > /tmp/schema-before.prisma
   npx prisma migrate diff \
     --from-schema /tmp/schema-before.prisma \
     --to-schema prisma/schema.prisma \
     --script
   ```
3. Review the output, then save it verbatim as
   `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` (use the current
   UTC timestamp for the folder name, same format as the existing folders).
   Never hand-edit what `migrate diff` produced.
4. Apply that exact SQL to the live Turso DB using the same connection path
   `lib/prisma.ts` uses at runtime (`@libsql/client` with
   `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`), one statement at a time — this
   is the only path that actually reaches the database; see
   `scripts/backfill-migration-history.ts` for the connection pattern (the
   apply step itself isn't scripted since every migration's SQL is
   different — run it via a short one-off `tsx -e '...'`, same as was done
   for the `SpendingSummaryCache` migration).
5. Run `npx prisma generate` (this works fine — it only reads
   `schema.prisma`, no DB connection needed) to refresh the generated client.
6. Insert a matching row into `_prisma_migrations` on Turso (same
   `@libsql/client` connection) so bookkeeping stays in sync: `id` (random
   UUID), `checksum` (SHA-256 hex of the migration.sql file bytes),
   `migration_name` (the folder name), `started_at`/`finished_at` (now),
   `applied_steps_count = 1`, `rolled_back_at`/`logs` left `NULL`. Add the
   migration's name to the `MIGRATION_NAMES` list in
   `scripts/backfill-migration-history.ts` and re-run it (dry run first) —
   it's idempotent and already has this exact insert logic.
7. **Always confirm with the user before executing any write against the
   live database** (steps 4 and 6) — show the exact SQL/rows first.

`scripts/backfill-migration-history.ts` is the one-off script that brought
`_prisma_migrations` in sync with the 3 migrations that already existed as
of 2026-08-06 (safe to re-run — it skips any `migration_name` already
present, so it doubles as the template for step 6 above going forward). It
also has a `--fix-checksums` mode (dry-run by default, `--execute` to write)
for the situation in the update note above — a migration.sql already
recorded in `_prisma_migrations` gets corrected in place after the fact, so
its stored checksum needs to catch up to the new file bytes; it reuses the
same checksum logic rather than duplicating it.
