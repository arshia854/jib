# Scale & cost readiness — preparing Jib for 1M daily active users

Written 2026-08-26, in response to a request to optimize the whole codebase
so it stays fast and cost-controlled at 1M daily active users (DAU). See
`docs/roadmap-status.md`'s "Phase 20" entry for the code changes made in the
same session as this doc, and this file for everything that's an
infrastructure/product decision rather than a code change.

**Scope decision the user made up front:** implement the safe, code-only
wins now (no live-DB writes, no schema changes beyond a migration-file bug
fix, no infra chosen on their behalf); write up everything that's gated on
an infrastructure decision as a doc instead of guessing. This file is that
doc.

## 1. Where Jib stands today vs. the ask

Per `docs/roadmap-status.md`'s own Phase 18/19 entries: **~60 real users**,
on a plan that assumes a **single VPS running the `Dockerfile`'s image**
(`docs/deploy-runbook.md`), with **no hosting-provider decision actually
made yet** (Phase 13.1/18's own words: "no hosting-provider decision has
been made") and the reverse-proxy `X-Real-IP` config still unconfirmed.
1M DAU is roughly a **15,000-20,000x jump** from that. Almost none of that
gap closes by editing application code — it closes by making infrastructure
decisions this repo can't make for you, several of which are prerequisites
to even estimating cost. Section 3 below is that decision list.

**One concrete discrepancy worth resolving first:** this repo has a
`.vercel/repo.json` linking it to a real Vercel project (`jibo-1hb3`), but
every other document (`AGENTS.md`, `docs/deploy-runbook.md`, the
`Dockerfile`) describes a self-managed VPS-behind-a-reverse-proxy
deployment, and neither mentions the other. Not resolved here — it wasn't
touched, and it's exactly the kind of thing worth confirming with whoever
set up that Vercel link before planning around either path, since a
serverless platform (Vercel) and a single fixed VPS have genuinely
different cost models, scaling mechanics, and — as section 3 covers — even
different answers for things like rate-limiting and DB timeouts.

## 2. What's already handled at the code level

- **Phase 17** (`docs/roadmap-status.md`) already found and fixed the one
  confirmed unbounded-growth query pattern in the codebase (`totalBalance`
  loading every transaction row ever created, in two places) and added the
  one index a real new query needed, with measured before/after numbers
  (9.7x and ~6-7x respectively on a 20,000-row seed). Re-checked this
  session, nothing new found in that category — see Phase 20's own entry.
- **AI cost is already bounded per call**, regardless of which provider
  ends up serving 1M DAU: `lib/nvidia-ai.ts` caps `max_tokens` (500 for
  structured JSON extraction, 1000 for chat replies), has a 30s timeout with
  exactly one narrowly-scoped connection-level retry, and — per Phase 17's
  re-confirmation — `parseTransactionWithAI`'s deterministic bank-SMS/known-
  merchant fast path skips the AI call entirely for a real fraction of
  transactions before any of that even matters.
- **This session added a single-flight de-dup to `getLivePrices()`**
  (`lib/prices/get-live-prices.ts`) — see Phase 20's entry for the full
  writeup. This is the one place in the codebase where many concurrent
  requests can pile onto one shared, externally-rate-limited resource (the
  nerkh.io gold/usd/bitcoin price API) at once; without it, a cache-expiry
  moment under real concurrent load would fire one nerkh.io call *per
  concurrent request* instead of one *total*. Zero behavior change for a
  single caller, fully covered by new tests.
- **This session also found and fixed a real regression**, unrelated to
  scale: the `20260825171540_add_assets` migration's SQLite table-rebuild
  for `User` (needed to add `showBalanceInAssets`) silently dropped the
  `User_role_check` CHECK constraint the previous migration had added,
  because `prisma migrate diff` rebuilds a table straight from
  `schema.prisma`, which has no way to express that hand-written
  constraint. This broke 5 tests (`lib/auth/session.test.ts`,
  `lib/data/admin-users.test.ts`) — confirmed pre-existing (reproduced
  before this session's own changes were involved at all), fixed by
  restoring the constraint in the migration file. Neither migration has
  been applied to the live Turso DB yet, so this was a local-file fix only
  — see Phase 20's entry for the full trace.

## 3. What genuinely needs an infrastructure decision

Each item: what breaks, why, the options, and — critically, matching this
project's own stated principle in `docs/roadmap-status.md`'s Phase 4 item
4.4.1 ("don't build the distributed version speculatively before the
deployment topology actually needs it") — **when to actually act**, not "do
this now."

### 3a. Hosting topology — blocks everything else

VPS+Docker (documented path) vs. the linked-but-unconfirmed Vercel project
(section 1). This is the one decision that changes the shape of every
answer below: a single VPS scales by getting a bigger box and then adding
more boxes behind a load balancer you manage; Vercel scales automatically
per-invocation but bills that way too, and changes what "a shared rate-limit
store" or "a DB timeout" even need to account for (cold starts, per-request
isolation). **Recommendation: resolve this before spending real effort on
anything else in this section** — several items below have a materially
different answer depending on it.

### 3b. Rate limiting / session store (`lib/rate-limit.ts`)

Current: an in-process `Map`, single-instance only, resets on every
restart/redeploy, already documented as such in the module's own header
comment and in roadmap item 4.4.1. This is fine for exactly one running
instance. It stops being fine **the moment more than one instance runs at
once** — which, notably, happens well before 1M DAU: even a routine
zero-downtime rolling deploy with two instances briefly overlapping makes
rate limits bypassable/inconsistent. So treat this less as a "1M users"
problem and more as a **"more than one process" problem** — the real
trigger is horizontal scaling itself, not a specific user count.

`checkRateLimit(key, rule)`'s public signature doesn't need to change for a
future Redis/Upstash-backed store — only its internal storage does — so
there's no upfront abstraction work worth doing speculatively (matching
4.4.1's own reasoning, which this doc isn't re-litigating, just reaffirming
now that "1M DAU" is on the table). Build the real swap once the hosting
decision in 3a is made and horizontal scaling is actually happening.

### 3c. The NVIDIA NIM endpoint itself

`.env.example`'s `NVIDIA_BASE_URL` (`https://integrate.api.nvidia.com/v1`)
is `build.nvidia.com`'s hosted developer/evaluation API, not a production
SLA-backed deployment — API keys from that portal carry per-key rate limits
sized for prototyping, not sustained high-volume production traffic, let
alone anything near 1M DAU. Getting real throughput at that scale needs one
of: NVIDIA's paid/enterprise NIM hosting, self-hosting the NIM microservice
on your own GPU capacity, or switching providers (`.env.example` already
keeps inert OpenRouter/ArvanCloud env vars around "in case we switch back" —
so the code's provider boundary, `lib/nvidia-ai.ts`, is already the one
place this would need to change).

**`docs/openrouter-cost-estimate.md` is now stale** — it models
`lib/openrouter.ts`, which no longer exists; the app moved to NVIDIA NIM
since that doc was written (`lib/nvidia-ai.ts`, `docs/roadmap-status.md`'s
Phase 9). Its *methodology* (measured prompt sizes from the actual
templates, an explicit fast-path-hit-rate assumption as the single biggest
cost lever, per-user-per-month usage assumptions) is still sound and worth
reusing wholesale — only the price-per-token inputs need to come from
whichever NVIDIA NIM hosting tier (or alternate provider) gets chosen for
real production traffic. Re-run it once that choice is made; don't trust
the old dollar figures in that file for a 1M-DAU decision, they're for a
different provider entirely.

### 3d. Database (Turso/libSQL)

One genuine structural advantage worth knowing: Turso/libSQL is HTTP-based,
not a TCP connection pool — so, unlike e.g. Postgres, running many app
instances doesn't risk exhausting a fixed DB connection limit. That's one
whole class of horizontal-scaling pain this stack doesn't have.

What still matters at 1M-DAU scale:
- **Turso plan tier.** Free/hobby tiers have real storage and row-read/
  write quotas that a personal-finance app logging transactions for a
  million daily users would hit fast. This is a billing decision, not a
  code change.
- **Read replicas.** `@prisma/adapter-libsql`'s own README documents Turso
  "remote replicas"/"embedded replicas" support for exactly this — reducing
  read latency for a geographically spread user base by reading from a
  nearby replica instead of always round-tripping to the primary region.
  Worth evaluating once real usage/latency data exists; not something to
  provision speculatively against a hypothetical number.
- **No query-level timeout exists anywhere in the DB access path today.**
  `lib/nvidia-ai.ts` and `lib/prices/get-live-prices.ts` both wrap their
  external HTTP calls in an explicit `AbortController`-based timeout;
  nothing does the same for Turso queries — a genuinely slow/hung response
  from the DB has nothing bounding it. **Flagged, not fixed in this pass**:
  `@libsql/client`'s HTTP transport does accept a custom `fetch`, but
  `@prisma/adapter-libsql`'s `PrismaLibSql` constructor (see
  `lib/prisma.ts`) doesn't expose that option in this installed version, so
  a real fix means either wrapping request handlers in
  `AbortSignal.timeout()` at a higher level or patching in a custom fetch —
  both are more invasive changes to the one DB client every route in the
  app depends on than this pass's "safe, contained, well-tested" bar
  allows. Worth a dedicated, carefully-tested follow-up.

