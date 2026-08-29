# فاز ۴ Jib — Production Hardening & Architecture Evolution Roadmap

**Status:** Draft
**Date:** 2026-08-09
**Owner:** hajervin
**Scope:** Everything needed to take Jib from "working beta with a handful of real users" to a hardened, observable, horizontally-scalable production app — closing out the open findings from `security-audit-report.md` (2026-08-06) and addressing the architectural load-bearing walls that audit didn't need to touch yet.

This file is the master plan for Phase 4. As with every other phase, day-to-day execution still happens through the external numbered-subtask system (not tracked in this repo) — this document exists because Phase 4 is large and cross-cutting enough that it needed a single place mapping *what* to do, *why*, and *in what order*, cross-referenced against the audit's finding IDs so nothing gets rediscovered from scratch. Sub-sections are numbered `4.1`, `4.2`, … so they can be referenced the same way prior subtasks have been (e.g. "4.3.2").

---

## 1. Where Phase 4 starts from

Jib is a Persian-market personal-finance PWA: phone/OTP + email + Google auth, Next.js 16 App Router, Prisma ORM 7 over Turso (libSQL), NVIDIA NIM for AI transaction parsing and a financial chat assistant, deployed to a self-managed VPS behind a reverse proxy. As of `64f8e90` it also has conversational transaction logging (chat can detect an unlogged expense and offer to save it), a user-facts system that personalizes chat advice, and richer reporting (today-spending, monthly comparison, spending summaries with a cache table).

A full read-only security/quality audit (`security-audit-report.md`) was run against the codebase on 2026-08-06: 0 critical, 3 high, 9 medium, 8 low findings, plus a "Top 10 Priorities" list. That audit is the primary input to this roadmap — Phase 4 is, in large part, "work the audit's priority list to completion," reorganized into shippable workstreams and extended with the architecture-evolution items the audit flagged but didn't fully scope (distributed rate limiting, observability, CI).

**Real-user caveat that shapes every item below:** Jib has 7+ real users with real financial data on the live Turso database already. There is no separate staging environment. Every workstream here that touches auth, rate limiting, or the schema needs to be shipped carefully (see 4.5) — this isn't a green-field hardening pass.

### 1.1 Already fixed (on `feat/conversational-transaction-logging`, uncommitted as of 2026-08-09)

Before planning new work, note what's already done so it isn't re-planned:

| Audit ID | Finding | Status |
|---|---|---|
| SEC-2 | Financial data persisted in Cache Storage after logout | ✅ Fixed in `64f8e90` — `LogoutButton` now posts `CLEAR_AUTH_CACHE` to the service worker, which deletes `PAGES_CACHE` before the redirect (`public/sw.js`, `components/layout/logout-button.tsx`) |
| SEC-3 | Rate limits keyed off spoofable `X-Forwarded-For` | ✅ Fixed, uncommitted — `getClientIp()` now prefers `X-Real-IP`, falls back to the **last** `X-Forwarded-For` hop instead of the first (`lib/rate-limit.ts`); a code comment documents that this only becomes spoof-proof once the reverse proxy is actually configured to set `X-Real-IP` (see 4.5.1 — this is a real open dependency, not a false-done) |
| SEC-7 | OTP mock-SMS fallback silently active in production if Melipayamak creds are unset | ✅ Fixed, uncommitted — `sendOtpSms()` now fails closed (`{ success: false }`, logs an error server-side) when `NODE_ENV === "production"` instead of printing the code (`lib/auth/otp.ts`) |
| SEC-8 | Single `AUTH_SECRET` reused for OTP, legacy sessions, and NextAuth sessions | ✅ Fixed, uncommitted — split into three independent env vars: `AUTH_SECRET` (NextAuth only), `OTP_SECRET`, `LEGACY_SESSION_SECRET` (`lib/auth/otp.ts`, `lib/auth/session.ts`, `.env.example`) |
| T-1 | Tests run against the live configured DB | ✅ Fixed, uncommitted (2026-08-09) — isolated local-SQLite test datasource via `@libsql/client`'s `file:` driver, wired into `vitest.config.ts` (`test/setup/global-setup.ts`, `test/setup/test-db-path.ts`, `prisma/default-categories.ts`). 33/33 files, 363/363 tests passing. Full writeup in §5 Progress Log. |
| — | Test coverage | Also uncommitted: new `lib/auth/otp.test.ts`, `lib/data/accounts.test.ts`, `lib/data/categories.test.ts`, plus expanded `lib/rate-limit.test.ts` / `lib/data/transactions.test.ts`. Test-file count is up from 19 (at audit time) to 33. |

