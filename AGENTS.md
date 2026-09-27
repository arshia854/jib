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

# Read-only access to the live database (Turso) still requires approval

The approval requirement in step 7 above is written in terms of writes,
but it isn't only about writes: **explicit in-conversation approval is
required before running any command against the live database, reads
included, not just writes/migrations.** This was underscored by a real
incident — a read-only audit script was run directly against the live
Turso DB without pausing for a go-ahead first. The query itself was
harmless (`SELECT`-only, zero rows changed), but the process was wrong
regardless: running anything against production, read or write, should
never be a unilateral agent decision, no matter how confident the agent
is that it's safe. A future read could be expensive, could target the
wrong table, or could be pointed at the wrong environment by mistake —
"it was just a SELECT" guards against none of those.

Default behavior when a task calls for inspecting live data — an audit
script, a diagnostic query, checking row counts, anything read-only — is
to write the script or query, explain exactly what it will do and why
it's safe, and then **stop and wait for explicit approval** before
running it against the live DB. Never run it proactively just because it
happens to be read-only.

The one exception: a command already named and pre-approved in this file
for a given workflow (e.g. the offline `migrate diff` step, or a script's
own documented dry-run mode) doesn't need re-approval each time — that
approval was already given by adopting the protocol it's part of.
Anything outside an already-approved workflow needs its own explicit
go-ahead. If it's genuinely unclear whether something counts as "already
approved" or needs fresh approval, default to asking.

# Backing up the live database (Turso)

**As of 2026-08-19, no backup of the live Turso database — automated or
manual — exists anywhere in this repo.** `scripts/` has no export/dump
script, and no cron/CI job runs one. This was checked, not assumed
(`grep`-ed the whole repo for "backup"/"dump"/"snapshot"/"point-in-time" —
the only hits were an unrelated `.env.save` mention in
`security-audit-report.md` and this file's own migration-checksum
discussion). Confirmed with the project owner: the live DB is on **Turso's
free plan**.

## What the free plan already gives you

Every Turso plan, including free, includes self-service **point-in-time
recovery (PITR)** — restoring to any moment is not something you have to
build, it's already there. The only thing that changes per plan is the
retention window: free = last **24 hours**, Developer = 10 days, Scaler =
30 days, Pro = 90 days
([docs.turso.tech/features/point-in-time-recovery](https://docs.turso.tech/features/point-in-time-recovery)).
Restoring doesn't overwrite the live DB in place — it creates a **new**
database from the old one as of a given timestamp:

```bash
turso db create jib-restored --from-db <live-db-name> --timestamp 2026-08-19T03:00:00Z
```

After that: point `TURSO_DATABASE_URL` at the new DB, generate a fresh
`TURSO_AUTH_TOKEN` for it (`turso db tokens create jib-restored`), redeploy,
verify, and only then delete the old (bad-state) database. This is a real,
working safety net for anything caught within 24 hours — but nothing
longer than that, and it's a manual, multi-step process with no rehearsal
in this repo today (no one has run it against this project's DB as part of
this work).

## The gap PITR doesn't cover, and the minimal fix

24 hours is short for a personal-finance app with no staging environment,
whose schema migrations are already applied via manual one-off scripts
(see above) — a mistake that isn't noticed same-day (a bad migration, an
accidental bulk delete, a bug that silently corrupts data over several
days) falls outside the free plan's PITR window entirely, with nothing
else behind it. The minimal, verifiable-from-this-repo fix is a periodic
**logical export**, kept somewhere other than Turso itself:

```bash
# Requires the Turso CLI, authenticated (`turso auth login`) — a *separate*
# credential from this app's own TURSO_AUTH_TOKEN, so this is a manual/cron
# step run from an operator's machine or a CI runner with its own Turso
# login, not something lib/prisma.ts's runtime connection can do.
turso db shell <live-db-name> .dump > "jib-backup-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

`turso db shell <db> .dump` runs SQLite's own `.dump` shell command against
the live DB non-interactively and streams a plain-SQL rebuild script to
stdout — no libSQL/SQLite internal tables included
([docs.turso.tech/cli/db/shell](https://docs.turso.tech/cli/db/shell)). A
dedicated `turso db export` command doesn't exist yet (open request,
[tursodatabase/turso-cli#965](https://github.com/tursodatabase/turso-cli/issues/965)) —
`.dump` via `db shell` is the current documented way to get a portable file
out. Restoring from one of these files means loading it into a fresh local
SQLite file or a new Turso DB (`turso db shell <new-db> < backup.sql`), the
same "new DB, then repoint, then delete the old one" shape as the PITR
restore above.

**This is a documented runbook, not automation** — no cron job or CI
workflow actually runs the command above yet; wiring it into a schedule
(a GitHub Actions cron job pushing the dump to some storage the operator
controls, since Turso itself is the thing being backed up *away from*) is
the natural next step but wasn't added here, since standing up and
verifying a working scheduled job needs a real place to send the output to
that this repo/session can't provision or confirm. Recommendation: run the
command above manually on a regular cadence (weekly is reasonable given
the 24h PITR window already covers same-day mistakes) until that's
automated.