### 3e. Observability cost (Sentry, logs)

- Sentry tracing is already off (`sentry.server.config.ts`/
  `instrumentation-client.ts` set no `tracesSampleRate`) — no APM/
  performance-monitoring spend today. Error events themselves are **not**
  sampled — fine at current volume; if 1M DAU ever means "one outage
  produces a huge burst of near-identical error events," a `sampleRate` (or
  Sentry's own client-side rate limiting once a real paid quota is chosen)
  is the lever, not a code restructure.
- `lib/observability/logger.ts` writes JSON lines to stdout only, no
  transport/shipping configured — correct and cheap as-is. Cost only
  appears once a real log aggregator is chosen at deploy time to actually
  tail that stdout at volume; that's an infra choice, not a gap in the code.

### 3f. CDN / static assets

Fonts are already self-hosted (`public/fonts/`), the PWA icon set is small,
and `next.config.ts`'s CSP comments confirm there are no third-party
scripts — already about as lean as this gets without a CDN in front. A CDN
mainly buys edge caching and reduced origin load at real 1M-DAU-scale
traffic, which is a consequence of the hosting decision in 3a, not a
standalone thing to bolt on now.

## 4. Recommended order, once you're actually building toward this

1. **Resolve 3a (hosting topology)** — everything else is downstream of it.
2. **Re-run a real AI cost estimate (3c)** using
   `docs/openrouter-cost-estimate.md`'s methodology against whatever NVIDIA
   NIM hosting tier (or alternate provider) you'd actually run at scale —
   don't assume the free developer endpoint survives any real growth.