**Action before starting new Phase 4 work:** commit and merge this in-flight branch first. It resolves 5 of the audit's original 20 findings (including 2 of the 3 High findings) and shouldn't sit stacked underneath new work.

### 1.2 Still open (what Phase 4 actually covers)

Everything else from the audit, confirmed still present by direct inspection on 2026-08-09 (not re-derived from the audit text — `next.config.ts`, `package.json`, `lib/nvidia-ai.ts`, `vitest.config.ts`, and the repo root were all checked directly):

| Audit ID | Finding | Confirmed still open |
|---|---|---|
| SEC-1 | No security headers (CSP/HSTS/X-Frame-Options/etc.) | `next.config.ts`'s only `headers()` entry targets `/sw.js` |
| SEC-11 | `X-Powered-By` not disabled | No `poweredByHeader` key in `next.config.ts` |
| SEC-4 | `next-auth` beta not pinned | `package.json` still has `"next-auth": "^5.0.0-beta.32"` |
| SEC-5 | In-memory rate limiter, not distributed-safe | `lib/rate-limit.ts` still a process-local `Map` |
| SEC-6 | No `max_tokens` cap on LLM calls | No `max_tokens` in `lib/nvidia-ai.ts` or either call site |
| SEC-9 | `trustHost: true`, proxy hardening unverifiable from repo | Infra-only; no in-repo change possible |
| SEC-10 | No idempotency on transaction creation | No idempotency key/dedup logic anywhere in `app/api/transactions/route.ts` or `lib/data/transactions.ts` |
| SEC-12 | 90-day sessions, no step-up re-auth | Unchanged in `auth.ts` |
| IV-1 | No schema-validation library | No `zod` (or similar) in `package.json` |
| DR-1 | No Dockerfile/process-manager config | Confirmed absent repo-wide |
| T-2 | No CI pipeline | No `.github/workflows/` |
| CQ-1 | README documents a stale stack | `README.md` still says "SQLite via Prisma ORM 7 (`@prisma/adapter-better-sqlite3`)" and "OpenRouter for all AI calls" — actual stack is `@prisma/adapter-libsql`/Turso and NVIDIA NIM |
| OBS-1 | No instrumentation/APM hook | No `instrumentation.ts` anywhere |
| (perf) | No `next/dynamic` code-splitting | Confirmed zero usages in `app/`/`components/` |
| (quality) | `server-only` package not used in `lib/data`/`lib/auth` | Confirmed not a dependency |

That's 15 open items (T-1 moved to §1.1 as of 2026-08-09 — see §5 Progress Log). Phase 4 groups them into five workstreams below, ordered so that later workstreams can rely on earlier ones (most importantly: **get a safety net before making further changes**).

---

## 2. Workstreams

### 4.1 — Testing & CI foundation *(do this first)*

Everything else in this roadmap is safer with a real safety net under it. This was audit priority #4/#5 for a reason: T-1's live-DB test pollution and T-2's missing CI are both cheap to fix and every other workstream benefits from them being fixed first.