3. **Move rate limiting to a shared store (3b) the moment more than one
   instance runs**, independent of total user count — this is a
   correctness fix before it's a scale fix.
4. **Add a DB query timeout (3d)** — the biggest current gap in "what
   happens when a dependency hangs," now that the AI and price-API paths
   both already have one.
5. Everything else in section 3 (read replicas, Turso plan upgrade, Sentry
   sampling, CDN) is a "when the real signal shows up" decision, not a
   "build now" one — consistent with this project's own stated principle
   for exactly this kind of item (`docs/roadmap-status.md`'s 4.4.1/4.4.2).

## Do not claim

This doc does not claim Jib is "ready for 1M DAU" — almost nothing here is
a code problem, and the gap from ~60 real users to that number is
overwhelmingly an infrastructure/budget decision this repo can't make on
its own. It does not claim the two code changes in section 2 (single-flight
price fetch, the migration fix) meaningfully move the needle on 1M-DAU
readiness by themselves — they're real, contained, well-tested fixes for
gaps that would matter regardless of final scale, not a scale solution. It
does not estimate a dollar figure for running Jib at 1M DAU — every input
that number would need (hosting plan, Turso tier, AI provider/tier) is an
open decision in section 3, and a number built on guessed inputs would be
actively misleading for a financial-app budget decision.