- **4.1.1 — Isolated test database (T-1). ✅ Done, 2026-08-09 — see §5 Progress Log.** Tests previously ran against whatever `TURSO_DATABASE_URL` `.env` pointed at — i.e. the live database with real user rows. Fixed: `vitest.config.ts` now overrides `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to a disposable local SQLite file, prepared by a `globalSetup` (`test/setup/global-setup.ts`) that applies every `prisma/migrations/*/migration.sql` to it in order via `@libsql/client`'s `file:` driver and seeds `DefaultCategory` (`prisma/default-categories.ts`), with `fileParallelism: false` to avoid `SQLITE_BUSY`. 33/33 files, 363/363 tests passing, run twice to confirm reliability.
- **4.1.2 — CI pipeline (T-2). ✅ Done, 2026-08-15 — see `docs/roadmap-status.md`.** Add `.github/workflows/ci.yml` running `npm run lint`, `npx tsc --noEmit`, and `npm run test` on every PR — 4.1.1 is now landed (uncommitted), so this is unblocked.
- **4.1.3 — README accuracy (CQ-1). ✅ Done, 2026-08-15 — see `docs/roadmap-status.md`.** Update the tech-stack and getting-started sections to match reality (NVIDIA NIM env vars, Turso, `@prisma/adapter-libsql`) instead of the pre-migration OpenRouter/better-sqlite3 description. Small, but bundle it here since a new contributor following a fixed README is part of "the safety net."

### 4.2 — Security hardening completion

The remaining audit findings, roughly in the audit's own priority order:

- **4.2.1 — Security headers (SEC-1, SEC-11). ✅ Done, 2026-08-15 — see `docs/roadmap-status.md`.** Add a `headers()` block in `next.config.ts` (or via `proxy.ts` if a CSP nonce is wanted) setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security`, and a baseline CSP tuned against Jib's actual asset origins (self-hosted font, no third-party scripts currently — should make for a fairly tight CSP). Bundle `poweredByHeader: false` in the same change.
- **4.2.2 — LLM output cap (SEC-6).** Add an explicit `max_tokens` to both NVIDIA NIM call sites (`lib/nvidia-ai.ts`, used by transaction parsing and chat) sized to what each actually needs — a parsed-transaction JSON object and a chat reply are both naturally short. Closes an open-ended cost exposure.
- **4.2.3 — Transaction idempotency (SEC-10).** Accept an optional client-generated idempotency key on `POST /api/transactions` (e.g. `crypto.randomUUID()` generated once per submit attempt client-side) and dedupe server-side. This is a schema change (new column + unique index on `(userId, idempotencyKey)`), so it must go through the migration process in `AGENTS.md` — see 4.5.1. Directly protects the core integrity guarantee of a finance app (accurate transaction history) against double-submit/retry.
- **4.2.4 — Pin `next-auth` (SEC-4). ✅ Done, 2026-08-15 — see `docs/roadmap-status.md`.** Drop the `^` on `next-auth` so `npm install` can't silently pull a new beta with behavioral changes to the single most security-critical dependency in the app. Track Auth.js v5 stable for a real upgrade later (separate, larger effort, not in this phase).
- **4.2.5 — Zod rollout, phased (IV-1).** Not a rewrite of every route at once — start with the money-handling endpoints (`app/api/transactions/route.ts`, `app/api/accounts/route.ts`) since those are highest-value, then expand. Current hand-rolled validation is actually reasonably thorough per the audit; this is about consistency and reducing the cost of getting a check subtly wrong in future changes, not fixing a live gap.
- **4.2.6 — `server-only` guard. ✅ Done, 2026-08-15 — see `docs/roadmap-status.md`.** Add the `server-only` package and import it at the top of every module in `lib/data/*` and `lib/auth/*` (excluding anything already imported from client components — audit found none, so this should be a no-op import everywhere). Build-time guarantee against a future accidental server/client boundary leak.
- **4.2.7 — Session lifetime (SEC-12).** Lower priority — evaluate shortening the 90-day NextAuth session `maxAge` and/or adding step-up re-auth (password/OTP re-entry) before destructive actions (account deletion, viewing full history). Worth a deliberate product-tradeoff conversation rather than a reflexive fix, since it affects UX for all users.
- **4.2.8 — Reverse-proxy hardening runbook (SEC-3 follow-through, SEC-9).** Not a code change — a short ops runbook documenting the two required proxy settings that the code now assumes: `X-Real-IP` set to the true peer address (not passed through from the client), and `Host`/`X-Forwarded-Host` pinned to the canonical domain given `trustHost: true` in `auth.ts`. Without this, 4.1's SEC-3 fix and the existing `trustHost` setting are both resting on an unverified assumption about infrastructure outside this repo.

### 4.3 — Observability & operational readiness

- **4.3.1 — `instrumentation.ts` (OBS-1).** Wire up OpenTelemetry (or a comparable APM) once a backend is chosen — needed for LLM call latency, DB query latency, and general request tracing, none of which the current `ErrorLog` table captures (it only logs explicit `logError()` calls, not general throughput/latency).
- **4.3.2 — Deployment artifact (DR-1).** `auth.ts` describes a self-managed-VPS-behind-a-reverse-proxy deployment, but nothing reproducible is checked into the repo. Add a `Dockerfile` (Next.js standalone output) or, at minimum, a documented deploy runbook, so deployment steps aren't tribal knowledge living only outside version control.
- **4.3.3 — Bundle splitting (perf finding). ⚠️ Partially done, 2026-08-15 — see `docs/roadmap-status.md`.** `next/dynamic` for the admin section and chart/report components (`components/reports/*`, `components/dashboard/category-donut.tsx`) — these are either rarely used (admin) or heavier (charts), and currently ship in the initial bundle for every user. Applied to the two heaviest admin Client Components; the `components/reports/*`/`category-donut.tsx` half was evaluated and deliberately skipped — verified they're pure Server Components with zero client-side footprint and already covered by an existing route-level `loading.tsx`, so `next/dynamic` there would be a no-op, not a real fix. Also verified (via the built `.next` client-reference-manifest output) that the admin half's underlying "ships in the initial bundle for every user" premise doesn't actually hold today either - Next's automatic per-route code splitting was already excluding admin-only client components from non-admin bundles before this change.

### 4.4 — Architecture evolution (beyond what the audit scoped)

The audit was a snapshot of the current single-instance deployment. These items are what starts to matter as Jib grows past a handful of users — flagged now so they're deliberate decisions, not emergency fixes later.

- **4.4.1 — Distributed rate limiting (SEC-5).** `lib/rate-limit.ts` is an in-process `Map` (with a recently-added `MAX_STORE_SIZE` eviction guard, but still per-process). Every current rule — OTP request/verify, email login, transaction-parse, chat, the general per-IP API backstop (`OTP_REQUEST_PHONE_RULE`, `CHAT_USER_RULE`, `GENERAL_API_IP_RULE`, etc. in `lib/rate-limit.ts`) — resets on restart and doesn't share state across instances. This is fine for a single Node process on one VPS, which is the current deployment; it becomes a real gap the moment there's more than one app instance (horizontal scaling, or even a rolling-restart deploy resetting everyone's counters). **Decision point:** if horizontal scaling is on the near-term roadmap, move to a shared store (Redis, self-hosted or hosted) behind the same `checkRateLimit()` interface so call sites don't change. If it isn't, defer this and just document the single-instance assumption explicitly. Don't build the distributed version speculatively before the deployment topology actually needs it.
- **4.4.2 — LLM call path: sync vs. async.** Both AI-calling endpoints (transaction parse, chat) are synchronous request/response today, which is appropriate at current volume — but chat already has a deterministic-match fast path (bank SMS, merchant lookup) that skips the LLM entirely when possible, showing the team already thinks about this cost/latency tradeoff. Worth a follow-up review once usage grows: whether a queue/background-job pattern is warranted for the parse path, or whether the existing fast-path + rate limits + (post-4.2.2) `max_tokens` cap are sufficient. Not action-item-sized yet; a checkpoint to revisit at a defined usage threshold (e.g. "if daily active users crosses N").
- **4.4.3 — Extend the caching pattern.** `SpendingSummaryCache` (immutable past-month summaries, cached to avoid re-aggregating on every chat message) is a good precedent. As reporting features grow, evaluate whether other read-heavy, rarely-changing aggregations (e.g. monthly comparisons, category breakdowns) warrant the same treatment.
- **4.4.4 — Migration-workflow tooling.** Not urgent, but noted: the Turso migration process documented in `AGENTS.md` (offline `migrate diff` → save `migration.sql` → apply via raw `@libsql/client` → `_prisma_migrations` bookkeeping via `scripts/backfill-migration-history.ts`) has manual steps (4 and 6) that are currently run by hand each time via one-off `tsx -e '...'` scripts. Once this workflow has been repeated a few more times, consider scripting the "apply + bookkeeping-insert" combination as a single reusable command instead of a fresh one-off script per migration — reduces the chance of a step being skipped.

### 4.5 — Process constraints that apply across all of the above

- **4.5.1 — Schema changes.** Any item above that touches `prisma/schema.prisma` (4.2.3's idempotency key being the clearest case) **must** follow the process in `AGENTS.md` under "Applying schema changes to the live database (Turso)" — `prisma migrate dev`/`db push` do not work against this project's live DB (confirmed, not a config bug — see project memory `prisma_migrate_broken_turso`). That means: offline `migrate diff`, manual review, apply via raw `@libsql/client`, then `_prisma_migrations` bookkeeping. **Always confirm with the user before executing any write against the live database.**
- **4.5.2 — Real user data.** 7+ real users are on the live DB today. Rate-limit changes (4.2.x), auth changes (4.2.4, 4.2.7), and the idempotency migration (4.2.3) all touch live-traffic-affecting or schema-affecting code — these should ship behind careful review/staged rollout, not as a single big-bang PR, precisely because there's no staging environment to catch a regression first.

---

## 3. Suggested execution order

1. **Merge the in-flight branch** (section 1.1) — don't let new Phase 4 work stack on top of already-fixed findings sitting uncommitted.
2. **4.1 (Testing & CI)** — safety net first; every subsequent change is lower-risk with this in place.
3. **4.2.1, 4.2.2, 4.2.4, 4.2.6** — the cheap, low-risk security wins (headers, `max_tokens`, version pin, `server-only`). No schema changes, no behavior changes users would notice.
4. **4.2.3 (idempotency)** — the one item in 4.2 needing a schema migration; do it once CI (4.1.2) exists to catch regressions.
5. **4.2.5 (zod), 4.2.8 (proxy runbook), 4.2.7 (session lifetime)** — larger or infra/product-tradeoff items; phase in alongside normal feature work rather than as a blocking batch.
6. **4.3 (Observability & deployment)** — do once the app is stable post-4.1/4.2, since instrumentation is most valuable once there's less noise to instrument around.
7. **4.4 (Architecture evolution)** — decision checkpoints, not a fixed timeline; revisit 4.4.1 and 4.4.2 specifically when usage/scaling signals actually appear, per the thresholds noted in each item.

## 4. Exit criteria for Phase 4

- All 15 remaining open audit findings from section 1.2 are either fixed or explicitly deferred with a documented reason (SEC-9 and parts of 4.4 are expected to land in the "deferred, infra-dependent" bucket rather than "fixed").
- `npm run test` passes reliably against an isolated test database ✅ (2026-08-09), and CI enforces lint + typecheck + test on every PR (still open — 4.1.2).
- `README.md` accurately describes the current stack.
- No further findings from this audit remain in the "Confirmed Issues, ≥80% confidence" table without a resolution or an explicit, written deferral reason.

---

## 5. Progress Log

Dated, append-only record of items from this roadmap actually closed out — keep entries short; full rationale/design tradeoffs belong in the relevant workstream item above, not duplicated here.

- **T-1 (flaky `onboarding.test.ts` / live-Turso network timeout at HEAD): ✅ resolved** — 2026-08-09
  - Root cause: tests hit the real Turso DB (no test-specific datasource existed). Fixed via a local-SQLite-file test datasource through `@libsql/client`'s `file:` driver — the same driver `lib/prisma.ts` uses at runtime, so this is a faithful adapter-level test, not a mock.
  - New: `prisma/default-categories.ts`, `test/setup/test-db-path.ts`, `test/setup/global-setup.ts`.
  - Two real bugs surfaced and fixed while building this: (1) importing seed data from `prisma/seed.ts` directly also ran that file's own unawaited `main()`, racing the new setup — fixed by extracting the pure `DEFAULT_CATEGORIES` data into its own side-effect-free module; (2) the `20260802175335_...` migration already bakes in an older, differently-named `DefaultCategory` seed snapshot, so a plain `INSERT` collided on the first overlapping row — fixed by upserting (`ON CONFLICT DO UPDATE`), matching `prisma.defaultCategory.upsert()`'s own semantics.
  - Result: 33/33 files, 363/363 tests passing (up from 19 files / 254 tests at audit time), confirmed reliable across two consecutive runs. `.env`'s real Turso credentials were never touched (verified via `git diff .env`).
