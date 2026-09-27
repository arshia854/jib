# Jib Roadmap Status

Single source of truth for Phase 4 progress going forward. The Progress Log below starts as a verbatim copy of §5 of `فاز ۴ Jib — Production Hardening & Architecture Evolution Roadmap.md`; new entries are appended here from now on instead of in that file.

---

## Progress Log

Dated, append-only record of items from this roadmap actually closed out — keep entries short; full rationale/design tradeoffs belong in the relevant workstream item above, not duplicated here.

- **T-1 (flaky `onboarding.test.ts` / live-Turso network timeout at HEAD): ✅ resolved** — 2026-08-09
  - Root cause: tests hit the real Turso DB (no test-specific datasource existed). Fixed via a local-SQLite-file test datasource through `@libsql/client`'s `file:` driver — the same driver `lib/prisma.ts` uses at runtime, so this is a faithful adapter-level test, not a mock.
  - New: `prisma/default-categories.ts`, `test/setup/test-db-path.ts`, `test/setup/global-setup.ts`.
  - Two real bugs surfaced and fixed while building this: (1) importing seed data from `prisma/seed.ts` directly also ran that file's own unawaited `main()`, racing the new setup — fixed by extracting the pure `DEFAULT_CATEGORIES` data into its own side-effect-free module; (2) the `20260802175335_...` migration already bakes in an older, differently-named `DefaultCategory` seed snapshot, so a plain `INSERT` collided on the first overlapping row — fixed by upserting (`ON CONFLICT DO UPDATE`), matching `prisma.defaultCategory.upsert()`'s own semantics.
  - Result: 33/33 files, 363/363 tests passing (up from 19 files / 254 tests at audit time), confirmed reliable across two consecutive runs. `.env`'s real Turso credentials were never touched (verified via `git diff .env`).

- **T-1 fix, isolated session note** — 2026-08-09
  - Confirming the above from a separate session: the flaky `onboarding.test.ts` failure (live-Turso network timeout) is resolved via the same local-SQLite-file test datasource (`@libsql/client`'s `file:` driver — the same driver `lib/prisma.ts` uses at runtime, so an adapter-level test rather than a mock). New files: `prisma/default-categories.ts`, `test/setup/test-db-path.ts`, `test/setup/global-setup.ts`, plus `vitest.config.ts` changes to wire the override in. Result: 33/33 files, 363/363 tests passing (up from 19/254).

- **Phase 4.1 audit — route-by-route input-limit review (read-only): ✅ done** — 2026-08-09
  - Scope: all 17 handlers under `app/api/**/route.ts`, checked for body-size/string-length/pagination limits.
  - **Routes missing limits:** transactions POST/PATCH (`categoryName`/`description`/`rawInput` no max length); transactions GET (`listTransactions()` has no `take`/skip/cursor — full history every call); accounts POST/PATCH (`name` no max length); categories + admin/default-categories POST/PATCH (`name`/`icon` no max length, `color` is hex-bounded); chat POST (`message` unbounded, stored and sent to LLM at full length); transactions/parse POST (`text` unbounded before AI parsing); auth/register POST (`password` has a min of 8, no max). Already-bounded and fine: onboarding's `name`/`age`, facts' enum-checked `key`/`value`, log-error's DB-side-sliced `message`/`stack`.
  - **4 focused findings:** (1) chat `message` has no input-side length cap — pairs with the already-tracked SEC-6 output `max_tokens` cap (4.2.2); (2) `transactions/parse`'s `text` has the same gap; (3) `GET /api/transactions` has zero pagination, will degrade with history size; (4) free-text fields (transaction `description`/`rawInput`/`categoryName`, account `name`, category `name`/`icon`) have no max length, inconsistent with onboarding's own `name.length > 60` precedent.
  - **Not yet in roadmap:** add pagination/cursor to `GET /api/transactions`; add max-length validation to the free-text fields above (fits the planned 4.2.5 Zod rollout); add input-side length caps to chat `message` and parse `text` (complements SEC-6); no global request body-size limit is explicitly configured anywhere — currently just the Next.js framework default.

- **Phase 4.1 follow-up — length limits on free-text/string route fields: ✅ done** — 2026-08-09
  - Scope: findings (2) and (4) from the audit above (chat `message` and `GET /api/transactions` pagination are explicitly separate subtasks, untouched here). Zod isn't in `package.json`, so this is plain TypeScript `.length` checks, matching the existing hand-rolled validation style already in these routes — no new dependency added.
  - New: `lib/limits.ts` — one shared module for the max-length constants, so the same field concept (a "name", the pasted-text/SMS blob, ...) isn't bounded by a different, drifting number in each route:
    - `MAX_TRANSACTION_TEXT_LENGTH = 500` — the one genuinely researched number here, since eyeballing a Persian bank SMS length would've been a guess. Persian isn't in the GSM-7 alphabet, so bank SMS always sends as UCS-2: 70 chars for a single segment, ~67 chars/segment once concatenated (3 reserved for the concatenation header). Carriers/devices reassemble concatenated SMS reliably up to roughly 6-8 segments in practice before segments start getting dropped or delivered out of order ([Twilio](https://www.twilio.com/docs/glossary/what-sms-character-limit), [Concatenated SMS — Wikipedia](https://en.wikipedia.org/wiki/Concatenated_SMS)). 8 segments x 67 chars ~= 536, rounded down to a clean 500 — already ~4x every real bank-SMS fixture in `lib/bank/*.test.ts` (longest observed: 113 chars).
    - `MAX_DESCRIPTION_LENGTH = 200`, `MAX_NAME_LENGTH = 60` (matches the existing onboarding `name.length > 60` precedent), `MAX_ICON_LENGTH = 32` (generous multiple of the categories UI's existing `maxLength={4}` input cap, to tolerate multi-codepoint emoji), `MAX_EMAIL_LENGTH = 254` (RFC 5321's practical email-address bound), `MAX_PASSWORD_BYTES = 72`.
  - Changed: `app/api/transactions/parse/route.ts` (`text`), `app/api/transactions/route.ts` POST (`rawInput`, `description`, `category`), `app/api/transactions/[id]/route.ts` PATCH (`description`, `category` — it has no `rawInput` field to begin with, so nothing to cap there), `app/api/accounts/route.ts` POST and `app/api/accounts/[id]/route.ts` PATCH (`name`), `app/api/categories/route.ts` POST and `app/api/categories/[id]/route.ts` PATCH (`name`, `icon`, `parentName`), `app/api/auth/register/route.ts` (`email`, `password`).
  - Every violation reuses the route's pre-existing `{ error: string }` / 400 shape — mostly by folding the new `.length` check into the same catch-all `if` the route already had (e.g. transactions' "اطلاعات تراکنش ناقص یا نامعتبر است."), except accounts/[id] and categories/[id] PATCH: their pre-existing pattern silently drops an invalid field from the partial-update payload rather than rejecting the request, which doesn't fit "reject on violation" — those two got an explicit early length check instead, before that field-collection logic runs.
  - Password gets a `Buffer.byteLength(password, "utf8")` check, not `.length` — bcryptjs truncates at 72 *bytes* silently, and Persian text/emoji can hit 72 bytes well before 72 characters, so a character-count check would let two different passwords collide onto the same hash past that point.
  - Tests: extended `app/api/categories/route.test.ts`; added `app/api/categories/[id]/route.test.ts`, `app/api/accounts/route.test.ts`, `app/api/accounts/[id]/route.test.ts`, `app/api/transactions/route.test.ts`, `app/api/transactions/[id]/route.test.ts`, `app/api/transactions/parse/route.test.ts`, `app/api/auth/register/route.test.ts` — each covers a reject-over-limit case and an accept-exactly-at-limit case per field, following the existing route-test pattern (mocked session, real local-SQLite DB). `transactions/parse`'s tests use a real bank-SMS fixture (from `lib/bank/parse-bank-sms.test.ts`) padded to exactly the limit, confirming `parseBankSms` still resolves it correctly (no AI/network call needed either way).
  - Result: `npx tsc --noEmit` clean; full suite 40/40 files, 387/387 tests passing (up from 33/363), including every pre-existing bank-SMS/Persian-text fixture unchanged.

- **Phase 4.1 follow-up #2 — chat `message` input cap + SEC-6 LLM `max_tokens` output cap (4.2.2): ✅ done** — 2026-08-09
  - Scope: finding (1) from the audit above (chat `message` has no input-side length cap) plus the already-tracked SEC-6/4.2.2 item (no `max_tokens` on either NVIDIA NIM call site). Explicitly excluded: `transactions/parse`, `accounts`, `categories` routes - those were Phase 4.2 and are already done (see the entry above).
  - **`app/api/chat/route.ts`:** added `MAX_CHAT_MESSAGE_LENGTH = 4000` to `lib/limits.ts` and a length check (same generic-400 shape as every other route here: `{ error: "پیام بیش از حد طولانی است." }`). Deliberately a separate, larger ceiling than the file's own `HISTORY_MESSAGE_CHAR_CAP` (800), not a reuse of it: that 800 figure exists to bound the *compounding* cost of up to 16 stored history messages riding in one prompt at once (16 x 800 = 12,800 worst case), and explicitly excludes the current turn for exactly this reason. The current message appears exactly once per request, so truncating/rejecting it at the same tight per-message budget would cut off the one piece of content the request exists to convey, for a cost saving that (unlike the history case) isn't multiplied across 16 messages. 4000 is sized instead as "comfortably larger than any legitimate single chat turn" - many times longer than a typed sentence or even a pasted bank SMS (`MAX_TRANSACTION_TEXT_LENGTH = 500`) - while still rejecting a pathological wall-of-text paste well short of unbounded.
  - **`lib/nvidia-ai.ts` (SEC-6):** added `max_tokens` to the request body at both `callNvidiaAI()` call sites, with two different values rather than one blanket number, since the two call sites' expected output shapes genuinely differ:
    - `chatCompletion()` (used by both `lib/ai/parse-transaction.ts`'s extraction call and `lib/ai/detect-transaction-intent.ts`'s intent-detection call) → `JSON_EXTRACTION_MAX_TOKENS = 500`. Both callers only ever ask for compact structured JSON with individually-short fields (`description` capped at ~5 words by the prompt itself, `category`/`subcategory` are single existing category names, `reason` is "one short sentence", `newCategorySuggestion` is a small optional object; the intent-detection schema is smaller still - just `{"isPastUnloggedTransaction": boolean}`). 500 is well above any legitimate response in either shape while still actually bounding a runaway/pathological completion.
    - `streamChatCompletion()` (used by `app/api/chat/route.ts`) → `CHAT_REPLY_MAX_TOKENS = 1000`. Produces free-form Persian conversational prose instead of compact JSON - the system prompt asks for "دوستانه، مختصر و کاربردی" (concise, practical), but prose still naturally runs longer than a JSON object with 5-word fields. 1000 leaves room for a multi-sentence answer (including a short spending breakdown) without leaving the cap so high it stops meaningfully bounding a single reply's cost.
    - Field name confirmed as `max_tokens` (not `max_completion_tokens`, which is an OpenAI-specific alias for their newer reasoning-model line) via NVIDIA NIM's own quickstart and `llama3-70b-instruct` model-card curl examples - NIM's OpenAI-compatible endpoint is built on vLLM's OpenAI-compatible server, which uses `max_tokens`.
  - Tests: new `lib/nvidia-ai.test.ts` (mocks global `fetch` per the existing `lib/sms/melipayamak.test.ts` convention - a real local SQLite DB isn't relevant here, there's no DB involved), asserting the exact `max_tokens` value each call site sends, that it's strictly larger for `streamChatCompletion` than `chatCompletion`, and that it's additive alongside the pre-existing `response_format`/`stream` fields rather than replacing them. Extended `app/api/chat/route.test.ts` with a reject-over-limit case (400, no DB write, no AI call) and an accept-exactly-at-limit case confirming the message reaches `streamChatCompletion` and gets persisted completely unmodified/untruncated at exactly 4000 chars.
  - Result: `npx tsc --noEmit` clean; full suite 41/41 files, 392/392 tests passing (up from 40/387).

- **Phase 4.1 follow-up #3 — pagination for `GET /api/transactions` (finding 3); `accounts`/`categories` evaluated and skipped: ✅ done** — 2026-08-09
  - Scope: finding (3) from the audit above (`GET /api/transactions` has zero pagination), the audit's own "Not yet in roadmap" note ("add pagination/cursor to `GET /api/transactions`"), plus evaluating the same fix for `GET /api/accounts`/`GET /api/categories` per the roadmap's "do not add indiscriminately" principle - explicitly extended to pagination, not just DB indexes. Excluded: `transactions/parse`, `chat`, `accounts` POST/PATCH validation (separate, already-done subtasks).
  - **Caller audit first, before touching any response shape:** searched every frontend `fetch(...)` call against all three GET endpoints. None of the three has a single frontend `fetch` caller - `app/app/transactions/page.tsx`, `app/app/settings/accounts/page.tsx`, and `app/app/settings/categories/page.tsx` are server components that call `listTransactions()`/`listAccountsWithUsage()`/`listCategoriesWithUsage()` directly, bypassing the HTTP routes entirely (every actual `fetch("/api/transactions"...)`/`fetch("/api/accounts"...)`/`fetch("/api/categories"...)` in the codebase is a POST or DELETE, never a GET). So reshaping `GET /api/transactions`'s JSON response breaks no live frontend consumer today. `listTransactions()` itself does have a second caller though - that same transactions page - which does need updating for the new signature/return shape, and was.
  - **`lib/data/transactions.ts`:** `listTransactions(userId, filters, page, pageSize)` now returns `{ transactions, page, pageSize, total, totalPages }` instead of a bare array. `page`/`pageSize`, not raw `take`/`skip`, to match the pagination idiom `lib/data/admin-users.ts`/`lib/data/admin-logs.ts` already established (`PaginatedResult<T>`-shaped) - `skip`/`take` (`skip = (safePage - 1) * safePageSize`) is still exactly what reaches Prisma underneath, `orderBy: { date: "desc" }` unchanged, and `total`/`totalPages` come from a `prisma.transaction.count()` sharing the exact same `where` object as the `findMany` (run in parallel via `Promise.all`). One deliberate departure from the admin precedent: `pageSize` is hard-clamped to `MAX_TRANSACTIONS_PAGE_SIZE` inside `listTransactions()` itself - admin's version never had this because it never exposes `pageSize` to a caller at all, so nothing there needed a ceiling. `DEFAULT_TRANSACTIONS_PAGE_SIZE` (20) / `MAX_TRANSACTIONS_PAGE_SIZE` (100) went into `lib/limits.ts` rather than a local per-file constant like admin's own `DEFAULT_PAGE_SIZE` - two different files need the identical numbers here (the route's query-param parsing and this function's own defensive clamp), the same reason the length ceilings already in that file are shared instead of drifting per-route constants.
  - **`app/api/transactions/route.ts` GET:** parses `?page=`/`?pageSize=` with the same defensive parse-or-fallback already used for `page` in `app/app/admin/users/page.tsx` - non-numeric/zero/negative silently falls back to the default rather than 400ing (a deliberate departure from this same route's own content-field length checks just above, which do reject: these are paging/control params, not user content). Response is `NextResponse.json(result)` → `{ transactions, page, pageSize, total, totalPages }` - `transactions` keeps its exact pre-existing key and position, the rest are new siblings.
  - **`app/app/transactions/page.tsx`:** updated for the new return shape, plus two things needed so real pagination doesn't leave this particular page broken given it already supports deleting items: (1) added `<PaginationControls>` so pages past the first are actually reachable rather than silently unreachable; (2) a requested page past the last one (most reachable by deleting the last transaction(s) while on the last page - `transaction-list-item.tsx`'s delete does `router.refresh()` against that same URL) now redirects back to the real last page instead of rendering a confusing "no transactions" empty state.
  - **`components/admin/pagination-controls.tsx`:** reused rather than duplicated for the transactions page's prev/next UI - extended with an optional `queryParams` prop so active filters survive page navigation. Its two existing admin callers (`app/app/admin/users/page.tsx`, `app/app/admin/logs/page.tsx`) pass none, so their rendered links are unchanged (verified both call sites still only pass `basePath`/`page`/`totalPages`).
  - **`components/transactions/transaction-filter-bar.tsx`:** changing a filter now also drops any `page` param from the URL - new pagination interacting with the pre-existing filter bar meant a filter change could otherwise leave the URL pointing at a now-out-of-range page of the newly-filtered set.
  - **`GET /api/accounts` / `GET /api/categories`: evaluated, left unpaginated.** `FinanceAccount` rows are a user's own bank/cash accounts - bounded by how many real financial accounts a person has (single digits in virtually every realistic case), with no per-transaction growth vector at all. `Category` starts at 28 seeded `DefaultCategory` rows per new user and otherwise only grows through explicit, one-at-a-time creation: the `source: "ai-suggestion"` path is already hard-rate-limited to `MAX_CATEGORIES_PER_24H = 10`/rolling 24h (`app/api/categories/route.ts`), and the `source: "manual"` path (Settings → Categories form), while not server-rate-limited, requires deliberate repeated manual UI action rather than growing automatically the way transactions do (one row per logged purchase, forever, often several a day). Neither resembles the actual driver of the transactions finding. Skipped per the roadmap's own principle - also confirmed neither endpoint has a frontend caller either (same caller audit as above), so there's no live pressure on either query today regardless.
  - Tests: `lib/data/transactions.test.ts` - new `listTransactions (pagination)` (default page/size + `date desc` ordering, page 2 remainder, out-of-range `page` clamps to 1, filters compose correctly with `total`/`totalPages`) and `listTransactions (hard max page size)` (separate fixture, `MAX_TRANSACTIONS_PAGE_SIZE + 5` rows via `createMany`, proves an oversized requested `pageSize` is actually capped at the DB-query level, not just reflected back as a smaller number in the response). `app/api/transactions/route.test.ts` - new `GET /api/transactions - pagination` (401, defaults, `?page=2`, invalid `?page` values, `?pageSize` clamp, `orderBy` preserved end-to-end through the JSON response) - GET had zero test coverage before this change.
  - Verification: `npx tsc --noEmit` clean. Full suite 41/41 files, 403/403 tests passing (up from 41/392). Frontend rendering verified statically rather than via a live dev server: traced every consumer of the changed shape (`app/app/transactions/page.tsx` and everything under `components/transactions/`) end-to-end against the new types, backed by `tsc`'s whole-chain type-checking (the page destructures `listTransactions()`'s return directly, so a shape mismatch there would be a compile error, not a runtime-only surprise) plus the adapter-level test suite (same real `@libsql/client` driver path `lib/prisma.ts` uses at runtime, per the T-1 fix above). Deliberately did not run `next dev` for this step - it connects straight to the live Turso DB per `.env` (no local-DB dev script exists, unlike the test suite's isolated `file:` datasource via `test/setup/`), and manually seeding 20+ transactions through it just to visually trigger pagination wasn't worth that risk given the static/typed verification already available.

- **4.1.2, 4.1.3, 4.2.1, 4.2.4, 4.2.6, 4.3.3 - the cheap/low-risk batch from §3's suggested execution order: ✅ done** - 2026-08-15
  - **4.1.2 (CI, T-2):** new `.github/workflows/ci.yml` - `npm run lint`, `npx tsc --noEmit`, `npm run test` on every PR/push-to-main/manual dispatch, Node 22, `permissions: contents: read`. Needed dummy `AUTH_SECRET`/`OTP_SECRET`/`LEGACY_SESSION_SECRET`/`NVIDIA_*` values in the workflow's own `env:` - not real secrets, just non-empty strings so `lib/auth/otp.ts`/`lib/auth/session.ts`'s "not configured" checks don't throw during the auth test suite (Turso vars aren't needed at all - `vitest.config.ts` already overrides those unconditionally to the isolated local SQLite file regardless of `env`).
  - **4.1.3 (README, CQ-1):** tech-stack and getting-started sections corrected to the real stack (Turso/libSQL via `@prisma/adapter-libsql`, NVIDIA NIM) instead of the pre-migration SQLite/OpenRouter description; getting-started no longer tells a new contributor to run `npx prisma migrate dev` (confirmed broken against this project's DB - see `AGENTS.md`), replaced with the actual Turso-CLI credential flow plus a note that `npm run test` never needs any of that (isolated local-SQLite datasource, per T-1). Also fixed the two lingering "OpenRouter" mentions in the project-structure route table and the `lib/openrouter.ts` → `lib/nvidia-ai.ts` rename, the AI-model note (`OPENROUTER_MODEL` → `NVIDIA_MODEL`, updated default model name), and dropped two stray trailing "# jibo" lines. Left the SQLite mention in the "Notes and assumptions" section as-is (Turso *is* SQLite/libSQL-compatible storage, so that one wasn't actually wrong) and left the project-structure diagram's route list otherwise as found - keeping this to the stale-stack claims the audit (CQ-1) actually flagged, not a full re-audit of every route added since.
  - **4.2.1 (security headers, SEC-1/SEC-11):** `next.config.ts` now sets `poweredByHeader: false` plus a `headers()` block (`source: "/(.*)"`, applied alongside the pre-existing `/sw.js`-only block - no key collision, both apply) with `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Strict-Transport-Security`, and a CSP. Went with a static CSP (no nonce) per the roadmap's own suggestion given no third-party scripts/self-hosted font - avoids forcing every route to dynamic rendering and a `proxy.ts` rewrite that a nonce would require. `style-src` needed `'unsafe-inline'`: the app sets inline `style={{...}}` in several places (category color dots in `components/dashboard/category-breakdown.tsx`, `components/reports/CategoryComparisonBar.tsx`, etc.) which CSP's `style-src` governs same as `<style>` tags - confirmed via `grep` (11 call sites across 7 files) before deciding this, rather than shipping a CSP that would've silently broken those colors. Verified for real, not just by reading the header block: built (`next build`, Turbopack, clean) and booted with `next start`, then `curl -sD -` against `/` and `/sw.js` - all headers present with the expected values, `X-Powered-By` absent, `/sw.js`'s own `Content-Type`/`Cache-Control` still intact alongside the new security headers.
  - **4.2.4 (pin next-auth, SEC-4):** `package.json`'s `"next-auth": "^5.0.0-beta.32"` → `"5.0.0-beta.32"` (no caret). `npm install --package-lock-only` to sync `package-lock.json`'s own recorded range to match (confirmed via `grep` - no other change to the resolved/installed version, since beta.32 was already what was installed).
  - **4.2.6 (`server-only` guard):** added the `server-only` package and `import "server-only";` as the first line of all 15 non-test modules across `lib/auth/*` and `lib/data/*`. Checked every one of the 15 for a client-component importer first (`grep` across `app/`/`components/` for each module's `@/lib/...` specifier) - the only hit was `components/admin/user-row.tsx` importing `type { UserRole }` from `lib/auth/session.ts`, a type-only import that's erased at compile time and carries no runtime reference to the module, so it's unaffected (matches the roadmap's "audit found none" expectation - the one apparent hit isn't a real one).
    - **Real bug this surfaced, not anticipated by the roadmap item:** `server-only`'s no-op behavior only kicks in under Next's own webpack/Turbopack build, which resolves the package to an empty module via a `"react-server"` export condition on the server compiler graph. Vitest's plain Node resolution never sets that condition, so it fell through to the package's `default` export - which unconditionally throws `"This module cannot be imported from a Client Component module"` - breaking every test file that imports any of the 15 modules (15 of 41 test files failed, 15 file-level failures, 0 assertion failures - i.e. the modules never even finished loading). Fixed with the same workaround as Next's own official Jest docs (`'server-only': '<rootDir>/__mocks__/empty.js'`), adapted to Vitest: `vitest.config.ts`'s `resolve.alias` now points the `"server-only"` specifier straight at `node_modules/server-only/empty.js` - deliberately an alias scoped to that one package, not a blanket `resolve.conditions: ["react-server"]` for the whole test run, since the latter would also silently change how every *other* package with a `"react-server"` export condition resolves (react, react-dom, next-auth, ...) for no reason this fix actually needs.
  - **4.3.3 (bundle splitting, perf finding) - partially applied, rest evaluated and skipped with a documented reason:**
    - **Applied:** `next/dynamic` (aliased `nextDynamic` to avoid colliding with each file's own `export const dynamic = "force-dynamic"` route-segment config) around the two heaviest Client Components under `/app/admin` - `DefaultCategoriesManager` (~340 lines, `app/app/admin/categories/page.tsx`) and `UserDangerZone` (`app/app/admin/users/[id]/page.tsx`) - each with a `loading` fallback built from the existing `components/skeleton.tsx` convention already used by every other route's `loading.tsx`. Real, if narrow, motivation: unlike virtually every other route (`app/app/*/loading.tsx`), the admin routes have no `loading.tsx` of their own, so this at least gives these two pages an equivalent skeleton during hydration instead of a blank gap.
    - **Not applied, by design: `components/reports/*` and `components/dashboard/category-donut.tsx`/`category-breakdown.tsx`.** Verified directly (not assumed) that wrapping these would be a pure no-op: (1) confirmed via `grep` that none of them have a `"use client"` boundary anywhere in the tree - they're 100% Server Components, and per Next's own lazy-loading guide, "Lazy loading applies to Client Components" - a dynamically-imported Server Component with no client children ships the same zero bytes of client JS either way; (2) both consuming pages (`app/app/page.tsx`, `app/app/reports/page.tsx`) already `await` all their data *before* returning JSX, so the presentational component receives already-resolved props - there's no pending async work left for a `dynamic()`+Suspense boundary to defer, unlike the admin case above; (3) `app/app/reports/loading.tsx` (and `app/app/loading.tsx` for the dashboard) already give the whole page a route-level Suspense/skeleton boundary covering this exact window, so a second, nested one around the already-resolved child would be dead code - a `loading` fallback that can structurally never render. Also verified empirically, not just via the docs' prose, that the underlying "ships in the initial bundle for every user" premise for the *admin* half of this item doesn't hold today either way: built the app and diffed `.next/server/app/app/admin/categories/page_client-reference-manifest.js` against `.../app/page_client-reference-manifest.js` - `DefaultCategoriesManager`'s client chunk is referenced only by the admin route's manifest, not the dashboard's, confirming Next's automatic per-route code splitting was already excluding it from non-admin bundles before this change.
  - **Verification (all six together):** `npm run lint` clean (pre-existing warnings only, unrelated), `npx tsc --noEmit` clean, `npm run test` 41/41 files / 403/403 tests passing (same count as before - this batch didn't add or change any test), `next build` (Turbopack) clean, and a real `next start` + `curl` check of the security headers (see 4.2.1 above). `.env`'s real Turso credentials were never touched.

- **Phase 5 - Financial Domain Hardening: ✅ done (5.1, 5.3); 5.2 reviewed, no change needed** - 2026-08-16
  - **5.2 (account integrity) - audited, not modified:** `deleteAccount`/`deleteCategory` already refuse to delete anything with existing transactions (`AccountInUseError`/`CategoryInUseError` in [lib/data/accounts.ts](../lib/data/accounts.ts)/[lib/data/categories.ts](../lib/data/categories.ts)), and `Transaction.accountId`/`categoryId` are both `onDelete: Restrict` at the schema level - deleting or editing an account/category cannot silently orphan or corrupt transaction history today. No gap found, so no code changed here.
  - **5.1 (transfer semantics) - real bug fixed:** `Category.isTransfer` has existed in the schema and admin category CRUD since before this roadmap, but was never actually read anywhere - every income/expense aggregate (`lib/analytics/spending-summary.ts`'s `currentMonth`/`previousMonth`/`topMerchants`, `lib/data/dashboard.ts`'s `monthIncome`/`monthExpense`/`categoryBreakdown`, `lib/reports/monthly-comparison.ts`'s `sumExpensesByCategory` and everything built on it - `today-spending.ts`, `generate-highlights.ts`) summed every transaction by `type` alone, so a transfer between a user's own accounts would have inflated income or expense exactly as the roadmap warned. Fixed by excluding `category.isTransfer` at the Prisma query level (`category: { isTransfer: false }` in the relevant `where` clauses) rather than filtering in each downstream function separately - one relation-filter idiom already used elsewhere in the codebase (`lib/facts/infer-facts.ts`), applied at the three query sites, so every current and future consumer of those lists is correct by construction. `totalBalance` (both `spending-summary.ts` and `dashboard.ts`) deliberately keeps transfers included - a transfer still moves real money between real account balances, it's only the "how much did I earn/spend" aggregates that must exclude it. No default/seeded category currently has `isTransfer: true` (checked `prisma/default-categories.ts`), so this was a latent bug reachable only via the admin default-categories screen, not something affecting current production data.
  - **5.3 (mutation safety) - real bug fixed:** `SpendingSummaryCache` (previous-month cache used by the chat assistant's financial context) was never invalidated on transaction mutation, and `PATCH`/`DELETE /api/transactions/[id]` place no restriction on editing/deleting a transaction dated in a past (already-cached) month - so correcting an old transaction's amount/category/date, or deleting one, left that month's cached income/expense/category totals silently wrong forever (the cache row never expires). Fixed with a new `invalidateSpendingSummaryCache(userId, date)` in [lib/analytics/spending-summary.ts](../lib/analytics/spending-summary.ts) (best-effort delete of the matching `{userId, monthKey}` row, same `.catch(() => {})` pattern as the existing cache write), called from `createTransaction` (new date), `deleteTransaction` (deleted row's date), and `updateTransaction` (both old and new date, since either can move across a month boundary) in [lib/data/transactions.ts](../lib/data/transactions.ts). Audit timestamps (`createdAt`/`updatedAt`) were already present and adequate; soft deletion/immutable history was evaluated and deliberately not added - nothing in the current product surfaces a "deleted transaction" or "edit history" view, so it would be unused persisted state, not a real gap the roadmap's "implement only what is justified" would support.
  - **Explicitly not touched:** idempotency protection on transaction creation (double-submit risk, originally SEC-10 in `security-audit-report.md`) - real but a distinct concern from the three 5.1/5.3 items above, deliberately left out of this pass to keep the change set to exactly what Phase 5 asked for.
  - Tests: `lib/analytics/spending-summary.test.ts` - two new fixtures/tests (`isTransfer` transactions excluded from income/expense/categories/discretionaryExpense/topMerchants while still counted in `totalBalance`; `invalidateSpendingSummaryCache` forces a recompute instead of serving a stale cached previous month). `lib/reports/monthly-comparison.test.ts` - one new transfer category/transaction in the shared fixture plus an explicit exclusion test. `lib/data/transactions.test.ts` - new `transaction mutations invalidate SpendingSummaryCache` describe block (4 tests: create/delete/update-across-months/update-same-month-leaves-other-caches-alone). `lib/data/dashboard.test.ts` - new file (had zero test coverage before this), 2 tests mirroring the spending-summary transfer case for `getDashboardData`.
  - Verification: `npx tsc --noEmit` clean. Full suite 42/42 files, 412/412 tests passing (up from 41/403). `npm run lint` clean (same 2 pre-existing, unrelated warnings as before this change - confirmed via `git stash`). No live-database writes; `.env`'s real Turso credentials were never touched.

## Phase 12 Audit — Observability (Sub-task 12.0, read-only) — 2026-08-16

Read-only audit per the Phase 12 implementation prompt. No code changed in this pass. **Two discrepancies found that the prompt asks to stop and report on (see "Discrepancies" at the end) before 12.1 starts.**

### 1. Existing `console.log`/`console.error`/`console.warn` call sites

Exactly 5, across `app/api/**` and `lib/**` (excluding `.test.ts`):

- [lib/auth/otp.ts:72](../lib/auth/otp.ts#L72) - `console.error`, Melipayamak not configured in production (fail-closed path).
- [lib/auth/otp.ts:75](../lib/auth/otp.ts#L75) - `console.log`, dev-only mock-SMS fallback - **logs the real OTP code** (`` `[mock SMS] OTP for ${phone}: ${code}` ``), but only ever reached outside production (see line 71's `NODE_ENV === "production"` branch above it). Worth the redaction function (12.1) being aware this pattern exists, even though it's dev-only today.
- [lib/auth/otp.ts:81](../lib/auth/otp.ts#L81) - `console.error`, Melipayamak send failure (message only, not the code).
- [lib/error-log.ts:28](../lib/error-log.ts#L28) - `console.error`, last-resort log when the DB write inside `logError()` itself fails (see §3 below - deliberately swallows so a logging failure can't mask the original error).
- [lib/ai/parse-transaction.ts:242](../lib/ai/parse-transaction.ts#L242) - `console.error`, dev-only guard (`NODE_ENV === "production"` returns early first) warning that a hardcoded fallback category name no longer matches the seeded categories.

None of these are on a hot path in production in a way that would spam stdout - 3 of 5 are error conditions, 1 is dev-only mock SMS, 1 is dev-only drift-detection.

### 2. Runtime map (Edge vs Node.js)

**Everything in this codebase runs on the Node.js runtime. There is no Edge runtime in use or available to use unintentionally.**

- `grep -rn "runtime\s*=\s*[\"']edge[\"']"` and `grep -rn "export const runtime"` across `app/`, `lib/`, and the proxy file: **zero matches**. No route or layout declares a runtime at all, so every one of the 18 `route.ts` handlers under `app/api/**` uses the framework default, which is `'nodejs'` (confirmed against `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.md`: *"`'nodejs'` (default)"*).
- **This project's Next.js has renamed `middleware.ts` to `proxy.ts`** (per this version's breaking changes - see `AGENTS.md`'s standing note to check `node_modules/next/dist/docs/` before writing code). The file is [proxy.ts](../proxy.ts) at the repo root, exporting `proxy(request)` + a `config.matcher` covering `/app/:path*`, `/onboarding`, `/login`, `/verify`, `/api/:path*` - i.e. it already runs in front of every API route. Confirmed via `node_modules/next/dist/docs/.../proxy.md`'s own "Runtime" section: *"Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."* (and the version-history table there: *"`v16.0.0` - Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime"*).
- **Consequence for 12.2:** `AsyncLocalStorage` is safe to use unconditionally, in `proxy.ts` and in every route handler - there is no Edge exception to carve out for this phase. The prompt's own instruction to fall back to explicit `requestId` param-passing for Edge routes does not apply anywhere in this codebase today.
- **Consequence for 12.2 file scope:** the request-ID middleware sub-task must edit the existing `proxy.ts`, not create a new `middleware.ts` - a second file wouldn't even be picked up by this Next.js version (single-proxy-file convention), and `proxy.ts` already exists and already runs on every `/api/:path*` request, so request-ID capture/response-header-setting belongs inside its existing `proxy()` function alongside the current rate-limit/session logic, not a separate middleware layer.

### 3. Existing error-monitoring / logging state

- **No Sentry.** `@sentry/nextjs` (or any `@sentry/*` package) is not in `package.json`. No `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, or `instrumentation.ts` exist anywhere in the repo (`find . -iname "sentry*"` / `-iname "instrumentation*"`, excluding `node_modules`: zero results both).
- **No structured-logging library.** `pino`, `winston`, `bunyan`, etc. are absent from both `dependencies` and `devDependencies` - the full current list is `@auth/prisma-adapter`, `@fontsource-variable/vazirmatn`, `@libsql/client`, `@prisma/adapter-libsql`, `@prisma/client`, `bcryptjs`, `jalaali-js`, `jose`, `next`, `next-auth`, `prisma`, `react`, `react-dom`, `server-only` (deps) plus standard tooling (devDeps) - `pino` really is net-new, matching the prompt's assumption.
- **However, a bespoke DB-backed error log already exists and is live today - not mentioned anywhere in the Phase 12 prompt:**
  - `ErrorLog` Prisma model ([prisma/schema.prisma:249-264](../prisma/schema.prisma#L249-L264)): `id`, `timestamp`, `route`, `message`, `stack?`, nullable `userId` (`SetNull` on user delete), indexed on `timestamp` and `userId`.
  - [lib/error-log.ts](../lib/error-log.ts): `logError({ route, message, stack, userId })` - truncates each field (200/2000/8000 chars) and inserts a row; deliberately swallows its own failure (`catch` → `console.error`, see §1) so a logging call can never itself crash the handler around it.
  - **Only 3 call sites today**, all pre-existing (none added by this audit): [app/api/auth/send-otp/route.ts:29](../app/api/auth/send-otp/route.ts#L29) (Melipayamak SMS-send failure - this is in fact the *only* current instrumentation of the SMS provider, see §5), [app/api/transactions/parse/route.ts:51](../app/api/transactions/parse/route.ts#L51) (AI parse failure), and [app/api/log-error/route.ts:19](../app/api/log-error/route.ts#L19) (a dedicated unauthenticated-reachable POST endpoint that lets *client-side* React error boundaries persist a message/stack, since the browser can't reach Prisma directly).
  - A read-only admin viewer already exists on top of this: [lib/data/admin-logs.ts](../lib/data/admin-logs.ts)'s `listErrorLogsForAdmin()` (paginated, newest-first, joins `user { id, name, phoneNumber }`) rendered at `app/app/admin/logs/page.tsx`.
  - **Every other route's `catch` block** (accounts, categories, transactions/[id], admin/default-categories, admin/users - see the full try/catch inventory in §5) currently does **not** call `logError()` at all - it just returns a JSON error response with zero server-side record. This is the gap sub-task 12.5's "Generic API route errors... `API_ERROR`" item is presumably meant to close, but the prompt frames that purely in terms of the *new* pino/Sentry pipeline and never mentions this existing DB table/admin page it would now sit alongside.
  - **This is flagged as Discrepancy 1 below** - the prompt's own instructions say to stop rather than assume when "a logging library already in use" turns out to differ from what the prompt expected, and while `ErrorLog` isn't literally Sentry or pino, it is exactly that kind of pre-existing, purpose-built error-monitoring mechanism (its own schema, write path, and admin UI) that the prompt shows no awareness of.

### 4. `next.config.ts` - conflicts with a new request-ID middleware

[next.config.ts](../next.config.ts) currently only exports `poweredByHeader: false` and a `headers()` block (global security headers on `/(.*)`, plus a narrow `/sw.js` content-type/cache-control override). **No `rewrites()`, no `redirects()`, no experimental instrumentation hook, nothing that would collide with a new `X-Request-Id` response header or with `proxy.ts` gaining more responsibility.** The one thing to be deliberate about: `headers()` already sets a fixed list of response headers on every path via the Next.js config layer, which per the framework's own documented execution order (see the proxy docs pulled in §2) runs *before* Proxy - so `X-Request-Id` must be set by `proxy.ts` itself (as the prompt already says), not added to this static `headers()` list, since the header's value has to be per-request/dynamic (generated or echoed), which `next.config.ts`'s static `headers()` cannot do.

### 5. AI / DB / SMS call-site inventory

**NVIDIA NIM (AI) call sites:**
- [lib/nvidia-ai.ts](../lib/nvidia-ai.ts) - the one place that actually calls `fetch()` against NVIDIA NIM (`callNvidiaAI()`, private), wrapped by two exported functions: `chatCompletion()` (non-streaming, JSON-mode capable) and `streamChatCompletion()` (SSE streaming).
- [lib/ai/parse-transaction.ts:384](../lib/ai/parse-transaction.ts#L384) - `parseTransactionWithAI()`'s call to `chatCompletion()`. **Has a real, already-existing fast path that bypasses the AI call entirely**: `parseTransactionWithAI()` (starting at [line 330](../lib/ai/parse-transaction.ts#L330)) first tries deterministic bank-SMS parsing (`parseBankSms()`) and then a deterministic merchant-name match with confident amount/date extraction - only falls through to the `chatCompletion()` call at line 384 if neither resolves. Confirms the prompt's own 12.4.3 concern is real and must be respected: AI-latency logging belongs around the line-384 call site specifically, not wrapped around the whole `parseTransactionWithAI()` function, or every fast-path (bank-SMS/merchant-match) transaction would wrongly emit an AI-latency event despite making no AI call.
- [lib/ai/detect-transaction-intent.ts:37](../lib/ai/detect-transaction-intent.ts#L37) - `detectTransactionIntent()`'s call to `chatCompletion()` (the chat assistant's "is this a past unlogged transaction?" trigger check). Not named in the prompt's file list (which only names `parse-transaction.ts` explicitly) but is a real second call site under "any other NVIDIA NIM call sites found in the audit" - already has its own try/catch that fails safe to `{ isPastUnloggedTransaction: false }` on any error, i.e. an existing fallback path per 12.4.2's "preserve existing error-handling behavior" carve-out.
- [app/api/chat/route.ts:169](../app/api/chat/route.ts#L169) - `POST` handler's call to `streamChatCompletion()`, wrapped in its own try/catch (502 JSON error on failure, no fallback - matches 12.4.2's "re-throw after logging" default case).
- [app/api/chat/route.ts:79](../app/api/chat/route.ts#L79) (`trySuggestTransaction()`) - calls `parseTransactionWithAI()` (which itself may or may not call the AI, see above) inside a try/catch that already treats failure as a fallback (`{ ok: false, reason: "parse-failed" }` → chat continues as a normal reply) - another existing-fallback-path case per 12.4.2.

**Prisma/Turso client entry point:**
- [lib/prisma.ts](../lib/prisma.ts) - the single `PrismaClient` instance (via `@prisma/adapter-libsql` + `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`), globally cached outside production per the standard Next.js dev-hot-reload pattern. Every other file imports `{ prisma }` from here - 19 files under `lib/**`/`app/**` do so directly (`lib/data/*.ts`, `lib/analytics/spending-summary.ts`, `lib/reports/*.ts`, `lib/facts/*.ts`, `lib/auth/session.ts`, `lib/error-log.ts`, `lib/merchant-lookup.ts`, plus `app/api/chat/route.ts` and two `app/api/auth/*` routes that query it inline rather than through a `lib/data` wrapper).
- **Existing Prisma-error handling pattern**: every current call site checks for a unique-constraint violation via a plain `"code" in error && error.code === "P2002"` guard (not `instanceof Prisma.PrismaClientKnownRequestError`) - [app/api/admin/default-categories/route.ts:38](../app/api/admin/default-categories/route.ts#L38), [app/api/admin/default-categories/[id]/route.ts:31](<../app/api/admin/default-categories/[id]/route.ts#L31>), [app/api/categories/[id]/route.ts:40](<../app/api/categories/[id]/route.ts#L40>). `app/api/categories/route.ts` (POST) goes one step further and is the more accurate reference for how this driver adapter actually behaves: its own `isUniqueConstraintError()` helper ([app/api/categories/route.ts:29-41](../app/api/categories/route.ts#L29-L41)) documents that **`P2002` never actually fires through `@prisma/adapter-libsql`** - every raw DB error is routed through the generic `P2039` "driver adapter error" wrapper instead, so it treats `P2039` as a collision only after also sniffing the underlying SQLite error message for `UNIQUE constraint`, to avoid misclassifying unrelated `P2039`s (timeouts, syntax errors, ...) as collisions. 12.5's `DB_ERROR` instrumentation should key off this same `P2039`-plus-message-sniffing reality for this codebase's driver, not `P2002`/`instanceof PrismaClientKnownRequestError`, which the other 3 call sites check but which this adapter apparently never actually produces.
- **Full route-handler `catch` inventory** (for 12.5 scope-planning): every `route.ts` under `app/api/**` that has a `try {} catch (error) {}` block, one row per catch site - `app/api/accounts/[id]/route.ts` (×2), `app/api/admin/default-categories/route.ts` (×2), `app/api/admin/default-categories/[id]/route.ts` (×2), `app/api/admin/users/[id]/route.ts` (×2), `app/api/categories/route.ts` (×2), `app/api/categories/[id]/route.ts` (×2), `app/api/chat/route.ts` (×2, one of which is the `trySuggestTransaction` AI-fallback above, not a route-level catch), `app/api/transactions/route.ts` (×1, POST only - GET has no catch since `listTransactions()` doesn't throw user-facing errors), `app/api/transactions/[id]/route.ts` (×2), `app/api/transactions/parse/route.ts` (×1, already calls `logError`). `app/api/accounts/route.ts`, `app/api/facts/route.ts`, `app/api/auth/onboarding/route.ts`, `app/api/auth/send-otp/route.ts`, `app/api/auth/register/route.ts`, `app/api/auth/logout/route.ts`, and `app/api/auth/[...nextauth]/route.ts` have no route-level try/catch at all (validation-only 400s, or delegate entirely to NextAuth).
- Custom domain error classes already exist and are thrown/caught by name across these routes (not generic `Error`): `TransactionNotFoundError`/`InvalidCategoryError`/`InvalidAccountError` ([lib/data/transactions.ts](../lib/data/transactions.ts)), `CategoryInUseError`/`CategoryNotFoundError` ([lib/data/categories.ts](../lib/data/categories.ts)), `AccountNotFoundError`/`AccountInUseError` ([lib/data/accounts.ts](../lib/data/accounts.ts)), `DefaultCategoryNotFoundError`/`DefaultCategoryInUseError` ([lib/data/admin-categories.ts](../lib/data/admin-categories.ts)), `AdminUserNotFoundError`/`CannotModifySelfError` ([lib/data/admin-users.ts](../lib/data/admin-users.ts)), `NotAdminError` ([lib/auth/session.ts](../lib/auth/session.ts)), `UnknownFactKeyError`/`FactNotInferableError` ([lib/facts/user-facts.ts](../lib/facts/user-facts.ts)). 12.5 should treat these as distinct from raw `DB_ERROR`s where a route already `instanceof`-checks one (they're expected-and-handled business-rule outcomes, mapped to specific 4xx responses, not database failures) - only an *unexpected* Prisma-level failure falling through past these checks is a `DB_ERROR` in the sense the prompt means.

**SMS provider - confirmed real, not manual-paste-only (contradicts the prompt's own uncertainty):**
- The prompt's §12.0.5 asks to check `jib-mvp-roadmap.md` for whether an SMS provider integration exists yet, and to mark it N/A if not. **That filename does not exist anywhere in this repo** (the actual roadmap document is `` `فاز ۴ Jib — Production Hardening & Architecture Evolution Roadmap.md` `` at the repo root, plus this file, `docs/roadmap-status.md`) - noted as **Discrepancy 2** below, though it doesn't change the conclusion.
- Directly confirmed via code instead: **a real SMS provider integration exists and is live** - [lib/sms/melipayamak.ts](../lib/sms/melipayamak.ts)'s `sendOtpViaMelipayamak()` calls Melipayamak's real HTTP API (`https://rest.payamak-panel.com/api/SendSMS/BaseServiceNumber`) to deliver OTP codes, gated by `MELIPAYAMAK_USERNAME`/`MELIPAYAMAK_PASSWORD`/`MELIPAYAMAK_BODY_ID` (see `.env.example`). [lib/auth/otp.ts](../lib/auth/otp.ts)'s `sendOtpSms()` wraps it with a dev-only console-mock fallback when unconfigured, and fails closed in production (§1 above). **So SMS instrumentation is very much in scope for 12.5, not N/A** - the failure path is already the one existing `logError()`/`ErrorLog` call site outside the AI-parse route (`app/api/auth/send-otp/route.ts:29`, see §3).
- This is separate from, and not to be confused with, `lib/bank/*.ts` (`parse-bank-sms.ts`, `bank-patterns.ts`, `detect-bank.ts`, `extract-bank-amount.ts`, `extract-bank-type.ts`, `normalize.ts`, `labels.ts`) - that's pure text parsing of a bank SMS the user pastes in themselves (no SMS is sent or received by the app in that flow at all). That parsing logic is in scope for 12.5's *parser* instrumentation (`PARSER_ERROR`), not SMS-provider instrumentation.

### Discrepancies (per the prompt's "stop and report" instruction)

1. **Pre-existing `ErrorLog` DB table + `logError()` helper + admin viewer, not mentioned anywhere in the Phase 12 prompt** (§3). This isn't Sentry and isn't a console-based logger, so it doesn't technically contradict the prompt's literal check ("Sentry or any other error-monitoring SDK... or partially configured"), but it's close enough in spirit - a real, working, purpose-built error-recording mechanism with its own schema and admin UI - that proceeding straight into 12.1-12.5 without a decision on how the new pino/Sentry pipeline relates to it (replace it? leave it as-is and add logging alongside it, unconnected? have the new logger's `error`-level entries also write an `ErrorLog` row?) risks either duplicating effort or producing two disconnected error trails that admins have to check separately. Recommend a decision before 12.1.
2. **`jib-mvp-roadmap.md`, the file the prompt's §12.0.5 asks to check, does not exist in this repo** under that name (§5, SMS). Resolved by checking the actual code instead (a real SMS provider integration exists, so SMS is in-scope, not N/A) - flagged only because the prompt's own source-of-truth reference didn't match the repository, per its own instruction to report exactly this kind of mismatch rather than silently substituting a guess.

No other mismatches found - the runtime split (§2), the `next.config.ts` state (§4), and the AI/DB call-site shapes (§5) all matched what the prompt assumed, once the `middleware.ts` → `proxy.ts` rename (a documented breaking change in this Next.js version, per `AGENTS.md`) is accounted for.

**Stopping here per the prompt - awaiting review (and a decision on the two discrepancies above) before starting 12.1.**

- **Phase 12 (12.1-12.5) - Observability: ✅ done** - 2026-08-16

  ## Completed

  - **12.1 - Logger, redaction, error-type constants.** New `lib/observability/`: `error-types.ts` (`ERROR_TYPES` - `AUTH_ERROR`/`PARSER_ERROR`/`AI_ERROR`/`DB_ERROR`/`SMS_ERROR`/`API_ERROR`, an `as const` object + derived type rather than a TS `enum` - this project's SWC/Turbopack build doesn't support `const enum`, and `lib/limits.ts`'s own plain-`export const` style is the closer precedent anyway); `redact.ts` (pure, recursive, case-insensitive substring match on `password`/`token`/`creditCard`/`ssn`/`cvv`/`secret`/`apiKey`, path-based - not global-`Set`-based - circular-reference handling so a shared-but-non-circular reference isn't misflagged); `logger.ts` (`pino`, added as a new dependency - JSON to stdout only, no `pino-pretty`/transport added anywhere including dev, matching "no extra transports" - `formatters.log` wires `redact()` in before serialization, `messageKey`/custom `timestamp` renamed to match the spec's exact field list, `base: null` drops pino's default `pid`/`hostname`).
  - **12.2 - Request-ID middleware + context propagation.** Edited the existing `proxy.ts` (this Next.js version renamed `middleware.ts` to `proxy.ts` - no second file created). New `lib/observability/request-context.ts` (`AsyncLocalStorage`-backed `runWithRequestContext()`/`getRequestId()`). Every one of `proxy.ts`'s pre-existing return paths (rate-limit 429, admin 401/403, login-redirect, onboarding-redirect, and both `NextResponse.next()` calls) now goes through one of two small helpers so the response always carries `X-Request-Id`, and both `NextResponse.next()` calls forward it to the downstream route handler via a request-header (not a shared JS scope - see below). Routing/session logic itself is byte-for-byte unchanged, just wrapped.
  - **12.3 - Sentry integration.** Added `@sentry/nextjs` (was completely absent per the audit). New `instrumentation.ts` (`register()` + `onRequestError: Sentry.captureRequestError`, Node-runtime branch only), `sentry.server.config.ts`, `instrumentation-client.ts` (the current SDK generation's file, superseding the older `sentry.client.config.ts` convention). `dsn` from new `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` env vars (added to `.env.example`, never hardcoded); `environment` from the existing `NODE_ENV` convention (matches `next.config.ts`'s own `isDev`/`lib/auth/otp.ts`'s pattern - no new env var introduced for this). `beforeSend`/`beforeSendTransaction` in both config files call `redact()` (Phase 12.1's implementation, reused - not duplicated). No `sentry.edge.config.ts` and no `withSentryConfig` wrap of `next.config.ts` - see Discrepancies below.
  - **12.4 - AI call sites.** Wrapped the three real NVIDIA NIM call sites the audit found: `lib/ai/parse-transaction.ts` (the `chatCompletion()` call inside `parseTransactionWithAI()`, reached only past both deterministic fast paths - bank-SMS, confident merchant match), `lib/ai/detect-transaction-intent.ts` (added a `userId` parameter, its only caller updated), and `app/api/chat/route.ts` (`streamChatCompletion()` - duration measured as time-to-first-response, not full-stream duration; see Deferred). Success logs `info` with `duration`/provider (`AI_PROVIDER = "nvidia-nim"`, new shared constant in `lib/nvidia-ai.ts`); failure calls a new shared `lib/observability/report-error.ts` (`reportError()` - one function that both logs via pino and reports to Sentry with `requestId`/`userId` attached via `Sentry.withScope`, added so ~13 call sites across 12.4/12.5 don't each hand-rewrite that pairing). `detectTransactionIntent()`'s existing fail-safe fallback (`{isPastUnloggedTransaction:false}`) and `parseTransactionWithAI()`'s re-throw are both unchanged - logging is purely additive. Confirmed empirically, not just by reading the code, that fast-path transactions never emit a spurious AI-latency event: running just `lib/ai/parse-transaction.test.ts` in isolation produced exactly 19 `"route":"ai/parse-transaction"` log lines against exactly 19 tests that mock `chatCompletion` (27 tests total in that file - the other 8 are fast-path and produced zero).
  - **12.5 - DB, Parser, API-route, SMS instrumentation.** New `lib/observability/classify-error.ts` (`isPrismaErrorCode()` - matches `/^P\d{4}$/`, i.e. real Prisma codes *and* the `P2039` driver-adapter-wrapper code this codebase's own `@prisma/adapter-libsql` actually produces, per the audit - not `P2002`, which `app/api/categories/route.ts`'s own `isUniqueConstraintError()` comment says "never actually fires" through this driver). Every route handler's existing catch-all `throw error` (the case *after* every already-handled `instanceof KnownDomainError`/unique-constraint branch) now calls `reportError()` first, classified `DB_ERROR` when `isPrismaErrorCode()` is true, `API_ERROR` otherwise, with `context: { operation, model }` (function/model name, e.g. `"updateAccount"`/`"FinanceAccount"` - never parameter values) - `throw error` itself is unchanged, so the response the client sees is identical. Touched: `accounts/[id]`, `categories` (both POST branches), `categories/[id]`, `admin/default-categories`, `admin/default-categories/[id]`, `admin/users/[id]`, `transactions` (POST), `transactions/[id]` (PATCH+DELETE). Parser failures: the AI-JSON-extraction/validation steps in `lib/ai/parse-transaction.ts` and `lib/ai/detect-transaction-intent.ts` (immediately after the AI call itself succeeds, but the response can't be turned into a valid transaction/intent) now log `PARSER_ERROR` with `contentLength` only (never the AI's raw response text) - no `parserVersion`/`version` field, since grepping the codebase found no such concept anywhere to reuse, and the spec says not to invent one. SMS: `app/api/auth/send-otp/route.ts`'s existing Melipayamak-failure branch now also calls `reportError()` (`errorType: SMS_ERROR`, `provider: "melipayamak"`, `recipientLast4` - never the full phone number, `providerError` - Melipayamak's own returned error text, `retryCount: 0` - there's no retry loop in `sendOtpSms()`/`sendOtpViaMelipayamak()` today, so this is always 0, included to match the spec's field list rather than fabricated). Both of the audit's two pre-existing `logError()` (`ErrorLog` DB table) call sites - `auth/send-otp` and `transactions/parse` - are **unchanged**, per the Phase 12 audit's decision to keep `ErrorLog` exactly as-is; `reportError()` was added *alongside* each, in the same catch block, never replacing them.
  - **New shared files, all under `lib/observability/`:** `error-types.ts`, `redact.ts` (+`redact.test.ts`, 14 tests), `logger.ts`, `request-context.ts` (+`request-context.test.ts`, 6 tests), `report-error.ts`, `classify-error.ts` (+`classify-error.test.ts`, 6 tests). Plus root-level `instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`.
  - **New dependencies:** `pino` (^10.3.1), `@sentry/nextjs` (^10.70.0) - both flagged in-flow as they were added, matching the spec's own expectation that these two are the phase's dependencies.
  - **No migrations** - this phase touches zero Prisma schema/migration files, as expected for an observability-only phase.

  ## Verified

  - `npx tsc --noEmit`: clean throughout, after every sub-task.
  - `npm run lint`: clean throughout - same 2 pre-existing warnings (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`) present before this phase started, confirmed unrelated.
  - `npm run test`: 45/45 files, 438/438 tests passing (up from 43/426 at the end of 12.0's own review baseline) - net new: `redact.test.ts` (14), `request-context.test.ts` (6), `classify-error.test.ts` (6), plus existing-test updates for the `detectTransactionIntent(message, userId)` signature change and `@/lib/nvidia-ai` mocks gaining `AI_PROVIDER`.
  - `next build` (Turbopack): clean, twice (after 12.3 and again after 12.5) - no Sentry-related build warnings/errors, no stray Sentry build artifacts (`.sentryclirc`, upload logs) since `withSentryConfig` was deliberately not added (see Discrepancies).
  - Real `next start` + `curl`, done twice (after 12.2, again after 12.5 against the final build): `X-Request-Id` echoed back unmodified when supplied (`smoke-401` → `smoke-401`), a fresh UUID generated and echoed when omitted, on both a page route (`/login`) and API routes (`/api/accounts`, `/api/transactions`) - confirmed on 401/403/redirect paths, not just the happy path. Existing proxy auth/redirect behavior (unauthenticated `/app` → `/login` redirect, admin-gate 401) re-verified unchanged by the same requests.
  - Sample request against `/api/auth/send-otp` with an invalid phone: unchanged 400 + Persian message, no SMS attempt, confirming the length/validation checks ahead of the new SMS instrumentation weren't disturbed.
  - Manual review of every `context`/`reportError()` call added in 12.4/12.5 (no live Sentry project exists to inspect a real dashboard payload against): none pass a raw user-content value - only `.length`, Prisma `code`, `model`/`operation` names, `recipientLast4` (SMS, pre-anonymized to 4 digits), and `targetUserId` (a number, the admin-route pattern - see Deferred). Cross-checked this claim live: the full test run's stdout (pino writes real JSON to stdout even under `vitest`, by design - see 12.1) shows real `PARSER_ERROR`/`AI_ERROR` log lines firing with exactly this shape (`{"errorType":"PARSER_ERROR","context":{"contentLength":15},...}`), confirming redaction/field-shape end-to-end, not just by reading the source.
  - `.env`'s real credentials (Turso, NVIDIA, Melipayamak, OTP/session secrets) were never read into any log/report call - the only `process.env` reads added anywhere in this phase are `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `NODE_ENV`, `LOG_LEVEL`, `NEXT_RUNTIME` (Sentry DSNs are config, not secrets in the traditional sense - `NEXT_PUBLIC_SENTRY_DSN` is designed to ship in the client bundle).

  ## Security Improvements

  - 8 of 10 previously-silent route-handler catch-alls (the `throw error` after every known-domain-error check) now produce a structured, classified (`DB_ERROR`/`API_ERROR`) log line and a Sentry report with `requestId`/`userId` attached - previously these errors were invisible unless they happened to also trip Next.js's own unstructured default error page.
  - The one real SMS-provider integration (Melipayamak) now has classified `SMS_ERROR` observability with an anonymized recipient, where before its only trace was a single unstructured `ErrorLog` row.
  - AI-call latency is now a first-class, queryable signal (`duration`, `provider`) for both call sites (`parse-transaction`, `detect-transaction-intent`, `chat`) - previously invisible even though this app's core parsing flow depends entirely on this external API's latency.
  - Automatic unhandled-exception capture (`onRequestError`) now exists for the first time - any error escaping every route handler's own try/catch (a bug nobody wrapped) now reaches Sentry, not just a generic 500.
  - Redaction is enforced centrally (one `redact()` implementation, wired into both the pino formatter and both Sentry config files' `beforeSend`/`beforeSendTransaction`) rather than left to each call site's own judgment.

  ## Remaining Risks

  - **Double-reporting for one specific case, by design, not a bug:** when `chatCompletion()` itself fails inside `parseTransactionWithAI()`, it's reported once as `AI_ERROR` at that call site (12.4) *and* the re-thrown error is caught again one layer up by `transactions/parse/route.ts`'s own catch-all, now reported a second time as `API_ERROR` (12.5). Sentry's own issue-grouping will very likely merge these into one issue (same stack trace/message) with two events, not two issues - a minor dashboard imprecision, not a functional problem - but confirmed here as a real, known characteristic of this design rather than left undocumented.
  - **3 admin routes log DB/API errors without `userId`:** `admin/default-categories` (GET+POST), `admin/default-categories/[id]` (PATCH+DELETE), `admin/users/[id]` (PATCH+DELETE) rely on `proxy.ts`'s own `/api/admin/*` gate for authorization and never call `getSession()` themselves - adding one purely to attach a `userId` to a log line would add a real per-request DB read to routes that don't otherwise make one, which felt like the wrong trade for a logging-only phase. `admin/users/[id]`'s `targetUserId` in `context` is the user being blocked/deleted, not the acting admin - deliberately not placed under the `userId` field to avoid conflating the two.
  - **One pre-existing bug spotted, not fixed (per this phase's "no unrelated fixes" rule):** `app/api/categories/[id]/route.ts`'s PATCH handler checks `error.code === "P2002"` directly (not the P2039-aware `isUniqueConstraintError()` pattern its sibling `app/api/categories/route.ts` already uses) - per the audit, P2002 never actually fires through this codebase's driver adapter, so this branch is very likely dead code and a real unique-constraint violation on category rename probably falls through to a generic error today instead of the intended 409. Flagged in-line in the file and here; not fixed, since fixing it would be a behavior change outside this phase's scope.
  - **No live Sentry project was available to verify against a real dashboard** - all Sentry-payload verification was static (reading the `beforeSend`/`beforeSendTransaction` wiring, confirming `dsn` unset ⇒ documented no-op behavior in `@sentry/core`'s own source) rather than an actual captured-event inspection.

  ## Deferred

  - **`app/global-error.tsx` / `app/error.tsx` / every per-route `app/**/error.tsx`** are NOT wired to report to Sentry. These already exist with real, deliberate Persian-localized UX and their own reporting (`global-error.tsx`: `console.error` only; `error.tsx` and its per-route siblings: POST to the existing `/api/log-error` → `ErrorLog` pipeline). Sentry's own manual-setup guide treats `Sentry.captureException` in `global-error.tsx` as part of its standard "automatic unhandled-exception capture" setup, but editing these wasn't in 12.3's stated scope ("Sentry config files + instrumentation.ts only") and doesn't fit 12.4/12.5 either (those are server-side AI/DB/API/SMS instrumentation, not React render-error boundaries). Left untouched; a natural follow-up sub-task if client-render-error visibility in Sentry is wanted.
  - **`sentry.edge.config.ts` / `withSentryConfig` (`next.config.ts` wrap):** not added. The former would be genuine dead code (confirmed zero Edge-runtime usage anywhere in this app, both by 12.0's audit and 12.2/12.3's own re-confirmation via this exact Next.js version's docs: Proxy defaults to Node.js and can't be switched to Edge). The latter primarily enables source-map upload/release tracking, which needs real `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` this app doesn't have configured yet - confirmed (by reading `@sentry/nextjs`'s own shipped source, `getBuildPluginOptions.js`) that this doesn't gate basic exception capture, which comes from `Sentry.init()`'s own default integrations (global uncaught-exception/rejection handlers) plus Next's native `onRequestError` hook, both wired regardless. Add both once a real Sentry project (and, if ever needed, an Edge route) exists.
  - **`streamChatCompletion()`'s logged `duration` is time-to-first-response, not full-stream duration** - measuring the latter would mean threading timing state through the response `ReadableStream`'s own `pull()`/`cancel()` callbacks in `app/api/chat/route.ts`, materially bigger than "wrap the AI call." Noted, not implemented.
  - **`ErrorLog`+`requestId` schema correlation** was not implemented - the two DB tables (`ErrorLog` rows and pino/Sentry's own `requestId`-tagged entries) aren't linked. Per the Phase 12 audit's decision, this was explicitly flagged as "a one-line schema addition to flag explicitly in that sub-task's summary, not something to fold in silently" - flagged here, not added, since it would be a schema change and this phase's own rules say nothing here touches the DB schema.

  ## Do Not Claim

  This phase does not provide "production-ready observability," "full error coverage," or "complete request tracing." It provides: structured JSON logs for AI/DB/parser/API/SMS failures and AI latency at the call sites enumerated above; automatic Sentry capture of anything that still escapes every handler's own try/catch; and a request ID that round-trips through response headers and (via a forwarded request header, not shared process state) into route handlers. Client-side React render errors are not yet in Sentry (see Deferred). Three admin routes log without a `userId`. One pre-existing, unrelated bug was found and left as found. No live Sentry ingestion was verified end-to-end against a real project.

## Phase 6, SEC-10, Phase 13.1, DR-1 — 2026-08-19

Baseline before this session's work: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings as every prior entry), `npm run test` 45/45 files / 438/438 tests passing. Final, after all four items: `tsc` clean, `lint` clean (same 2 warnings), **47/47 files, 458/458 tests passing** (net +20: +11 Phase 6, +9 SEC-10; Phase 13.1 and DR-1 added no application code, only docs/`Dockerfile`/`next.config.ts`). `next build` clean (run 3 times across this session: once for the SEC-10 host smoke check, twice via `docker build` for DR-1). Full command/output detail is under each item below.

### 1. Phase 6 — Raw Financial Data Privacy Audit

#### Completed

- **Findings table** (field/log site → sensitive content today → severity → fix):

  | Site | Contains raw financial data? | Severity | Fix |
  |---|---|---|---|
  | `Transaction.rawInput` (schema) | Yes, by design (raw pasted bank SMS/text) | N/A — required, read back by `TransactionRow`'s `description \|\| rawInput` fallback (`components/transactions/transaction-row.tsx:23`) and by `updateTransaction()`'s merchant-mapping learning (`lib/data/transactions.ts:145-152`) | Keep as-is (see "checked before proposing removal" below) |
  | `lib/observability/redact.ts` (pino formatter + Sentry `beforeSend`/`beforeSendTransaction`) | **Yes — confirmed, not hypothetical.** Purely key-based redaction let a financial-identifier-shaped digit run through when it wasn't sitting under a key literally named `password`/`token`/etc. | High | Extended `redact()` with pattern-based digit-run scrubbing (below) |
  | `reportError()`'s `message` argument → pino's `msg` | **Yes — a real, demonstrated leak**, not just a gap in coverage. Pino's `formatters.log()` only ever runs on the merged *fields object* (the first arg to `logger.error()`), never on the `msg` string itself (confirmed against `node_modules/pino/lib/tools.js`'s `_asJson`) — so `redact()` was never even reached for this value | High | `reportError()` now explicitly calls `redact(message)` before it becomes pino's `msg` |
  | Native `JSON.parse` `SyntaxError.message` (`lib/ai/parse-transaction.ts`'s `extractJson()`, reused by `lib/ai/detect-transaction-intent.ts`) | **Yes — this is the concrete mechanism behind the leak above.** V8's own `JSON.parse` error message quotes a preview of the string it failed to parse. `content` there is the AI's raw response, built from a prompt containing the user's `rawInput`/chat text — a malformed-JSON AI response can echo fragments of it back verbatim into an exception `.message` that already reaches both `reportError()` (pino + Sentry) and, via `logError()`, the `ErrorLog` DB table | High | Same pattern-based redaction closes this at every consumer (pino, Sentry, `ErrorLog`) rather than patching the one call site |
  | `lib/error-log.ts`'s `logError()` (`ErrorLog` table, admin-viewable at `/app/admin/logs`) | Yes — `message`/`stack` are stored with **zero redaction** before this change, and 2 of its 3 call sites (`transactions/parse`, `app/api/log-error`) can carry an unsanitized upstream error string or fully client-controlled content | High | `logError()` now runs both `message` and `stack` through `redact()` before storing (`stack` needed the same fix as `message`, not just `message` — a JS `Error.stack` conventionally starts with `"${name}: ${message}"`, so the same content sits at the top of `stack` too) |
  | `callNvidiaAI()`'s thrown-error text (`lib/nvidia-ai.ts:79`, NVIDIA's own HTTP error response body, sliced to 300 chars) | Plausible but **unconfirmed** — this is upstream provider text, not directly `rawInput`; whether NVIDIA NIM's error responses ever echo request content back (some LLM APIs do, for validation/moderation errors) isn't verifiable from this repo | Low/unconfirmed | Covered by the same `reportError()`/`redact()` fix as a side effect, not specifically targeted |
  | `app/api/log-error/route.ts` (unauthenticated, client-submitted `message`/`stack`) | Confirmed reachable by a malicious client with arbitrary content — but length-capped (2000/8000 chars, `lib/error-log.ts`), rate-limited (`GENERAL_API_IP_RULE` via `proxy.ts`'s `/api/:path*` matcher, confirmed), and rendered as plain JSX text in the admin page (`app/app/admin/logs/page.tsx:49,59` — no `dangerouslySetInnerHTML`, so no stored-XSS path) | Low (already mitigated) | No new fix needed beyond the redaction above, which now also applies here |
  | `app/api/auth/send-otp/route.ts`'s `logError()`/`reportError()` calls | No — `message` is Melipayamak's own provider error text, not the OTP code (confirmed: the code is never logged in production, only in the dev-only mock-SMS `console.log`, already flagged in the Phase 12 audit) or `rawInput` | N/A | No fix needed |

- **Fix implemented:** extended `lib/observability/redact.ts` (the existing, shared redaction implementation — no second system) with pattern-based scrubbing: any run of ≥9 digits (ASCII, Persian ۰-۹, or Arabic-Indic ٠-٩ — real bank SMS use all three per `lib/bank/normalize.ts`), optionally separated by a single space/dash, is masked as `[REDACTED_NUMBER]` inside **any string value at any depth**, not just under a sensitive-named key. 9 digits comfortably covers 16-digit card numbers, Sheba/IBAN, typical 10-20 digit Iranian account/reference numbers, national IDs, and mobile numbers, while every numeric field this codebase actually logs today (`duration`, `userId`, `contentLength`, …) is a JS `number`, which never reaches this code path at all (only `typeof value === "string"` triggers it) — verified by a dedicated test (`redact.test.ts`: `"leaves numeric (non-string) fields untouched regardless of digit count"`). Deliberately biased toward over-redaction (an incidental 9+ digit run that isn't actually sensitive still gets masked) over under-redaction, which is the wrong tradeoff to get wrong here.
- `reportError()` (`lib/observability/report-error.ts`) now explicitly redacts `message` before it becomes pino's `msg` argument — the one place `redact()`'s existing wiring (pino `formatters.log`, Sentry `beforeSend`/`beforeSendTransaction`) didn't already reach, for the reason in the table above.
- `logError()` (`lib/error-log.ts`) now redacts both `message` and `stack` before the `ErrorLog` insert.
- `rawInput` storage: **kept, not removed or changed.** Checked every consumer before considering removal (per this phase's own instruction) — it's read back for display (`TransactionRow`) and for merchant-mapping learning (`updateTransaction()`), so dropping or nulling it would break both existing, shipped features.

#### Verified

- New/extended tests: `lib/observability/redact.test.ts` (+7 tests, including one that reproduces the exact `JSON.parse` leak mechanism above and confirms it's closed), `lib/observability/report-error.test.ts` (new file, +2 tests, confirms the pino-`msg`-bypass fix specifically), `lib/error-log.test.ts` (new file, +2 tests, against the real local-SQLite test DB — confirms `ErrorLog` rows are actually stored redacted, not just that a function returns a redacted string).
- `npx tsc --noEmit` clean; full suite 47/47 files, 458/458 tests passing (see session totals above); `npm run lint` clean (same 2 pre-existing warnings).
- Manually re-ran `lib/ai/parse-transaction.test.ts`/`detect-transaction-intent.test.ts` and inspected the actual stdout JSON log lines produced (pino writes real JSON under `vitest`, per Phase 12) — `PARSER_ERROR`/`AI_ERROR` lines' `message` field no longer contains raw quoted content from a malformed-JSON scenario.

#### Security Improvements

- Closed a confirmed (not hypothetical) gap where a JSON-parse failure on the AI's response could leak a fragment of the user's original financial text into stdout logs and Sentry, bypassing the Phase 12 redaction pipeline entirely via a code path (pino's `msg` argument) that `redact()` was never wired into.
- `ErrorLog` (previously unredacted, per the Phase 12 audit's own note that it's a separate, purpose-built mechanism from the pino/Sentry pipeline) now gets the same pattern-based protection.
- Redaction is now shape-based as well as name-based — protects against the exact scenario this phase's own brief called out (a raw bank SMS/card number sitting under an innocuously-named key like `text`/`rawInput`), not just the literal JSON-parse case found.

#### Remaining Risks

- **Pattern-based redaction is a heuristic, not a guarantee.** A financial identifier that doesn't take a 9+-digit shape (unlikely for card/account numbers, but not logically impossible for some other identifier format) would still pass through. Balances/amounts are deliberately *not* targeted by a separate pattern — they're not reliably distinguishable from other legitimate numbers by shape alone, and the app's core purpose is logging amounts, so a blanket amount-redaction heuristic wasn't attempted.
- **NVIDIA NIM's error-response text (`lib/nvidia-ai.ts`'s `callNvidiaAI()`) potentially echoing request content back** is plausible but unconfirmed from this repo — it's third-party API behavior. The redaction fix covers it defensively (same `reportError()` path), but this wasn't specifically verified against a real NVIDIA NIM error response.
- `app/api/log-error/route.ts` remains unauthenticated by design (documented, existing tradeoff — client error boundaries can't reach Prisma directly) — now redacted before storage, but still accepts arbitrary client content up to the existing length caps.

#### Deferred

- **Encryption-at-rest for `Transaction.rawInput`: evaluated, not implemented.** Checked feasibility as instructed before deferring: `rawInput` is never used in a `WHERE`/`ORDER BY` (only read back and passed to `normalizeText()` in application code), so column-level encrypt/decrypt wouldn't break any query — technically feasible. Deferred anyway because it needs (a) new key-management (an encryption key env var, safely provisioned), (b) a live-data backfill migration to encrypt 7+ real users' existing plaintext rows, and (c) touching both read paths (`TransactionRow` display, merchant-mapping derivation) — a materially larger, live-data-touching change than this audit's "implement only clearly justified fixes" scope, and this session's ground rules require explicit confirmation before any live-DB write regardless.
- **No global request body-size limit** beyond Next.js's framework default — noted in the original Phase 4.1 audit, not re-litigated here since it's a distinct finding from this phase's redaction focus.

#### Do Not Claim

This does not provide "complete data-leak prevention" or guarantee no financial identifier can ever reach a log. It closes one confirmed, demonstrated leak path (JSON-parse error messages bypassing key-based redaction) and adds a shape-based heuristic on top of the existing key-based one, covering both the pino/Sentry pipeline and the separate `ErrorLog` table. `rawInput` itself remains stored in plaintext in the primary DB, unencrypted — this phase did not change that storage decision either way beyond confirming it's actually in use.

### 2. SEC-10 — Transaction Creation Idempotency

#### Completed

- **Inspected first:** `POST /api/transactions` (`app/api/transactions/route.ts`) and `createTransaction()` (`lib/data/transactions.ts`) end to end, plus both real frontend submit call sites (found by grepping every `fetch("/api/transactions"...)` — `components/transactions/add-transaction-form.tsx`'s `saveTransaction()` and `components/chat/chat-interface.tsx`'s `handleConfirmSuggestion()`; no third caller exists).
- **Schema:** `Transaction.idempotencyKey String?` + `@@unique([userId, idempotencyKey])` added to `prisma/schema.prisma`. Migration generated **offline** per `AGENTS.md`'s exact process (`migrate diff` between HEAD's schema and the new one, no DB connection) and saved verbatim as `prisma/migrations/20260819081756_add_transaction_idempotency_key/migration.sql`:
  ```sql
  -- AlterTable
  ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;
  -- CreateIndex
  CREATE UNIQUE INDEX "Transaction_userId_idempotencyKey_key" ON "Transaction"("userId", "idempotencyKey");
  ```
  `npx prisma generate` re-run (schema-only, no DB connection). **Not applied to the live Turso DB — this session's own instruction was to prepare and verify locally only, and stop before applying live.** Verified instead against the isolated local-SQLite test DB (`test/setup/global-setup.ts` applies every `prisma/migrations/*/migration.sql`, including this new one, fresh on every `npm run test` run) — the full suite passing, including every new idempotency test below, confirms the migration applies cleanly and produces the expected schema/constraint.
- **Server behavior** (`createTransaction()`, `lib/data/transactions.ts`): an optional `idempotencyKey`. Two dedup paths: (1) read-first — an existing `{userId, idempotencyKey}` row is returned as-is, skipping re-validation and cache invalidation (nothing new happened); (2) catch-and-refetch on the unique-index violation — handles the true concurrent case where two requests both pass the read-first check before either commits. Reuses `app/api/categories/route.ts`'s exact `isUniqueConstraintError()` detection logic (P2039-plus-message-sniffing, since `@prisma/adapter-libsql` never actually produces `P2002`) — homed in `lib/observability/classify-error.ts` (already this codebase's shared Prisma-error-classification module) as `isUniqueConstraintError()`, rather than a third near-duplicate copy; `categories/route.ts`'s own local copy was left untouched, out of scope.
- **Response shape:** `POST /api/transactions` returns the **same `{ transaction }` shape and 201 status** for both a fresh create and an idempotent replay — deliberate: from the caller's point of view, retrying a create it already made should look exactly like that create succeeding again, matching how idempotency keys are conventionally expected to behave (e.g. Stripe's own API replays the original response as-is). `createTransaction()`'s own return type is unchanged (still the raw `Transaction`, not a `{transaction, replayed}` wrapper) — kept the diff to this function's one real caller.
- **Backward compatibility:** the key is fully optional. Confirmed via a dedicated test (`"creates normally when no idempotencyKey is given (existing behavior, unchanged)"`) that omitting it reproduces the exact pre-existing behavior (two separate creates, two separate rows) — an older/cached PWA client that predates this change works unmodified.
- **Client behavior:**
  - `components/transactions/add-transaction-form.tsx`: a `useRef<string | null>` generated lazily on first submit inside `saveTransaction()`, reused across a retry of the *same* attempt (clicking "تأیید و ذخیره" again after a failed save, or a double-tap race), and only reset in `handleReset()`/`handleDismissLivePreview()` — the two points where the user actually abandons the current text/preview and starts over.
  - `components/chat/chat-interface.tsx`: generated once when the suggestion itself is created (`PendingSuggestion.idempotencyKey`, set in `handleSend()`'s success handler), reused by every `handleConfirmSuggestion()` call against that same suggestion.
  - Both use `crypto.randomUUID()`, matching this file's own existing convention for message IDs.

#### Verified

- `lib/data/transactions.test.ts`, new `describe("createTransaction (idempotency - SEC-10)")` (6 tests): no-key behavior unchanged; first-seen key creates normally; repeated key returns the same row with **no second DB row** (verified via `prisma.transaction.count`, not just the return value); per-user scoping (same key string for two different users creates two independent rows); and a genuine **concurrent double-submit** — `Promise.all([createTransaction(...), createTransaction(...)])` with the same key against the real local-SQLite test DB (the same `@libsql/client` driver path `lib/prisma.ts` uses at runtime) — produces exactly one row, confirming the DB-level unique index (not just the read-first check, which has an inherent race window) is what actually guarantees no duplicate under real concurrency for this driver.
- `app/api/transactions/route.test.ts`, new `describe("POST /api/transactions - idempotency (SEC-10)")` (2 tests) + 2 length-limit tests (`MAX_IDEMPOTENCY_KEY_LENGTH = 100`, added to `lib/limits.ts`) in the existing length-limits block.
- `npx tsc --noEmit` clean; full suite 47/47 / 458/458 passing; `npm run lint` clean.
- `next build` clean; real `next start` + `curl`: unauthenticated `POST /api/transactions` (with an `idempotencyKey` in the body) → 401 unchanged; unauthenticated `GET /api/transactions` → 401 unchanged; `X-Request-Id` round-trip unchanged; `/api/log-error` unaffected — confirms the new field doesn't disturb any existing request-handling path even before authentication is reached.

#### Security Improvements

- Closes SEC-10 (deferred from Phase 5 — see that phase's own "Explicitly not touched" note): a network retry or UI double-tap on transaction creation no longer risks a duplicate financial transaction. Directly protects the accuracy of transaction history, the core integrity guarantee of a finance app.
- Concurrency verified against the real driver/DB, not assumed from reading the unique-index definition alone — the ground rules explicitly asked whether the unique index alone is sufficient or an explicit catch-and-fetch path is needed; empirically, both matter (the catch path is real, reachable code, not dead defensive code).

#### Remaining Risks

- **Idempotency keys persist across a failed-attempt-then-edit on the client.** If a first submit attempt actually succeeded server-side but the client believed it failed (e.g. a response dropped after the server committed), and the user then edits the amount/category before retrying, the retry replays the *original* (pre-edit) transaction rather than creating a new one with the edited values — an inherent tradeoff of "one key per attempt," not a bug; the far more common case (a clean retry of unmodified content) is handled correctly. No product decision was made to add content-hashing or any other refinement here, since the ground rules didn't ask for one.
- The chat-interface "تلاش دوباره" (retry) button — a **pre-existing, unrelated bug**, not introduced or touched by this change — see "Noticed, not fixed" below.

#### Deferred

- Nothing schema/behavior-related was deferred within SEC-10's own scope; the live-DB application step (step 4 of `AGENTS.md`'s process) is deferred **by this session's explicit instruction**, not because of any technical gap — the migration is prepared, reviewed, and verified locally, awaiting a separate go-ahead to apply to the live Turso DB.

#### Do Not Claim

This does not make transaction creation exactly-once in every conceivable sense (see the edit-after-failed-retry case above) — it makes it safe against the two scenarios the ground rules named: network retries and double-taps/concurrent double-submits, both verified against the real DB driver. It does not touch `PATCH`/`DELETE /api/transactions/[id]` — idempotency was scoped to creation only, matching SEC-10's own definition.

**Noticed, not fixed (out of SEC-10's scope):** `components/chat/chat-interface.tsx`'s `handleConfirmSuggestion()` guards on `target.suggestion.status !== "pending"` at its very first line — but the "تلاش دوباره" (try again) button visible on `status === "error"` calls this exact same function, whose status at that point is `"error"`, not `"pending"`. The guard returns immediately, so that retry button currently does nothing. Pre-existing (predates this session's changes), unrelated to idempotency, left as found per this session's "no unrelated fixes" rule.

## SEC-10 (continued) — Live Database Migration Applied — 2026-08-19

Separate session, same day. Picks up SEC-10's own explicitly-deferred item: applying the already-prepared, already-locally-verified `idempotencyKey` migration (section 2 above) to the live Turso DB. Re-inspected the migration SQL and `AGENTS.md`'s live-migration process fresh at the start of this session rather than trusting the prior session's description of it.

### 1. Backup (logical export, not native `.dump`)

- **Why not the documented runbook:** `AGENTS.md`'s backup process (`turso db shell <db> .dump`) needs an authenticated Turso CLI session against the account that owns this database (`hajervin`). No working login for that account was available this session — confirmed as a hard constraint, not re-attempted mid-task.
- **Method used instead:** `scripts/backup-live-db.ts` (new, kept in the repo — not committed by this session), connecting with the app's own runtime credentials (`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, the same env vars `lib/prisma.ts` requires) via the raw `@libsql/client` driver — same package/pattern already established by `scripts/backfill-migration-history.ts`. Deliberately does **not** go through `lib/prisma.ts`'s Prisma Client: Prisma coerces column values into JS types (`DateTime` → `Date`, SQLite 0/1 → `Boolean`) on the way out, which risks losing the exact on-disk representation; the raw client returns the literal stored value per column instead. Every statement issued during the backup phase is a `SELECT`/`PRAGMA` — no write capability of the connection was used.
- **Schema cross-check before exporting:** the script enumerates live tables via `sqlite_master` and diffs them against the model list read from `prisma/schema.prisma` (11 models) before trusting what to export — configured to stop rather than export a partial/wrong set on any mismatch. Result: all 11 expected tables present, no unexpected tables, zero triggers/views (so that specific `.dump` gap doesn't apply to this database today).
- **Table/row-count baseline captured** (immediately pre-migration):

  | Table | Rows | Table | Rows |
  |---|---|---|---|
  | User | 49 | UserFact | 3 |
  | DefaultCategory | 26 | ErrorLog | 38 |
  | FinanceAccount | 34 | Account | 0 |
  | Category | 204 | MerchantMapping | 1 |
  | ChatMessage | 44 | Transaction | 28 |
  | SpendingSummaryCache | 1 | | |

  Plus bookkeeping tables also captured for completeness: `_prisma_migrations` (6 rows — confirmed the idempotencyKey migration had *not* yet touched the live DB) and `sqlite_sequence` (10 rows, the AUTOINCREMENT counters this schema depends on since every model uses `@id @default(autoincrement())`).
- **File:** `/home/abt/jib-db-backups/jib-backup-2026-08-19T19-58-15-281Z.sql` (176,227 bytes; 444 `INSERT` statements = 428 app rows + 6 + 10, sum checked against the captured counts, confirming no truncation). Lives entirely outside the repo directory (`/home/abt/jib-db-backups/` is not under `/home/abt/Downloads/jib`), not merely gitignored within it — no path by which a repo-scoped `git add` could pick it up.
- **Verified concretely, not assumed:** a throwaway diff script re-queried 5 real live transactions (ids 1210, 1215, 1278, 1279, 1280, including Persian `rawInput` text) and compared every column byte-for-byte against the file's parsed `INSERT` values. All 5 matched exactly (e.g. `"۵ میلیون واریزی امیرحسین"`, 45 UTF-8 bytes, round-tripped correctly). The throwaway script was deleted after use; it is not part of the permanent toolkit.
- **Restore procedure, if ever needed:** create a fresh SQLite/Turso DB from the migration files up through whichever migration you're restoring to, then apply this file's `INSERT` statements — e.g. `turso db shell <new-db> < jib-backup-2026-08-19T19-58-15-281Z.sql` (or any `@libsql/client`/`sqlite3` driver executing the file's statements in order) — inside a transaction with `PRAGMA defer_foreign_keys=ON` (needed for `Category`/`DefaultCategory`'s self-referential `parentId` rows), then repoint `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` at the new database and redeploy.
- **Known limitations vs. a native `.dump`, stated explicitly:** this is column-value fidelity via libsql's own JS value mapping, not a byte-exact SQLite file — it captures no PRAGMA/WAL/storage-engine state. It does capture `sqlite_sequence` and confirmed (not assumed) zero triggers/views exist in this schema as of this session; that would need re-checking if either is ever added later, since this script does not export either kind of object.

### 2. Migration DDL applied

Applied one statement at a time via raw `@libsql/client` against `TURSO_DATABASE_URL` (not `prisma migrate deploy`/`db push`, per `AGENTS.md`), 2026-08-19 ~20:03 UTC, after explicit go-ahead shown against the exact SQL below:

```sql
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Transaction_userId_idempotencyKey_key" ON "Transaction"("userId", "idempotencyKey");
```

Re-introspected immediately after (`PRAGMA table_info`/`index_list`/`index_info` on `Transaction`) before proceeding to bookkeeping: `idempotencyKey` is `TEXT`, `notnull=0`, no default — matches the migration exactly; the new unique index covers `(userId, idempotencyKey)` in that order; all four pre-existing indexes (`accountId`, `categoryId`, `type`, `userId_date`) are intact.

`_prisma_migrations` bookkeeping row inserted after that verification passed: `id=454a90d0-d8fd-402d-bf58-bc06396af224`, `checksum=283c2d0a875790599782ce23a4e9da05a94206f7957d09da1c0750c234a27c7f` (SHA-256 of the actual `migration.sql` bytes, matches what `scripts/backfill-migration-history.ts` independently computes), `migration_name=20260819081756_add_transaction_idempotency_key`, `applied_steps_count=1`. `scripts/backfill-migration-history.ts`'s `MIGRATION_NAMES` list updated to include this migration and re-run (dry run) — confirms all 7 migrations, including this one, are now recognized as already present; no drift.

### 3. Verification (Step 4) — before/after, proving no data loss

| Table | Before | After |
|---|---|---|
| User | 49 | 49 |
| DefaultCategory | 26 | 26 |
| FinanceAccount | 34 | 34 |
| Category | 204 | 204 |
| ChatMessage | 44 | 44 |
| SpendingSummaryCache | 1 | 1 |
| UserFact | 3 | 3 |
| ErrorLog | 38 | 38 |
| Account | 0 | 0 |
| MerchantMapping | 1 | 1 |
| Transaction | 28 | 28 |

Every count matches exactly — no rows lost or duplicated by the migration. All 28 existing `Transaction` rows have `idempotencyKey IS NULL` (28/28; explicit query for any non-`NULL` value returned zero rows) — the migration did not backfill a bogus value onto existing data, matching the field's intended nullable/optional design. `npx tsc --noEmit` clean and `npm run test` (47/47 files, 458/458 tests) both re-confirmed identical to the pre-migration baseline — this session touched no application code, only the live schema via the two DDL statements above.

### Security Improvements

- SEC-10's schema-level gap (section 2 above: idempotency logic shipped, but with no unique constraint actually enforcing it live) is now closed — the constraint the server-side dedup logic depends on exists on the live database, not just the local test DB.

### Remaining Risks

- **Regaining Turso CLI account access is still an open item**, not resolved by this session. Until it is, every future live-DB backup goes through this same logical-export substitute rather than the documented native `.dump`, and every future schema change goes through the same manual raw-`@libsql/client` DDL-application process (unaffected by the CLI gap, since it never used the CLI) but without the option to take a native pre-change snapshot first.
- The logical-export backup method's stated limitations above (no PRAGMA/WAL state, no trigger/view capture) apply to any future backup taken this same way until CLI access is restored.

### Deferred

- **Automating the CLI-access restoration or the backup itself** — out of scope for this session; flagged for follow-up, not attempted.
- Per the task's own instruction, live end-to-end testing of the idempotency write path (actually creating a transaction with a key against production) was **not** performed — schema-level verification above plus the already-passing local integration tests (section 2) were treated as sufficient for this session.

### Do Not Claim

This does not make the live database "fully backed up and production-ready" in any general sense. What actually happened: a one-time, verified-complete-at-the-time logical export of every row in every table (11 app tables + 2 bookkeeping tables, 444 `INSERT` statements, spot-verified byte-for-byte including Persian text) was taken immediately before a single additive, non-destructive schema change (one nullable column, one unique index) was applied and verified to have caused zero data loss. It is not a recurring backup, not a native `.dump`, and does not by itself close the "no automated backups" gap documented in section 3 (Phase 13.1) above — that gap, and the Turso CLI access constraint that shaped this session's backup method, both remain open.

### 3. Phase 13.1 — SQLite/Turso Reliability Hardening

#### Completed

- **Deployment mode confirmed from code, not assumed:** `lib/prisma.ts`'s `PrismaLibSql` adapter is constructed with only `url`/`authToken` (both plain `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` reads) — no `syncUrl`, which is what an embedded-replica configuration would require. **This is remote-only mode.** "WAL configuration" as a concept therefore doesn't apply to this app's own configuration at all in production — WAL is a local-SQLite-file-level setting, and Turso's server-side storage engine for a remote-only connection isn't something this repo configures or can verify.
- **Backup strategy — confirmed absent, then addressed with a documented runbook** (not automation — see Deferred): grepped the whole repo for "backup"/"dump"/"snapshot"/"point-in-time" — no script, no cron/CI job, no doc. Confirmed with the project owner: the live DB is on **Turso's free plan**. Researched (WebSearch + WebFetch against `docs.turso.tech`, both cited inline) what that tier actually includes rather than assuming: every Turso plan, including free, includes self-service point-in-time recovery — free = last 24 hours, restorable via `turso db create <new> --from-db <live> --timestamp <ISO8601>` (creates a **new** DB, doesn't restore in place). Added a new "Backing up the live database (Turso)" section to `AGENTS.md` documenting: the PITR restore command and its 24h limit; the gap it doesn't cover (a mistake noticed >24h later, given this app's manual-migration-script process and no staging environment); and a minimal logical-export runbook using `turso db shell <db> .dump > backup.sql` (the current documented way to get a portable export — a dedicated `turso db export` command doesn't exist yet, confirmed via the tool's own open GitHub issue).
- **Migration process re-confirmed accurate against current reality — not just re-read, actually re-exercised.** This session's own SEC-10 migration (item 2 above) followed `AGENTS.md`'s documented process end to end (offline `migrate diff`, verbatim save, `prisma generate`, local verification) and it worked exactly as documented — the strongest form of confirmation available, stronger than inspection alone.
- **File permissions / `dev.db`:** confirmed via `git log --follow`/file timestamp/`.gitignore` that `dev.db` at the repo root is a stray, gitignored, untracked leftover from before the Turso migration (last written before the switch) — not referenced by `lib/prisma.ts` (which requires the Turso env vars unconditionally, no local-file fallback), any script, or `.env.example`. Production is 100% remote Turso; this file is genuinely unused in every environment (dev also uses real Turso per `.env`; tests use a separate `.vitest-test.db`). Matches `security-audit-report.md`'s own prior note ("worth local cleanup," not a repo-level risk). No hardening applied — nothing production touches.
- **Concurrent access assumptions:** reused, not re-investigated, per this phase's own instruction — the roadmap's own 4.4.1 ("Distributed rate limiting") already documents "a single Node process on one VPS" as the current, operative deployment assumption. Still accurate; no new information found that changes it.

#### Verified

- No code changes in this phase — purely documentation/investigation, as the phase's own brief expected ("mostly documentation plus verification... unless the audit finds an actual gap"). The one gap found (backups) got a documented runbook, not application code.
- Backup-tier and PITR-mechanics claims verified against Turso's own current docs (`docs.turso.tech/features/point-in-time-recovery`, `docs.turso.tech/cli/db/shell`), not stated from training-data memory — both fetched live in this session.

#### Security Improvements

- The live database (7+ real users, no staging environment) now has a documented, runnable backup path beyond relying solely on the vendor's 24-hour PITR window.

#### Remaining Risks

- **The backup runbook is manual, not automated.** No cron/CI job runs `turso db shell ... .dump` on a schedule yet — documented as the explicit next step, not silently implemented, since a real scheduled job needs a storage destination this session can't provision or verify working.
- **Turso's free-tier PITR window is 24 hours.** A mistake caught later than that (a bad migration, a slow-to-notice bug) has no vendor-side recovery path unless the manual runbook above has actually been run recently.

#### Deferred

- **Automating the backup runbook** (cron/CI + a storage destination) — explicitly deferred, not fabricated, per this phase's own instruction not to claim working automation that can't be verified from this repo.
- **WAL-specific tuning** — not applicable to production (remote-only Turso connection, confirmed above), and not applied to `dev.db`/the test DB either, since neither is on any production path ("don't harden a file production never touches").

#### Do Not Claim

This does not provide "automated backups" or "disaster-recovery-tested" status — no scheduled job exists, and the manual runbook has not been rehearsed against this project's actual live database (only documented, with commands verified against Turso's own current CLI/docs). The 24-hour vendor PITR window is real and self-service, but the manual export runbook remains the only defense-in-depth beyond it, and it has not yet been run for real.

### 4. DR-1 — Deployment Artifact

#### Completed

- `next.config.ts`: added `output: "standalone"` (confirmed absent before this change) — required for the Dockerfile's minimal runtime image; no other build-output behavior changes (`next start`/local dev unaffected).
- **`Dockerfile`** (new): 3-stage build (`deps` → `builder` → `runner`), Node 22 throughout to match `.github/workflows/ci.yml`'s pinned version. `deps` installs with `npm ci --ignore-scripts`; `builder` runs `prisma generate` then `npm run build` (which itself runs `prisma generate && next build` per `package.json`); `runner` copies only `public/`, `.next/standalone`, and `.next/static` into a fresh `node:22-slim` image, runs as a dedicated unprivileged `nextjs` user (uid 1001, not root), and starts via `node server.js`. No native Prisma query-engine binary is involved anywhere (`generated/prisma` was checked — this project's driver-adapter setup, `@prisma/adapter-libsql`, has no `.node`/`.so` engine files), so no glibc/musl or OpenSSL runtime concern applies despite `prisma generate`'s own (harmless, confirmed) OpenSSL-detection warning during the build stage.
- **No secret baked in:** every credential (`AUTH_SECRET`, `TURSO_AUTH_TOKEN`, `NVIDIA_API_KEY`, etc.) is read from `process.env` at container start. The Dockerfile's build-stage `ARG`s are non-secret placeholder strings that exist only so `next build`'s static-page pre-rendering doesn't fail against modules that read a required env var at import time (same reasoning as CI's own dummy env vars) — documented inline in the Dockerfile's own header comment. The one genuine exception is `NEXT_PUBLIC_SENTRY_DSN`, which Next.js inlines into the client bundle at build time by design (not a secret, but must be supplied as a build `ARG`, not a runtime var, to actually take effect) — documented in both the `Dockerfile` and the runbook.
- **`.dockerignore`** (new): excludes `.git`, `node_modules`, `.next`, `generated`, `.env*` (except `.env.example`), and the local-only SQLite artifacts.
- **`docs/deploy-runbook.md`** (new): required env vars (table, cross-referenced against `.env.example` as the source of truth, not duplicated by hand); the `NEXT_PUBLIC_SENTRY_DSN` build-vs-runtime distinction; the reverse-proxy `X-Real-IP`/`Host` requirement (reusing `lib/rate-limit.ts`'s own documented nginx/Caddy config verbatim, and explicitly flagging this is still an **open**, unconfirmed dependency, not something this session verified as done); the migration-application step (pointer to `AGENTS.md`, explicit "not `prisma migrate deploy`" callout); and a health-check note (`GET /` is fully static, doesn't touch the DB/AI/SMS, confirmed via the `next build` route table).

#### Verified — actually built and run, not just written

- `docker build` succeeded twice in this session (once before, once after adding the `NEXT_PUBLIC_SENTRY_DSN` build arg) — Docker was confirmed available in this environment (`docker version` — client 29.1.3, server reachable) before attempting this, so nothing here is claimed unverified.
- `docker run` with placeholder (non-real) env vars: container booted (`✓ Ready in 0ms`), confirmed running as `nextjs` (uid 1001, not root) via `docker exec ... whoami`/`id`.
- `curl` against the running container: `GET /` → 200 with the full body (40KB, matching the host `next build`/`next start` smoke check from SEC-10) and all of `next.config.ts`'s security headers present; `GET /login`, `/manifest.webmanifest` → 200; `GET /sw.js` → 200 with its own `Content-Type`/`Cache-Control` override intact (confirms `next.config.ts`'s `headers()` config is correctly serialized into the standalone `server.js`, not lost); `GET /api/transactions` (unauthenticated) → 401, confirming a dynamic route/session-check path executes without crashing even with placeholder DB credentials.
- Image size: 454MB (`node:22-slim`-based, not alpine — a deliberate choice to avoid musl/native-binding risk for a first working artifact, not size-optimized). Test images/containers were removed after verification (`docker rmi`/`docker rm`) — nothing left running or built lingers from this session.
- `npx tsc --noEmit` clean; `npm run lint` clean; full test suite unaffected (this item touched no application code, only `next.config.ts`'s config object, `Dockerfile`, `.dockerignore`, and docs).

#### Security Improvements

- Closes DR-1 (deferred in the Phase 4 log as "evaluated, no reproducible deployment artifact exists") — deployment steps are no longer tribal knowledge; a `git clone` + `docker build` reproduces the same artifact anyone else building from the same commit would get.
- No secret is baked into the image (verified by construction, not just by not adding one — the runtime stage copies only `.next/standalone`/`.next/static`/`public/`, never the builder stage's `ENV`-set placeholder values, and real secrets never entered the build in the first place).
- Runs as an unprivileged user by default, not root — verified, not assumed.

#### Remaining Risks

- **The reverse-proxy `X-Real-IP` requirement remains unconfirmed as actually configured anywhere** — the runbook documents the requirement and the exact config needed (reusing `lib/rate-limit.ts`'s own comment), but this session has no way to verify a real proxy in front of a real deployment is set up this way. Rate limiting remains spoofable until that's confirmed.
- **Image is not size-optimized** (`node:22-slim`, 454MB) — a reasonable, defensible first artifact per the minimal-diff bias, not a claim that this is the smallest possible image.
- **No health-check endpoint exists** — `GET /` is used as a reasonable stand-in (confirmed static, no DB/AI dependency) but doesn't confirm DB/NVIDIA NIM/SMS reachability.

#### Deferred

- **Automated image publishing (a registry push / CI build step)** — not requested by DR-1's scope (build + verify locally, document the runbook), so not added. `.github/workflows/ci.yml` was not modified.
- **Image size optimization** (alpine base, multi-arch, layer caching tuning) — the working, verified artifact was prioritized over further optimization, per the minimal-diff bias.
- **Reverse-proxy configuration itself** — this is infrastructure outside the repo; only the requirement and exact config are documented (see Remaining Risks).

#### Do Not Claim

This does not provide a "production-ready" or "hardened" container image, and does not claim the reverse proxy is actually configured correctly anywhere real — only that the image builds, boots, serves traffic, and runs unprivileged, all actually verified in this session, and that the remaining infrastructure-side requirements are now documented rather than tribal knowledge.

## Phase 14 (partial) — Offline Transaction Queue (PWA Background Sync) — 2026-08-20

Scope: submitting a new transaction (`components/transactions/add-transaction-form.tsx`) while offline or on a flaky connection is now accepted immediately, stored locally, shown as pending, and synced automatically on reconnect - without duplicates or silent loss. Explicitly **partial**: only transaction *creation* is queued - chat messages, category edits, account edits, and every other write in the app are untouched, and full offline page/asset availability beyond the pre-existing `public/sw.js` cache-first/network-first split (unchanged here) is out of scope.

#### Completed

- **Inspected first, per this task's own rule:** read `add-transaction-form.tsx`'s full submit flow including SEC-10's idempotency-key generation (`docs/roadmap-status.md`'s SEC-10 entry above), the existing service worker (`public/sw.js`, registered by `components/pwa/service-worker-register.tsx`) and manifest (`app/manifest.ts`) before writing anything. Both already exist and were extended, not duplicated: the offline queue is new (`lib/offline/`), but reuses SEC-10's idempotency key and key mechanism unchanged, and adds a second, independent client-only registration component (`OfflineSyncRegister`) alongside the existing `ServiceWorkerRegister` rather than folding unrelated concerns into one file.
- **Storage - `lib/offline/transaction-queue.ts`:** raw `indexedDB` (one object store, keyed by the SEC-10 idempotency key), not a wrapper library - no IndexedDB dependency existed in this codebase (`idb`, `dexie`, etc. all absent from `package.json`) and the actual surface needed (get/put/delete/getAll on one store) didn't justify adding one. `localStorage` was ruled out per the task's own brief (synchronous, string-only, size-limited). Each row: `{ idempotencyKey, payload, status: "pending"|"syncing"|"failed"|"synced", createdAt, retryCount, lastError? }`. Every export degrades to a safe no-op/empty-array/rejection when `indexedDB` is unavailable (SSR, disabled storage) rather than throwing into a caller that isn't expecting it - same progressive-enhancement precedent as `ServiceWorkerRegister`'s own registration-failure handling.
- **Cross-component change notification:** IndexedDB has no built-in change events, so a `BroadcastChannel` signals the pending-list UI to re-read the store on every enqueue/update/delete. Caught (via a test, not by inspection alone) a real bug during development: a single shared channel instance for both sending and listening never delivers to itself, per the `BroadcastChannel` spec - fixed to one dedicated sender channel plus a fresh receiver channel per `subscribeToQueueChanges()` call.
- **Submit flow - `add-transaction-form.tsx`'s `saveTransaction()`:** for creation only (edits have no idempotency key and stay out of scope, matching "queue only transaction creation"), the exact POST body is now written to IndexedDB as `status: "pending"` *before* the network attempt, on every submit regardless of actual connectivity - same code path online or offline, per this task's own brief. The `fetch` call is now in its own inner `try`/`catch` so a connectivity failure (the promise itself rejecting) is distinguished from a real server-side rejection (`res.ok === false`, unchanged existing handling): a connectivity failure leaves the queued row in place and navigates to `/app/transactions` (optimistic - the item is already visible there as pending) instead of showing an error; a server-side rejection deletes the queued row (nothing left to retry - the inline error on the same screen already tells the user what to fix) and behaves exactly as before. A successful online submit is unchanged end-to-end except for a best-effort queue-row delete after the fact.
- **Background retry - `lib/offline/sync-transactions.ts`:** `online`-event listener + in-tab exponential backoff (5s base, doubling, capped at 5 min, `MAX_AUTO_RETRIES = 5` before auto-retry stops and the item is marked `failed` for manual retry), **not** the Background Sync API (`registration.sync.register`). Decided and documented in-code why: Background Sync API is Chromium-only, unsupported in Safari/Firefox including iOS Safari - and this app's own `app/layout.tsx` (`appleWebApp: { capable: true, ... }`) and `app/manifest.ts` already commit to iOS PWA installability, so a sync mechanism that silently never fires for every iOS user isn't a reliable primary path for a finance app's data integrity. The `online` event + foreground backoff is used as the sole mechanism, universally supported, at the accepted cost that a fully-closed tab won't sync until reopened (the queue itself still persists across that - see below). Wired up via a new `components/pwa/offline-sync-register.tsx`, mounted once in `app/layout.tsx` next to `ServiceWorkerRegister` (not scoped to the transactions page, so an item queued elsewhere still syncs while the user is on another screen).
- **Idempotent-replay handling:** deliberately has *no* special-case branch. A retry that reaches a request the server already committed on a prior attempt gets back the identical 201 + `{ transaction }` shape SEC-10's `createTransaction()` already returns for a fresh create - from `attemptSubmitTransaction()`'s point of view that's already indistinguishable from, and exactly as good as, a first-time success. Verified by a dedicated test asserting exactly one `fetch` call and a cleanly-deleted queue row for a replay scenario.
- **UI - `components/transactions/pending-transaction-list.tsx`:** renders queued (non-`synced`) items above the server-rendered list in `app/app/transactions/page.tsx`, reusing the existing `TransactionRow` presentational component (dimmed) rather than a new one, resolving the queued item's category name/icon/color from the `categories` prop the page already fetches (no new request). A `"syncing"`/`"pending"` item shows a spinner + "در حال همگام‌سازی"; a `"failed"` item shows its `lastError` and a "تلاش دوباره" button wired to `retryQueuedTransactionNow()` (resets the retry budget, matching "don't retry forever silently, surface a manual affordance"). When a previously-queued item disappears from a refresh (i.e. it synced), the component calls `router.refresh()` so the now-real, server-rendered transaction actually appears in the confirmed list - the reconciliation step from the task's brief.
- **Deliberately out of scope / not touched:** `components/chat/chat-interface.tsx`'s own separate `POST /api/transactions` call site (the assistant-suggestion confirm flow) - the task's brief scopes this to `add-transaction-form.tsx` specifically; chat submissions are not queued offline. The dashboard's "تراکنش‌های اخیر" widget (`app/app/page.tsx`) also does not show pending items - only `/app/transactions` does, per the brief's literal "transactions list" wording and to keep the diff minimal; a create still redirects to `/app` on the (unchanged) online-success path. The pending list is also not filtered by the transactions page's existing type/category filter bar - it always shows every queued item regardless of the active filter.

#### Verified

- **New tests, 33 total:** `lib/offline/transaction-queue.test.ts` (17 - enqueue/get/list/update/delete round-trips, update-on-missing-key is a no-op, persistence across a simulated fresh read, change notifications including the unsubscribe case, and full graceful degradation when `indexedDB` is deleted from `globalThis`), `lib/offline/sync-transactions.test.ts` (9 - `attemptSubmitTransaction`'s three outcomes, a successful sync deleting the queue row, the idempotent-replay case above, network-failure increments `retryCount` and reschedules, exceeding `MAX_AUTO_RETRIES` marks `failed`, a server-side rejection marks `failed` immediately without touching `retryCount`, a no-op when nothing's queued, manual retry resetting the budget), plus extensions to `components/transactions/add-transaction-form.test.tsx` (+3) and a new `components/transactions/pending-transaction-list.test.tsx` (+4).
- `fake-indexeddb` added as a **devDependency only** (real runtime code uses the browser's native `indexedDB`) - jsdom (already a devDependency here, confirmed this codebase's own version) does not implement IndexedDB at all, checked directly rather than assumed. `npm audit`: the pre-existing 10 high-severity findings (transitive, via `next`→`sharp`) are unchanged before/after adding it - confirmed by diffing `npm audit` output with and without this session's changes stashed.
- Two real bugs were caught *by* the tests, not just by inspection, and fixed before this entry was written: the `BroadcastChannel` self-delivery bug above, and `vi.useFakeTimers()` stalling every `fake-indexeddb` operation (its internal request-completion scheduling relies on real timer callbacks) - the retry-exhaustion test seeds `retryCount` directly instead of stepping through real backoff delays, avoiding the need for fake timers entirely.
- `npx tsc --noEmit`: clean. `npm run lint`: clean (same 2 pre-existing warnings - `components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId` - confirmed unrelated, present before this work started). `npm run test`: **50/50 files, 486/486 tests passing** (up from 47/458 at session start: +3 new test files, +28 net new tests), confirmed reliable across two consecutive full runs (one flaky broadcast-notification test, caused by a fixed single-tick wait racing real `BroadcastChannel` delivery under full-suite load, was fixed to poll instead and re-verified stable).
- `next build` (Turbopack): clean, all 20 routes generated, no new warnings.
- Manual DevTools-network-offline verification was **not performed in this session** (no interactive browser available here) - see Remaining Risks below for exactly what that leaves unconfirmed versus what the test suite above does cover.

#### Remaining Risks

- **Not manually verified in a real browser this session:** the task's own verification checklist (DevTools offline simulation: submit while offline → appears pending → does not hit the network → reconnect → syncs and reconciles without user action; fully-closing and reopening a tab with a still-pending item; the double-submit/duplicate-prevention path end-to-end in a live browser) was reasoned through and covered at the unit/component level (fetch is mocked to reject exactly as a real offline `fetch()` does; IndexedDB persistence is real, not mocked, via `fake-indexeddb`), but never exercised against an actual browser's real network stack, real IndexedDB, or a real service worker lifecycle. This is a materially different confidence level than "manually confirmed."
- **A tab that's fully closed while offline does not sync until it's reopened** - an accepted, documented consequence of not using the Background Sync API (see Completed above), not an oversight.
- **The pending list ignores the transactions page's active type/category filter** - a queued item always shows regardless of the current filter selection, which could look inconsistent with an otherwise-filtered confirmed list below it. Not fixed, to keep this change scoped to what the brief actually asked for.
- **Chat-submitted transactions (`chat-interface.tsx`) are not queued** - explicitly out of scope per the brief ("queue only transaction creation" from `add-transaction-form.tsx`), but worth naming as a gap: a transaction confirmed via the chat assistant while offline today behaves exactly as it did before this work (fails outright), not gracefully.
- **No cap on how large the IndexedDB queue can grow** if many submits fail repeatedly and are never retried/cleared (e.g. a user offline for a long stretch, submitting several transactions) - realistically bounded by how many transactions one person manually submits in one offline session, not treated as a real risk here, but not enforced in code either.

#### Deferred

- Full PWA/offline page-and-asset availability beyond `public/sw.js`'s existing cache-first (static assets)/network-first-with-fallback (page navigations) split - unchanged by this work, and out of this task's stated scope.
- Queuing for any write other than transaction creation (chat, category edits, account edits, ...).
- A live-browser manual verification pass (see Remaining Risks) - recommended as an immediate follow-up before this is considered fully confirmed, not just unit-tested.

#### Do Not Claim

This does not provide full-app offline support, and does not claim to have been manually verified against a real browser's offline mode, real service worker, or real IndexedDB storage-eviction behavior - only against `fake-indexeddb` (a real, spec-following IndexedDB implementation, but not the browser's own) and mocked `fetch`. It covers exactly one write path (transaction creation via `add-transaction-form.tsx`); every other mutation in this app still requires connectivity at the moment it's submitted, unchanged.

#### Addendum, 2026-08-20 — white-screen regression, root cause, and fix

Immediately after this phase's session, `npm run dev` started serving a blank white page on every route. The regression looked offline-queue-shaped (new code mounted at the root layout, and the "not manually verified in a real browser" gap called out above), but it was not - reproducing it with real Playwright/Chromium (per this task's own verification standard) traced it to `next.config.ts`'s `headers()`, which is **not** part of this phase's diff; it belongs to an earlier same-day session's CSP/security-headers hardening (SEC-11-adjacent), left uncommitted alongside this phase's changes.

- **Root cause:** `next.config.ts` sent `Strict-Transport-Security` and a CSP containing `upgrade-insecure-requests` on every response, unconditionally - including `npm run dev`, which serves plain `http://localhost:3000` with no TLS listener. `upgrade-insecure-requests` is a CSP directive, not a transport-level check: once any page has loaded it, the browser silently rewrites every subsequent `http://` request *issued from that page* (client-side router navigations, RSC data fetches, `fetch()`/XHR) to `https://` before sending it - with no gate on how the directive itself was delivered. A dev server that only speaks HTTP cannot answer that rewritten request, so it fails outright (`ERR_SSL_PROTOCOL_ERROR`), taking every navigation after the first page load down with it. Confirmed directly: `curl -D -` against the dev server showed both headers present; a Playwright session that stayed on one page across a login → onboarding redirect (the same shape as any real post-login navigation) reproduced the exact failure, while separate fresh-context navigations to each route did not - because there was no prior same-origin page already carrying the CSP to do the rewriting. The `Strict-Transport-Security` header's own comment ("harmless to send unconditionally - browsers ignore it over plain HTTP anyway") is true for HSTS's own transport-level gate, but the same reasoning does not extend to `upgrade-insecure-requests`, which sits in the same header block and has no such gate - that's the actual bug.
- **Fix:** both directives are now dev-excluded in `next.config.ts`, using the `isDev` check the file already had (previously only gating CSP's `'unsafe-eval'`). Production is unaffected - a `next build` + `next start` check after the fix confirmed both headers are still sent in production, unchanged.
- **Verified for real, not just compiled:** real headless Chromium via Playwright (no interactive browser in this environment, matching how the earlier CSP/login-button bug in this same file was caught and verified). Before the fix: register → onboarding redirect failed with `ERR_SSL_PROTOCOL_ERROR`. After the fix, in one continuous authenticated session: register, sign in, complete onboarding, hard-navigate to `/`, `/login`, `/app`, `/app/transactions`, and client-side (SPA) navigate between `/app` and `/app/transactions` - all rendered real content, zero console errors, zero failed requests. `npx tsc --noEmit`, `npm run lint`, `npm run test` (50/50 files, 486/486 tests), and `next build` all clean, matching this phase's own numbers above unchanged.
- **The offline-queue feature itself was not the cause, and was manually verified in a real browser this session** - closing the exact gap this phase's own "Remaining Risks" section flagged as not yet done: with a real authenticated user, an item queued while `page.context().setOffline(true)` (real browser offline, not a mock) rendered correctly as pending under `/app/transactions` (spinner + "در حال همگام‌سازی"); going back online triggered `OfflineSyncRegister`'s listener, and the dev server log confirms a real `POST /api/transactions 201` completing the sync. One test-harness-only artifact surfaced along the way and is *not* a claim about app behavior: a page reload timed to land mid-request (colliding with Turbopack's lazy first-compile of `/api/transactions` in dev) left a queued item's local status stuck at `"syncing"` until the process was given more time - an interruption from the test script's own timing, not from the app. It did surface one narrow, real design gap worth naming for later, not fixed here: `syncOne()` never resets a record already in `"syncing"` back to `"pending"`/`"failed"` on a later mount, so a sync interrupted by an actual tab close or reload at that exact moment (not just this test's artifact) has no automatic recovery path today - low-probability, not blocking, not part of this regression.
- **Separately noticed, unrelated to this regression, not fixed here:** a real React console warning - "Cannot update a component (`Router`) while rendering a different component (`OnboardingPage`)" - from `app/onboarding/page.tsx`'s `finishOnboarding()` (a `router.push`/`router.refresh` call) being invoked from inside `advance()`'s `setStep` updater function. It did not block navigation in any of this session's runs (onboarding completed and redirected correctly every time it wasn't itself blocked by this session's own rate-limit testing artifacts - see below), so it was left as-is rather than folded into an unrelated fix; worth a follow-up.
- **Not a bug, but worth recording so a future session doesn't misread the evidence:** repeated back-to-back test registrations against the same long-running dev server, all from this session's own verification, eventually tripped `EMAIL_REGISTER_IP_RULE`'s rate limit (expected, correct behavior) and visibly slowed later requests (`GET /app` up to ~14s) - both are artifacts of this session's own test load, not something a real user would hit.

## Phase 7 & 8 — Parser/Categorization Hardening + Confidence Model — 2026-08-22

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` 50/50 files / 486/486 tests passing.

### 7.0 / 8.0 — Inspection findings (both reported before implementation started, per the prompt's own instruction)

- **`lib/bank/*.ts` today:** `bank-patterns.ts` (17 banks in the `Bank` union, one dominant ~100-score rule + weak generic corroborators each, most still flagged `// TODO: verify with real SMS sample` - only Sepah/Tejarat/Refah/Blu are backed by a "real SMS sample" per the existing tests' own provenance notes, the rest are synthetic placeholders), `detect-bank.ts` (score-and-threshold, `MIN_CONFIDENCE_SCORE=50`, `TIE_THRESHOLD=10`), `extract-bank-amount.ts` (comma-grouped numbers only, keyword-adjacency disambiguation against `مانده`/`موجودی`), `extract-bank-type.ts` (keyword-list expense/income classifier), `normalize.ts` (Persian/Arabic-Indic digit + Yeh/Kaf normalization, ZWNJ-preserving), `parse-bank-sms.ts` (all-or-nothing: bank + amount + type must all resolve). Test coverage before this session: strong for the 4 real-sample banks and for each extractor in isolation, but only 4 of 17 banks had a fixture proving the *complete* `parseBankSms()` pipeline (bank+amount+type+date together) actually succeeds - the other 13 banks' `detect-bank.test.ts` fixtures are short synthetic strings with no comma-grouped amount at all, so `parseBankSms()` on any of them would have failed at the amount step, untested.
- **Merchant matching today:** `lib/merchant-lookup.ts`'s `findMerchant()` already checks a per-user `MerchantMapping` table (exact → alias/token-sequence → substring tiers, via the shared `findBestMatch()` used for both the user and global tiers) **before** falling through to the global `lib/merchants.ts` list, which is itself checked before any AI call. `updateTransaction()` (`lib/data/transactions.ts`) already upserts a `MerchantMapping` row (keyed by `{userId, normalizeText(rawInput)}`) whenever a transaction's category is changed and it has non-empty `rawInput` - **a single correction is enough to create the mapping, not two.** This closes 7.2 as "already exists" per the prompt's own instruction to check first - confirmed working at the unit level (`lib/merchant-lookup.test.ts`) but not, before this session, proven end-to-end from a real `updateTransaction()` correction through a later `parseTransactionWithAI()` call.
  - **Priority-order discrepancy vs. the prompt's assumed order:** the prompt describes "exact match → alias match → normalized match → user-historical match → AI fallback." The actual code instead checks **all of the user's own mapping tiers (exact/alias/substring) before touching the global list at all** - i.e. a fuzzy substring hit on the user's own learned mapping outranks even an *exact* global-merchant match. Evaluated and **left as-is, not reordered**: a user's own past correction is a stronger signal than a shared default regardless of match fuzziness, and reordering to match the prompt's literal phrasing would be a real behavior change with no confirmed justification - see the "Do Not Claim"/design-decision note under Phase 7 below.
- **`lib/ai/parse-transaction.ts` end-to-end (re-confirmed, still accurate as of this session):** `parseBankSms()` first (deterministic, wins outright) → `findMerchant()` fast path (deterministic amount/date extraction, skips the AI entirely) → real NVIDIA NIM call only past both. Matches the Phase 12 audit's own description of this flow exactly.
- **8.0: a confidence concept already existed, contradicting the prompt's "check for a blank slate" framing.** `ParsedTransaction` already carried `confidence?: number` (the AI's raw self-reported 0-1 value, observability-only) and `needsConfirmation?: boolean`, and `resolveAiCategory()` already implemented an equivalent tri-level bucket internally (`>=0.80` auto-assign, `0.50-0.79` assign+confirm, `<0.50`/invalid fallback+confirm) - just not exposed as named levels, and with no separate concept of *extraction* confidence at all. **`Transaction` (the Prisma model) has no confidence field of any kind** - confirmed by reading `prisma/schema.prisma` directly, not assumed. The frontend's actual confirmation gate (`components/transactions/add-transaction-form.tsx`) already shows a warning whenever `needsConfirmation` is true and does **not** block saving either way - it's an advisory banner, not a hard gate. `components/chat/chat-interface.tsx`'s suggestion card (via `app/api/chat/route.ts`'s `trySuggestTransaction()`) already only ever surfaces a suggestion when `needsConfirmation === false` - i.e. the chat path was already restricted to the "confident" bucket before this session touched anything.

### Phase 7 — Completed

- **Real bug found and fixed:** [lib/bank/extract-bank-amount.ts](../lib/bank/extract-bank-amount.ts)'s `TRANSACTION_KEYWORDS` list (`["برداشت", "خرید", "واریز"]`) was missing `"پرداخت"` (payment) and `"انتقال"` (transfer/income), even though both are already recognized transaction-type signals in the sibling `extract-bank-type.ts`'s `TYPE_KEYWORDS`, and `"پرداخت"` is literally the scored keyword for Parsian's own bank-patterns.ts rule (`"parsian-payment"`). **Caught by a new test, not by inspection alone:** a synthetic-but-structurally-realistic Parsian fixture (`پرداخت:430,000` + a balance line) correctly detected the bank and would have correctly detected the type, but `extractBankAmount()` returned `null` - the amount was never attributed to `"پرداخت"` at all, so `parseBankSms()` failed entirely on an otherwise fully-resolvable message. Fixed by adding both keywords to `TRANSACTION_KEYWORDS` (`"از حساب شما پرید"` deliberately excluded - it's a trailing narrative phrase handled separately by `TRANSACTION_TRAILING_PHRASES`, not a "keyword:number" label). Real-world impact: any bank whose SMS reports a payment via `"پرداخت:"` or an incoming transfer via `"انتقال:"` (Parsian's own pattern is literally named for this) would have silently fallen through to the AI fallback - or failed outright if the AI was also unavailable/rate-limited - for a message shape structurally identical to every other bank's already-working `"keyword:amount"` format.
- **Verified correct, not bugs (confirmed via new tests, not just inspection):** balance-only messages (no transaction keyword at all) already correctly return `null` rather than being misparsed as a transaction; malformed/truncated/garbled SMS (a bank name cut off mid-word, cut off before any amount, or corrupted with a stray mojibake character; digits replaced with garbled text) already fail safely to `null` rather than guessing; ordinary financial free text that happens to contain a comma-formatted number and a recognized type keyword but no bank name is already correctly rejected (bank detection is a mandatory gate, not a soft signal); mixed digit scripts (Persian/Arabic-Indic/Latin) within one message already resolve correctly, since `normalizeText()` runs before any candidate scanning; ریال/تومان conversion is unchanged and already correct per the existing convention.
- **7.1 parser regression suite - added, no other existing fixtures removed or weakened:** `lib/bank/extract-bank-amount.test.ts` (+3: mixed-digit-script cases). `lib/bank/parse-bank-sms.test.ts` (+19: one full bank+amount+type+date fixture each for the 11 previously-uncovered banks - melli/saman/parsian/pasargad/post/keshavarzi/maskan/ayandeh/shahr/karafarin/eghtesad-novin, synthetic and clearly labeled as such per this codebase's existing convention; one واریز/income full-result fixture; a balance-only-message test; 4 malformed/truncated/garbled tests; one non-bank-text-with-incidental-amount false-positive guard). Combined with the 4 pre-existing real/near-real-sample fixtures (Tejarat/Refah/Sepah/Blu) and the 2 already-documented "resolves to unknown" cases (Mellat, Saderat), **every one of the 17 members of the `Bank` union now has at least one test proving what `parseBankSms()` actually does with it** - either a complete result, or a documented, tested reason it correctly returns `null`.
- **7.2 - user-historical merchant learning: confirmed already implemented, closed with a real end-to-end test.** New `describe("user-historical merchant learning (Phase 7.2, end-to-end)")` in `lib/ai/parse-transaction.test.ts` (+2 tests): creates a transaction via `createTransaction()`, re-categorizes it once via `updateTransaction()` (the actual "learning" step - a `MerchantMapping` upsert), then calls `parseTransactionWithAI()` with `chatCompletion` mocked to fail loudly if called at all - confirms the very next mention of that merchant resolves deterministically to the learned category (`source: "userMapping"`, `needsConfirmation: false`) with **zero AI calls**, and confirms the mapping does **not** leak to a different user (falls through to the AI for them, unaffected). No implementation change was needed here - the mechanism (schema, upsert, priority order) already existed and already worked; this closes the "verify it actually works end-to-end" instruction, not a build-from-scratch.
- **Deliberately not changed:** the merchant-lookup priority-order discrepancy noted in 7.0 above (user-mapping-before-global, not interleaved by match quality) - kept as-is; the `MerchantMapping` schema (already fits 7.2's purpose exactly, no change needed); `lib/bank/bank-patterns.ts`'s existing "TODO: verify with real SMS sample" placeholders (13 of 17 banks) - not resolved, since no real samples exist to resolve them with, matching this codebase's own established precedent of flagging rather than guessing.

### Phase 8 — Completed

- **Design:** named levels only, `"high" | "medium" | "low"` (new `lib/ai/confidence.ts`) - no numeric probabilities, since no calibration data exists (confirmed, not assumed: NVIDIA NIM's `chatCompletion()` return type is a plain `string`, no logprobs or self-reported extraction-confidence field of any kind). Two independent concerns, combined by one documented rule:
  - **Extraction confidence** (`extractionConfidenceForBankSms(bankConfidence)`, `EXTRACTION_CONFIDENCE_DETERMINISTIC`, `EXTRACTION_CONFIDENCE_AI`): `"high"` for the merchant fast path (deterministic `extractAmount`/`extractDate`, all-or-nothing like the bank engine); for bank-SMS, `"high"` when `bankConfidence === 1` (every one of the winning bank's own detection rules matched) else `"medium"` (a partial-but-still-accepted match - `parseBankSms` already refuses anything below `MIN_CONFIDENCE_SCORE`, so nothing here is ever `"low"`); `"medium"`, never `"high"`, for any branch where the AI itself supplied `amount`/`date` - "the AI was needed for extraction at all" is treated as the lower-confidence signal itself, per the prompt's own instruction not to fabricate a number NVIDIA NIM doesn't provide.
  - **Categorization confidence** (`categorizationConfidenceForMerchantMatch(source, matchTier)`, plus `resolveAiCategory()`'s already-existing threshold bucket, now also returned as a named level): `"high"` for a user-historical mapping (any tier - a real personal decision outranks match fuzziness) and for a curated keyword override (`lib/merchants.ts`'s `keywordOverrides`, which bypasses tiering entirely); for a global-merchant match, `"high"` only for an exact (tier 1) hit, `"medium"` for alias/substring (tier 2/3); `"low"` for a plain bank-SMS result with no merchant signal at all (`CATEGORIZATION_CONFIDENCE_NONE`); and `resolveAiCategory()`'s own existing `>=0.80`/`0.50-0.79`/`<0.50`-or-invalid buckets, unchanged, just also returned as `"high"`/`"medium"`/`"low"`. A `findSimilarCategory` name-match override (the existing `newCategorySuggestion`-resolves-to-an-existing-category path) forces `"medium"` regardless of the AI's own reported number, since the category actually shown is no longer literally the AI's own pick.
  - **Overall** (`combineConfidence`): the weaker of the two - documented, tested (a 9-case table + a symmetry check), not a weighted formula.
  - **Signal exposed but not previously public:** extended `MerchantLookupResult` (`lib/merchant-lookup.ts`) with an optional `matchTier?: 1 | 2 | 3`, populated from `findBestMatch()`'s own already-computed tier - this existed internally but was never surfaced past that module before, so distinguishing "exact merchant match" from "alias match" (two separate named signals in the prompt's own 8.1 list) wasn't possible for a caller without this small, additive extension.
- **Implementation:** `ParsedTransaction` gained three **optional** fields - `extractionConfidence`, `categorizationConfidence`, `confidenceLevel` (`ConfidenceLevel | undefined`) - extending, not replacing, the existing shape (per this project's "preserve API contracts" convention). Optional for the same reason `source`/`confidence`/`needsConfirmation` already are: `app/app/add/page.tsx`'s `parseSuggestionParams()` hand-reconstructs a `ParsedTransaction`-shaped object from URL query params (the chat "ویرایش کن" handoff) without them - every real `parseTransactionWithAI()` return sets all three. Every one of the function's return branches (plain bank-SMS, bank-SMS + merchant override, deterministic merchant fast path, AI + merchant override, AI's own category, AI + `findSimilarCategory` override) now computes and returns all three.
- **Deliberate, documented decision: `needsConfirmation`'s existing values were NOT retrofitted from the new confidence fields.** Verified concretely (not assumed) that doing so would have regressed real, already-shipped, already-tested behavior: the existing "دیجی کالا ۲۵۰ هزار تومن" fast-path test (and the bank-SMS-with-merchant-override tests) resolve via a **tier-2** global-merchant match, which this model correctly rates `categorizationConfidence: "medium"` - but `needsConfirmation` has always been `false` for that exact case, and changing it to require `"high"` would add a confirmation tap to a previously-frictionless, already-shipped fast path with no product sign-off to do so. `needsConfirmation` is therefore left byte-for-byte as before (same computation, same values, confirmed via the full existing test suite passing unchanged); the new fields are strictly additive and can diverge from it on purpose (e.g. a `"medium"` overall `confidenceLevel` while `needsConfirmation` is `false` for a high-AI-confidence category paired with AI-derived, non-deterministic amount/date - both honestly true at once, for different reasons).
- **UI wiring (8.2), additive:** `components/transactions/add-transaction-form.tsx`'s existing confirmation warning (shown only when `needsConfirmation` is true - gate unchanged) now differentiates by `categorizationConfidence`: `"low"` gets a more direct "دسته‌بندی را مطمئن نیستم، لطفاً خودت انتخاب کن" instead of the previous one-size-fits-all copy; `"medium"` keeps the existing, already-shipped softer wording; bank-SMS keeps its own existing dedicated copy regardless of confidence level. `components/chat/chat-interface.tsx` / `trySuggestTransaction()` was checked and needed **no change** - it already gates the suggestion card on `needsConfirmation === false`, i.e. it was already restricted to confident results before this session, matching what Phase 8 would otherwise have recommended.
- **Schema decision: NOT persisted on `Transaction`.** Reasoning: confidence is only ever meaningful at parse/suggestion time, before a transaction is saved; no existing feature (reports, analytics, an admin review queue) reads it back afterward; and this codebase has an established precedent for exactly this call (Phase 5's soft-deletion evaluation: "nothing in the current product surfaces this... so it would be unused persisted state, not a real gap"). No migration was prepared, and none was needed - this is not a deferred schema change, it's a considered "no" backed by the same reasoning this project already uses elsewhere.

### Verified

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`), confirmed unrelated.
- `npm run test`: **51/51 files, 537/537 tests passing** (up from 50/486 at session start; net +1 file - `lib/ai/confidence.test.ts` - and +51 tests), confirmed reliable across two consecutive full runs.
- New/extended test files: `lib/ai/confidence.test.ts` (new, 21 tests - one per named scenario, plus a combine-table and a symmetry check), `lib/bank/extract-bank-amount.test.ts` (+3), `lib/bank/parse-bank-sms.test.ts` (+19), `lib/ai/parse-transaction.test.ts` (+13, spanning 7.2's end-to-end learning tests and 8.3's per-scenario confidence assertions folded into both existing and new tests), `components/transactions/add-transaction-form.test.tsx` (+4).

### Security Improvements

- The `extract-bank-amount.ts` fix prevents a real class of transaction from silently missing deterministic parsing (and, if the AI fallback also failed - rate limit, provider outage - failing to log at all) purely because its bank used `"پرداخت"`/`"انتقال"` instead of `"برداشت"`/`"خرید"`/`"واریز"` as its transaction-label keyword; every such SMS now resolves the same way every other bank's does.
- The new confidence fields make the categorization pipeline's own reasoning inspectable (three separate, named signals instead of one opaque boolean baked across several call sites), directly supporting the roadmap's own "prevent a wrong-category transaction from silently entering financial reports" goal - every case with `needsConfirmation: true` is now machine-distinguishable between "genuinely no categorization signal" (`"low"`) and "some signal, worth a lighter nudge" (`"medium"`), which the UI now surfaces as two different messages instead of one generic warning.

### Remaining Risks

- **13 of 17 banks in `bank-patterns.ts` are still backed by synthetic, not real, SMS samples** (unchanged by this session - this was already known and documented before Phase 7; this session added full-pipeline fixtures for all of them, still synthetic, per the same "placeholder, replace once a real sample exists" convention already established here). A real SMS from any of these banks could still use different keywords/structure than these patterns assume.
- **No confirmed real bank SMS format for embedded absolute dates was found or fixed.** `extractDate()` only recognizes relative Persian phrases (امروز/دیروز/پریروز/هفته پیش) meant for typed free text - a real bank SMS's own date/time footer (the one hint in this repo, the documented Mellat edge case's `"05/05/03-11:03"`, is for a bank that doesn't even detect) is never parsed, so `parseBankSms()`'s `date` field silently defaults to "today" for every real bank SMS, regardless of the transaction's actual date. `jalaali-js` (already a dependency, used elsewhere for Jalali↔Gregorian conversion) could support a real fix, but building one now would mean guessing a date-format regex with zero confirmed real samples - the exact mistake this codebase's own extensive "TODO: verify with real SMS sample" precedent warns against. Flagged, not fixed.
- **Amount separators other than a comma (e.g. a space or the Arabic thousands separator ٬/U+066C) are not recognized** by `extract-bank-amount.ts`'s `AMOUNT_TOKEN` regex - unconfirmed whether any supported bank actually formats amounts this way (every real-sample fixture in this repo already uses commas), so not changed.
- **Amounts under 1,000 toman with no comma grouping are unparseable by design** (`AMOUNT_TOKEN` requires at least one comma group, deliberately, to avoid mistaking account numbers/OTP codes for amounts) - a real bank SMS reporting a sub-1,000-toman transaction would fail extraction. Judged low-likelihood for real bank transactions and not changed, since loosening the regex would reopen the exact false-positive risk it was written to close.
- **`needsConfirmation` and the new `confidenceLevel` can now legitimately disagree** (documented above, by design) - a future consumer of `ParsedTransaction` that assumes the two always agree would be wrong; both fields' own doc comments in `lib/ai/parse-transaction.ts` state this explicitly.

### Deferred

- **Resolving `bank-patterns.ts`'s remaining "TODO: verify with real SMS sample" placeholders** - needs real SMS samples this session doesn't have access to, not a code change.
- **Parsing embedded absolute dates from real bank SMS** - see Remaining Risks; needs at least one confirmed real sample per bank before a format can be implemented without guessing.
- **Recognizing non-comma amount separators** - unconfirmed to be a real gap; not implemented speculatively.
- **Reordering `findMerchant()`'s priority to strictly match the prompt's literal "exact→alias→normalized→user-historical→AI" wording** - deliberately not done; the existing "all of the user's own tiers before the global list" order is judged more correct for a personal-finance app (a user's own past decision should outrank a shared default), and no failing test or reported bug motivates the change.
- **A UI surface for reviewing/re-confirming already-saved low-confidence transactions** (since confidence isn't persisted) - out of this phase's scope; would need the schema decision above to be revisited first if ever wanted.

### Do Not Claim

This does not make bank-SMS parsing "complete" or "verified against real-world data" - 13 of 17 supported banks are still backed by synthetic fixtures, and embedded-date extraction from real bank SMS remains unimplemented (see Remaining Risks). It does not claim "solved categorization" or "calibrated confidence" - the three confidence fields are named levels derived from existing, already-implemented signals (match tiers, AI's own self-reported number, whether the AI was called at all), not a calibrated model trained or validated against real outcome data, and NVIDIA NIM confirmed to provide no extraction-confidence signal of its own. `needsConfirmation`'s actual gating behavior is unchanged from before this session by deliberate choice - Phase 8's new fields inform the UI additively but do not replace the existing gate.

## Fix: `MerchantMapping.merchantKey` Included the Transaction Amount — 2026-08-22

**Corrects a claim made in the Phase 7 & 8 entry above.** That entry's 7.0 inspection note says `updateTransaction()` "already upserts a `MerchantMapping` row... a single correction is enough to create the mapping, not two" and closes 7.2 as verified end-to-end. That much is still true - but the entry never checked what the stored key actually *contains*, and for any real (non-fixture) transaction it didn't generalize the way "learning" implies. This session found and fixed that gap; it does not reopen or redo 7.2's own scope.

- **Root cause, confirmed against the code before changing anything:** `updateTransaction()` (`lib/data/transactions.ts`) stored `merchantKey: normalizeText(existing.rawInput)` - the *entire* raw SMS/typed text, amount included. `normalizeText()` (`lib/normalize.ts`) strips punctuation and Arabic/Persian letter variants but, by its own doc comment, never touches digits. `findBestMatch()` (`lib/merchant-lookup.ts`) requires either an exact match (tier 1) or the *whole* stored candidate's token sequence to appear contiguously in the new input (tier 2) before falling back to a length-gated substring check (tier 3). Since the amount token differs on every real transaction from the same merchant, a learned mapping only ever re-matched a later mention that happened to quote the *identical* amount - defeating the feature for ordinary variable-amount purchases. Confirmed with a failing test first (same merchant text, two different amounts, second resolves via `userMapping`) before writing the fix, per this task's own instruction.
- **Fix:** new `buildMerchantKey(rawInput)` in `lib/merchant-lookup.ts`, used only on the write side (`updateTransaction`'s `MerchantMapping` upsert) - the read side (`lookupUserMapping`/`findBestMatch`) needed no change, since tier 2/3 already tolerate extra tokens (like a trailing amount) in the *new* input being matched against; only the *stored* candidate needed to stop carrying one. No schema/migration - `MerchantMapping.merchantKey` is unchanged (still a plain `String`), only what gets written into it changed, matching this task's "no new column unless nothing already-available covers it" instruction. No dedicated extracted-merchant-name field exists anywhere in the current schema/parsing pipeline to reuse instead (checked `Transaction`, `lib/bank/*.ts`, `lib/ai/parse-transaction.ts` first - bank SMS bodies carry no merchant name at all per that file's own comment, and `description` is user-editable free text, not a reliable amount-free identifier), so a normalization step on `rawInput` was the only fit.
- **What `buildMerchantKey` actually does:** tokenizes `normalizeText(toLatinDigits(rawInput))`, splits the token list wherever a bare digit token or one of the four relative-date words `extractDate.ts` already recognizes (امروز/دیروز/پریروز/هفته/پیش) occurs, and keeps only the *longest* surviving run. Deliberately not a simple filter-and-rejoin: an early version of this fix did exactly that (strip digit/date tokens, join what's left) and a new test caught it producing a false adjacency - e.g. "فروشگاه X ۳۰۰۰۰ تومن" naively became "فروشگاه X تومن", gluing the merchant name directly onto a currency word that was never adjacent to it in the original text, which a *different* amount's later mention (still carrying its own amount token in that same gap) could never reproduce. Splitting into runs and keeping the longest avoids inventing any adjacency that wasn't already there, and as a side effect usually drops a trailing currency/verb word entirely rather than keying on it.
- **Known limits, stated precisely rather than claiming this "now works perfectly":**
  - Only the amount's own digits are stripped, not a spelled-out scale word next to them - "۸۰ هزار تومن" and "۸۰۰۰۰ تومن" for the same purchase can still key differently. This wasn't the bug being fixed (`normalizeText` never stripping digits at all was), so it wasn't chased further.
  - A merchant name that itself contains one of the five stripped relative-date words (e.g. a shop literally named "امروز") would have that word dropped from its key too. Accepted for the same reason `extractDate.ts` already treats these five words as unambiguous, non-merchant signals wherever they appear in this codebase - not a new risk this fix introduces.
  - Bank-SMS-sourced `rawInput` still yields a weak key in practice (bank/label words, not a merchant name) - unchanged from before, since bank SMS bodies never carried a merchant name in the first place (see 7.0's own note above); this fix only stops the amount from also breaking what little signal existed.
- **Tests:** `lib/merchant-lookup.test.ts` - new `buildMerchantKey` describe (7 pure unit tests: digit stripping across Persian/Arabic-Indic/Latin scripts, relative-date-word stripping, same-merchant/different-amount produces the same key, distinct merchants stay distinct, empty-input edge case, and the internal-token/false-adjacency case above) plus a new DB-backed `findMerchant` describe (2 tests: resolves a later mention at a different amount via `userMapping`; two distinct merchants with superficially similar text do not collapse into each other). `lib/data/transactions.test.ts` - existing fixtures switched from `normalizeText(rawInput)` to `buildMerchantKey(rawInput)` (all three pre-existing fixtures happen to have the amount trailing at the very end, so their expected values are unchanged) plus one new regression test going through `updateTransaction()` → `findMerchant()` directly. `lib/ai/parse-transaction.test.ts` - new describe alongside the existing "Phase 7.2, end-to-end" one; that existing block's own fixture never actually exercised this bug (its `merchantText` fixture carries no amount at all at creation time), so a new fixture that bakes the amount into the original correction's `rawInput` (the realistic shape) was added to prove the full `parseTransactionWithAI()` path resolves via `userMapping`, with zero AI calls, for a later mention at a different amount.
- **Verified:** `npx tsc --noEmit` clean. `npm run lint` clean (same 2 pre-existing warnings as the Phase 7 & 8 entry above - `components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`). `npm run test`: **51/51 files, 548/548 tests passing** (up from 51/537 at session start - net +11 tests, no new files). No live-database writes; no schema/migration changes.

## Phase 9, 10 & 11 — AI Architecture Hardening + Financial Intelligence Layer + Chat Context Optimization — 2026-08-22

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **51/51 files, 548/548 tests passing** - matches this session's own prompt's stated baseline exactly, confirmed before starting.

This was, as instructed, largely an audit - a meaningful share of both Phase 9 and Phase 10's asks were already implemented under other headings (Phase 4/12 for 9.1/9.3, Phase 5/8 for parts of 9.2). Per-subtask status below states explicitly what was already done vs. newly built, so this entry doesn't overstate new work.

### Phase 9 — AI Architecture Hardening

**9.1 Gateway (timeout/retry) - missing, now added.** [lib/nvidia-ai.ts](../lib/nvidia-ai.ts)'s `callNvidiaAI()` had no `AbortController`/`signal` at all before this session and no retry of any kind - confirmed via `grep`, not assumed. Both call sites (`chatCompletion`/`streamChatCompletion`) already funneled through this one function, so no duplication existed to centralize; the fix was added once, here.
- **Timeout:** `NVIDIA_REQUEST_TIMEOUT_MS = 30_000`, one shared value for both call sites via a new `fetchWithTimeout()` helper. Sized against the larger of the two output caps (`CHAT_REPLY_MAX_TOKENS = 1000`): for `streamChatCompletion`, `fetch()`'s promise resolves once the response starts streaming (well before the full generation completes), so this bounds time-to-first-byte; for `chatCompletion`'s non-streaming call, the provider typically doesn't respond until the full completion is ready, so this bounds the whole generation. 30s is multiple times a realistic generation time for either cap on a hosted 70B-class model - generous headroom while still failing a genuinely stuck request in bounded, user-visible time. Verified it actually fires, not just that the option is set: `lib/nvidia-ai.test.ts`'s new "aborts the request... within the timeout" test uses `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(NVIDIA_REQUEST_TIMEOUT_MS)` against a `fetch` mock that only resolves/rejects on the `AbortSignal` actually firing - a real assertion that the abort happens, not just that a timer was scheduled.
- **Retry:** deliberately narrow, one retry, connection-level failures only (`fetch()` itself rejecting with a `TypeError` - DNS failure, connection refused, TLS handshake failure; see `isConnectionLevelFailure`'s own comment). Explicitly NOT retried: an HTTP-level error response (4xx/5xx - the request reached the server and was processed some way, so blindly retrying risks double-billing/duplicating a partially-succeeded completion) or our own timeout abort (`AbortError` - the provider may already be mid-generation when that fires, carrying the same "maybe already partially succeeded" risk as a 5xx). 4 new tests cover: retry-and-succeed, give-up-after-one-retry (bounded, not unbounded), no-retry-on-HTTP-error, no-retry-on-timeout.

**9.2 Structured output - already done, one real gap found and fixed.** Re-confirmed `isRawParsedTransaction` (amount/type/category), `sanitizeNewCategorySuggestion` (exact-key allowlist), `findValidatedLeafCategory` (category/subcategory pair validated against the real hierarchy), and `detect-transaction-intent.ts`'s boolean-only validation all still cover what the roadmap's list asks for. **Gap: `date` was only checked via `!Number.isNaN(Date.parse(parsed.date))`** ([lib/ai/parse-transaction.ts](../lib/ai/parse-transaction.ts)) - V8's `Date.parse()` non-ISO fallback parsing is lenient/implementation-specific and doesn't confirm the AI actually followed the prompt's own "YYYY-MM-DD" instruction. Fixed with a new `isValidIsoDateString()` that checks the exact shape *and* that the numbers form a real calendar date (a regex alone would still accept `"2024-02-30"`). Matters concretely here since `date` determines which calendar month a transaction lands in for every downstream monthly report. 4 new tests: well-formed date accepted as-is, a calendar-invalid date falls back to today, a non-ISO-shaped date falls back to today, a missing date falls back to today.

**9.3 Prompt limits - already done**, confirmed: `MAX_CHAT_MESSAGE_LENGTH` enforced server-side ([app/api/chat/route.ts:112](../app/api/chat/route.ts#L112)), `MAX_CATEGORY_LINES`/`MAX_RECENT_LINES` cap context, `HISTORY_MESSAGE_CHAR_CAP` + 16-message cap, `JSON_EXTRACTION_MAX_TOKENS`/`CHAT_REPLY_MAX_TOKENS` cap output. The one gap (timeout) is the same gap as 9.1 and was fixed once, not duplicated.

**9.4 Cost/latency tracking - token usage was a real gap, now added; cost estimation evaluated and skipped.**
- **Token usage:** NVIDIA NIM's OpenAI-compatible response does include a standard `usage` object (`prompt_tokens`/`completion_tokens`/`total_tokens`) on non-streaming responses - confirmed `chatCompletion()` parsed `data` but never read `data.usage` before this session (discarded). Added via an optional `onUsage` callback on `chatCompletion()`'s `options` param (`lib/nvidia-ai.ts`), **not** by changing the function's return shape from a plain `string` to e.g. `{content, usage}` - that would have forced updating ~30 existing `chatCompletion`-mocking call sites across `lib/ai/parse-transaction.test.ts`/`lib/ai/detect-transaction-intent.test.ts` for a purely additive observability signal, none of which needed to change. Both real callers (`parse-transaction.ts`'s `parseTransactionWithAI`, `detect-transaction-intent.ts`) now pass `onUsage` and fold the result into their existing success `logger.info(...)` call as an additive `usage` field - no new log call, per the phase's own instruction. Verified with dedicated tests (`nvidia-ai.test.ts`: callback receives the parsed usage / is not called when the response omits `usage`; `parse-transaction.test.ts`/`detect-transaction-intent.test.ts`: one new test each confirming `usage` actually reaches the logged fields, via a mocked `logger.info`).
  - **`streamChatCompletion()` (the chat route's call site) does not get this.** OpenAI-compatible streaming usage requires opting in via `stream_options: {include_usage: true}` (a vLLM/OpenAI-standard mechanism), which this session has no way to verify NVIDIA NIM's hosted endpoint actually honors (no live API key/network access here) - adding it speculatively risks silently doing nothing (if ignored) or requires restructuring the SSE parsing to separate a final usage-only chunk from content chunks (materially bigger than "wrap the call"). Deferred, not implemented - flagged for a session with live API access to confirm against.
- **Estimated cost: evaluated, explicitly skipped.** Researched (WebSearch) NVIDIA NIM pricing for the actual endpoint this app is configured against (`NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`, the build.nvidia.com hosted developer catalog - confirmed via `.env.example`). Findings: NVIDIA's own hosted catalog at this endpoint has **no published stable per-token price** - it's free for prototyping under an informal request-rate ceiling (commonly cited as ~40 RPM, not a published SLA), not a metered per-token billing model; the specific per-token figures that do exist online come only from third-party SEO/aggregator pricing sites (aipricing.org, apicents.com, deploybase.ai, costbench.com, and similar), not NVIDIA's own docs, and are inconsistent with each other and with what this app's own model/endpoint combination would actually be billed under. Per this phase's own instruction ("only add this if a real, current per-token price... is knowable and stable enough to hardcode without being misleading - otherwise skip it and say why, don't fabricate a number"), this was skipped rather than hardcoding a number from an unverifiable third-party source.
- **Sanitized-params-only pattern - confirmed preserved.** Every `reportError()`/`logError()` call site inspected in this session still passes only lengths/counts/enum-like values (`rawInputLength`, `messageLength`, `contentLength`, `provider`, `operation`/`model` names) - no raw prompt/response text. Unaffected by this session's changes (the new `usage` field is itself just three small numbers).

### Phase 10 — Financial Intelligence Layer

All five items the roadmap's own list called out as genuinely missing were confirmed missing (re-read [lib/analytics/spending-summary.ts](../lib/analytics/spending-summary.ts) in full first, per the prompt's instruction) and implemented as pure, DB-free functions taking transaction arrays in (mirroring `summarizeMonth`/`computeCategoryTrends`'s existing pattern), wired into `getSpendingSummary()`, extending `SpendingSummary` additively:

- **`incomeChange`/`expenseChange`** (`computeOverallChange`, [lib/analytics/spending-summary.ts:262](../lib/analytics/spending-summary.ts#L262)): overall (not per-category) month-over-month percent change for income and expense separately, omitted (not `Infinity`/`NaN`) when there's no previous-month baseline - same "omit rather than mislead" rule `computeCategoryTrends` already follows. Zero extra queries (derived from `currentMonth`/`previousMonth`, both already computed).
- **`savingsRate`** (`computeSavingsRate`, [line 269](../lib/analytics/spending-summary.ts#L269)): `(income - expense) / income` for the current month as a rounded percent, omitted when `income <= 0`. Zero extra queries.
- **`unusualTransactions`** (`computeUnusualTransactions`, [line 290](../lib/analytics/spending-summary.ts#L290)): a current-month expense transaction >= `UNUSUAL_TRANSACTION_MULTIPLIER` (3x, a named constant, not inline) times the average of that *same category's other* transactions this month; a category needs >=2 transactions this month to have a baseline at all. **Deliberately scoped to the current month only, not a longer historical average** - this keeps it a zero-extra-query pure function over `currentTransactions` (already fetched), at the acknowledged cost of only catching within-month outliers, not "unusual vs. your normal months" (see Remaining Risks).
- **`recurringExpenses`** (`computeRecurringExpenses`, [line 341](../lib/analytics/spending-summary.ts#L341)): a normalized description appearing as an expense in >= `RECURRING_EXPENSE_MIN_MONTHS` (2) of the last `RECURRING_EXPENSE_LOOKBACK_MONTHS` (3) months (current + 2 prior) - stricter than `topMerchants` (which only needs >1 occurrence *within one month*), specifically targeting things that repeat across separate billing cycles (subscriptions, rent) rather than a merchant visited twice in one busy week. The grouping/normalization logic itself was extracted into a new shared `groupByDescription()` (used by both `computeTopMerchants` and this), per the phase's own "don't duplicate the grouping logic outright" instruction. **Needs one new raw-transaction query** ([lib/analytics/spending-summary.ts:595-603](../lib/analytics/spending-summary.ts#L595-L603)): `SpendingSummaryCache`'s payload only stores pre-aggregated category totals, not per-transaction descriptions, so the prior 2 months' descriptions aren't reconstructable from the cache - one combined query spanning both prior months (split by date boundary in JS) rather than two separate round-trips.
- **`cashFlowTrend`** (`computeCashFlowTrend`, [line 513](../lib/analytics/spending-summary.ts#L513)): net income/expense for each of the last `CASH_FLOW_TREND_MONTHS` (4) months, oldest first. **Reuses the existing cache**, per the phase's explicit instruction not to add a parallel uncached path: `getCachedPreviousMonth`/`computeAndCachePreviousMonth` were generalized (renamed `getCachedMonth`/`computeAndCacheMonth`, same bodies, no behavior change for the existing previous-month case) into a new `getOrComputeMonth()`, which the trend's 2 further-back months now go through - a repeat call for the same user/month is a cheap indexed cache read, not a full re-aggregation.

**Cost/latency tradeoff, stated plainly:** `getSpendingSummary()` is `getFinancialContextSummary`'s sole data source, which runs on **every chat message** - the same reason `SpendingSummaryCache` exists at all (its own doc comment: "saves a full aggregation query on nearly every chat message"). This session's additions add, per call: 1 new raw-transaction query (recurring-expenses lookback) + up to 2 more cache-or-compute round trips (cash-flow's 2 further-back months, cheap on a cache hit, a real `findMany`+`upsert` only the first time a user's data reaches that month). This is a real, bounded addition, not hidden - `CASH_FLOW_TREND_MONTHS` was deliberately set to 4 (not a larger number) specifically to bound this, and `RECURRING_EXPENSE_LOOKBACK_MONTHS`'s 3-month window was chosen the same way.

**Prompt surfacing decision** ([lib/data/chat-context.ts](../lib/data/chat-context.ts)): `incomeChange`/`expenseChange` (folded into the existing "تغییرات نسبت به..." section), `savingsRate`, and `unusualTransactions` (capped at `MAX_UNUSUAL_TRANSACTION_LINES = 3`) are all short, single-fact lines with clear conversational value, so they're rendered into the prompt with the same capping discipline `MAX_CATEGORY_LINES`/`MAX_RECENT_LINES` already establish. `recurringExpenses` is also surfaced (capped at `MAX_RECURRING_EXPENSE_LINES = 5`) - naturally compact given the strict >=2-of-3-months definition. **`cashFlowTrend` is deliberately NOT rendered into the prompt text** - a several-months x 3-numbers table is a poor fit for compact conversational prose and has low marginal value for a single chat turn given `incomeChange`/`expenseChange`/`categoryTrends` already answer "how does this month compare"; it remains available on the returned object "for future tool-calling use", the same precedent this file's own top-of-file comment already sets for the full category/transaction lists.

**Tests:** direct, DB-free unit tests for all 4 new pure functions (`computeOverallChange` x3, `computeSavingsRate` x3, `computeUnusualTransactions` x5, `computeRecurringExpenses` x5 - 16 total), per this phase's explicit "unit-testable without hitting the DB... not just integration coverage" instruction; this required exporting these 4 (previously module-private, matching `summarizeMonth`/`computeCategoryTrends`'s own non-exported-but-now-directly-tested precedent doesn't apply verbatim since those two are still only tested indirectly through `getSpendingSummary` - the new functions are the first in this file to get direct unit tests, a deliberate departure justified by the phase's own explicit ask). Plus a new 5-test DB-backed `describe("getSpendingSummary - Phase 10 fields")` block exercising the actual query-splitting/cache-reuse wiring end to end (real user, transactions across current + previous + 2-months-back), and a new `lib/data/chat-context.test.ts` (3 tests - this file had zero test coverage before this session) confirming the new prompt lines actually render, including the "no baseline" omission wording.

### Phase 11 — Chat Context Optimization

Inspected `app/api/chat/route.ts`/`lib/data/chat-context.ts` fully, per the prompt's instruction, before making any judgment calls. **No code changes made in this phase** - every check either confirmed already-adequate behavior or surfaced a tradeoff to state, not a concrete bug to fix.

- **No conversation summarization on overflow - cutoff-only judged sufficient, not changed.** History is hard-capped at the last 16 messages with no summarization of anything dropped beyond that. Reasoning: this is a personal-finance assistant answering questions grounded in `getFinancialContextSummary`'s structured data (accounts, this month's/last month's numbers, recent transactions), not a long-running agent that needs to remember arbitrary facts from 30 messages ago to function correctly - the financial *state* that actually matters is re-fetched fresh on every turn regardless of chat history length, and `lib/facts/user-facts.ts`'s `UserFact` table already persists the handful of durable facts (name, stated preferences) that would otherwise need to survive a truncated history. No concrete failure mode of the cutoff-only approach was found or reported for this app's actual usage pattern (short, transactional exchanges - "how much did I spend on X", "log this transaction"), so a rolling-summary system was **not** added, per the phase's own explicit instruction not to add one speculatively.
- **Two AI calls per chat turn - kept as-is; tradeoff stated, not silently changed.** `detectTransactionIntent()` (a full NVIDIA NIM round trip) still runs before the main `streamChatCompletion()` call on every message, regardless of whether the message is remotely transaction-shaped. **Cost/latency con:** every chat turn - including "how much did I spend this month" or "hi" - pays for two sequential AI calls instead of one, roughly doubling both latency-to-first-token and per-message AI cost. **Pro (why it's still the right tradeoff today, not changed):** it's the app's only real "tool-calling"-shaped decision point (see that file's own top-of-file comment on why it's not literal OpenAI-style tool-calling - `chatCompletion` has never been sent `tools`/`tool_choice`, and this isn't verified to work reliably against the configured model), and a heuristic short-circuit (e.g. skip the intent check for messages ending in "?", or under some length) would trade a *confirmed-working* fail-safe design (see `detectTransactionIntent`'s own "fails safe to false" doc comment) for an unverified accuracy risk - a false negative there just means one message is answered as normal chat (already the safe default), but a heuristic bypass could just as easily introduce a new false-negative class no test currently covers. Per the phase's own framing ("a judgment call to surface... not something to silently change"), this is surfaced here with both sides stated, not altered.
- **"Avoid sending the entire transaction history" - already satisfied, re-confirmed.** `getFinancialContextSummary` sends `getSpendingSummary`'s structured summary plus the last 10 transactions (capped, and further capped to `MAX_RECENT_LINES = 5` in the rendered prompt text) - not the full table. Holds unchanged after this session's Phase 10 additions (the new fields are similarly capped, see above).

### Verification (all three phases)

- `npx tsc --noEmit`: clean throughout.
- `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`), confirmed unrelated.
- `npm run test`: **52/52 files, 584/584 tests passing** (up from 51/548 at session start - net +1 file (`lib/data/chat-context.test.ts`, new), +36 tests), confirmed reliable across two consecutive full runs.
- New/extended test files: `lib/nvidia-ai.test.ts` (+6: timeout fires, retry-and-succeed, give-up-after-one-retry, no-retry-on-HTTP-error, usage-callback-invoked, usage-callback-not-invoked-when-absent), `lib/ai/parse-transaction.test.ts` (+5: 4 date-validation + 1 usage-logging), `lib/ai/detect-transaction-intent.test.ts` (+1: usage-logging), `lib/analytics/spending-summary.test.ts` (+21: 16 pure-function unit tests across the 4 new exports + 5 DB-backed integration tests), `lib/data/chat-context.test.ts` (new file, +3).
- No live-database writes; no schema/migration changes (Phase 10's new fields are computed, not persisted - matches Phase 8's own established precedent for exactly this kind of "no existing consumer needs this to survive a page reload" call).

### Do Not Claim

This does not make the AI gateway "fully hardened" - the timeout/retry policy covers the two failure classes explicitly named in the prompt (stuck connections, connection-level failures) and nothing else; a provider that responds slowly-but-successfully within 30s pays the full latency with no circuit-breaking, and `streamChatCompletion`'s token usage remains unlogged (see 9.4's own deferral). It does not make financial-intelligence "complete" - `unusualTransactions` compares only within the current month (not a longer historical baseline), `recurringExpenses`' 3-month/2x-presence definition is a judgment call, not a validated model of what "recurring" means to every user, and none of Phase 10's new facts are persisted, so nothing here supports a historical "what did I flag as unusual last March" view. Phase 11 made no code changes - the two-AI-call design and the cutoff-only history strategy are both judgment calls stated with reasoning, not verified against real user conversation logs (none exist in this repo to verify against).

## Phase 15 — Schema & Role Hardening — 2026-08-23

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **52/52 files, 584/584 tests passing** - confirmed by running the suite before making any change, matching the Phase 9/10/11 entry above exactly.

### 15.1 — Is this an authorization vulnerability or a data-integrity gap? (per this task's own step 1)

**A data-integrity/type-safety gap, not an authorization vulnerability - confirmed, not assumed, by writing a failing-first test before touching any code.** `requireAdminSession()`'s gate is `session.role !== "admin"`, a strict whitelist comparison - fed literally anything (`"Admin"`, `"superadmin"`, `""`, a corrupted value), it can only ever evaluate `true` (deny) for every string except the exact literal `"admin"`. There is no string that both fails `isValidRole()` and passes `=== "admin"` - the two checks can't disagree in the dangerous direction. `lib/auth/session.test.ts`'s new `requireAdminSession() does not grant admin for a corrupted-but-not-'admin' value` test proves this directly against a real corrupted row (`role = 'Admin'`, wrong-cased), not just by inspection.

The real risk was exactly what the roadmap already suspected: `user.role as UserRole` doesn't validate anything at runtime - a corrupted role would previously have been silently accepted as whichever of `"user"`/`"admin"` TypeScript's type system was told to believe it was, with no record anywhere that this had happened. That's a silent-bad-data risk, not a privilege-escalation one - `getActiveUser()`'s own return type (`{ id: number; role: UserRole }`) is only ever compared against the literal `"admin"` downstream, never branched on `"user"` vs. "anything else" in a way that could flip the wrong direction.

### 15.2 — DB-level constraint

**Confirmed, not assumed: Prisma 7.9.1 has no `@check`/`@@check` schema attribute at all** (not a sqlite-specific gap - the attribute doesn't exist in this version's grammar). Verified directly: added `@check(name: "role_valid", "role IN ('user', 'admin')")` to a scratch copy of `schema.prisma`'s `role` field and ran `prisma validate` - failed with `Attribute not known: "@check"`. So there is nothing to add to `schema.prisma` for this, and nothing for `prisma migrate diff` to generate - the model keeps `role String @default("user")` exactly as before (comment updated to point at this).

**Mechanism used: a hand-written CHECK constraint**, `prisma/migrations/20260822213426_add_user_role_check_constraint/migration.sql` - the one place in this migration where "never hand-edit what `migrate diff` produced" doesn't apply, because there is no diff output to hand-edit in the first place (documented at length in the migration file's own header comment, including the `@check` experiment above). SQLite has no `ALTER TABLE ... ADD CONSTRAINT` (see `AGENTS.md`), so this reuses the exact "RedefineTables" table-rebuild pattern Prisma's own engine already generated once in this project (`20260806144050_add_category_is_essential`) - a `new_User` table with the CHECK added, data copied over, old table dropped, new one renamed into place, both unique indexes (`phoneNumber`, `email`) recreated. The column list/order/types/defaults were copied verbatim from `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`'s own `CREATE TABLE "User"` output (run offline, no DB touched) rather than hand-transcribed from `schema.prisma`, so it's guaranteed to match what Prisma itself believes the table looks like today. `User`'s nine incoming foreign keys (FinanceAccount, Category, Transaction, ChatMessage, MerchantMapping, Account, SpendingSummaryCache, UserFact, ErrorLog) needed no changes - SQLite resolves them by table name, and the table name/columns are unchanged.

**Verified against the local/test DB, not the live Turso DB, per this task's own instruction.** `test/setup/global-setup.ts` applies every folder under `prisma/migrations/` (oldest first) to the isolated local SQLite file on every `npm run test` run - so this migration has already been applied and exercised for real, dozens of times over, by every test run in this session (`npm run test` passing at all is itself a live confirmation the migration's SQL is valid and doesn't corrupt existing seeded data). Beyond that, `lib/auth/session.test.ts`'s new `DB CHECK constraint on User.role` block asserts the constraint's actual DB-level behavior directly: rejects an `UPDATE` to an invalid role, rejects a `CREATE` with one, and both valid values still work. **This migration has NOT been applied to the live Turso database** - see "Live-DB migration status" below for the exact follow-up.

### 15.3 — Application-level validation (defense in depth)

New `isValidRole(value: unknown): value is UserRole` in `lib/auth/session.ts` (exported so `lib/data/admin-users.ts` shares the exact same check rather than drifting), replacing the `as UserRole` unchecked cast at all three call sites the roadmap and a full-repo `.role`/`role:` sweep actually found:

- **`lib/auth/session.ts`'s `getActiveUser()`:** an invalid role is treated as a data-integrity error - logged via `reportError({ errorType: ERROR_TYPES.AUTH_ERROR, route: "auth/session", ... })` (Phase 12's existing pino+Sentry pipeline; `AUTH_ERROR` was defined in `lib/observability/error-types.ts` but had zero real call sites anywhere in the codebase before this - this is its first actual use) - and the function returns `null` (no active user), exactly the same outcome as an already-blocked or already-deleted user just above it. Not a coercion to `"user"` or `"admin"` in either direction - fails closed instead, so `getSession()` returns `null` and `requireAdminSession()` naturally denies via its existing `!session` branch (see 15.1's test).
- **`lib/data/admin-users.ts`'s `listUsersForAdmin()`:** the two functions read many rows at once, so one corrupted row can't be allowed to take down the whole admin user list. Each row is validated individually; a failing one is logged (same `reportError` shape, plus `targetUserId` in `context` - matching the existing `admin/users/[id]` route's own "acting admin vs. target user" distinction already established there) and left out of the returned `items`, not rendered via a guessed value. `total`/`totalPages` still reflect the raw DB count, so `items.length` can come up one short of `pageSize` on the rare page containing such a row - accepted and documented in-code, not treated as a real pagination bug, since this path only exists for data that should never occur post-migration.
- **`lib/data/admin-users.ts`'s `getUserDetailForAdmin()`:** fetches exactly one user by id, so there's no "skip this row" option that preserves the function's contract. Logs the same way, then throws a new `InvalidUserRoleError` - deliberately **not** `AdminUserNotFoundError` (the row genuinely exists; conflating the two would tell an admin a real account doesn't exist). `app/app/admin/users/[id]/page.tsx`'s existing catch block already only special-cases `AdminUserNotFoundError` and re-throws everything else, so this surfaces as a real error via Next's own error boundary with zero changes needed to that page.

**A third, lower-stakes site was found during the full-repo sweep and deliberately left alone, per this task's own step-5 "do not redesign authorization around roles" boundary:** `app/app/settings/page.tsx` reads `user.role === "admin"` off `getCurrentUser()`'s raw Prisma result (to decide whether to show the "پنل مدیریت" link), not through `getSession()`/`getActiveUser()` at all, and without an `as UserRole` cast (Prisma's plain `role: string` needs none for a `=== "admin"` comparison). Same reasoning as 15.1 applies - a corrupted value just makes this strict comparison false, hiding the link, which is the safe direction, and the real gate for `/app/admin`/`/api/admin/*` is `proxy.ts` + `requireAdminSession()`, both going through the now-validated path. Not touched: `getCurrentUser()` returns the full raw `User` row (used elsewhere for fields other than `role`), and reshaping its return type was a larger, un-asked-for change for a site that was never unsafe to begin with.

### 15.4 — No client-settable path exists (confirmed)

Grepped every `prisma.user.create`/`.update`/`.upsert` call site in the repo (4 total, outside `lib/data/admin-users.ts` itself): `auth.ts`'s phone-OTP `authorize()` (`{ phoneNumber }` only - role takes the schema default), `app/api/auth/onboarding/route.ts` (`{ name, age }` only), `app/api/auth/register/route.ts` (`{ email, passwordHash }` only), and `lib/data/admin-users.ts`'s own `setUserBlocked` (`{ blockedAt }` only). `@auth/prisma-adapter`'s own `createUser`/`updateUser` (used for Google sign-in) only ever write the standard Auth.js user fields (`name`/`email`/`emailVerified`/`image`) - it has no concept of a `role` column at all, and `auth.ts`'s own `jwt`/`session` callbacks never read or forward a `role` from the token/session object either (`role` is deliberately never stored in the JWT - see `getActiveUser`'s own doc comment on why it's a fresh DB read every time). **No client-settable write path for `role` was found** - matching the roadmap's own expectation, so nothing here needed "stop and flag" treatment per this task's step 4.

### 15.5 — Live-DB migration status

**Not applied.** `prisma/migrations/20260822213426_add_user_role_check_constraint/migration.sql` exists in the repo and has been verified against the local/test DB only (see 15.2). Applying it to the live Turso DB, if/when approved, is the same two-part step `AGENTS.md`'s process already documents for every migration here:

1. Apply the migration.sql's exact SQL to Turso via the `@libsql/client` connection path (`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`), one statement at a time - **but first**, run `SELECT id, role FROM User WHERE role NOT IN ('user', 'admin')` against the live DB and resolve any hits, since the migration's `INSERT INTO "new_User" ... SELECT ... FROM "User"` step will fail outright if any existing row already violates the constraint being added. This session has no access to the live DB and did not run that check.
2. Insert the matching bookkeeping row into `_prisma_migrations` (via `scripts/backfill-migration-history.ts`'s existing pattern, after adding this migration's name to its `MIGRATION_NAMES` list).

Per `AGENTS.md`, both steps need a separate, explicit go-ahead before being run for real - nothing in this session wrote to the live database.

### Tests

- `lib/auth/session.test.ts` (new file - this module had zero test coverage before this session): `isValidRole` (8 cases - both valid values, empty string, wrong casing, unrelated strings, `null`, `undefined`, non-string values), `getSession` (normal role unchanged; corrupted role -> `null` + exactly one `reportError` call with `errorType: "AUTH_ERROR"`; `requireAdminSession()` still denies a corrupted-but-differently-cased "admin"-like value), `DB CHECK constraint on User.role` (rejects an invalid `UPDATE`, rejects an invalid `CREATE`, still accepts both real values). The corrupted-row fixtures use `$executeRawUnsafe` wrapped in `PRAGMA ignore_check_constraints = ON/OFF` (SQLite's own documented escape hatch for loading data that predates a constraint) - a plain `prisma.user.update({ data: { role: "..." } })` is no longer capable of creating an invalid row at all once the CHECK constraint from 15.2 is in place, confirmed as its own separate assertion in the same file.
- `lib/data/admin-users.test.ts` (new file, same "zero coverage before this session" starting point): `listUsersForAdmin` (normal role passes through; a corrupted row is excluded + logged with `targetUserId` in `context`, without affecting any other row in the same page), `getUserDetailForAdmin` (normal role passes through; a corrupted role throws `InvalidUserRoleError`, not `AdminUserNotFoundError`, and logs).
- `npx tsc --noEmit`: clean. `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`). `npm run test`: **54/54 files, 602/602 tests passing** (up from 52/584 at session start - net +2 files, +18 tests), confirmed reliable across two consecutive full runs. `next build` (Turbopack): clean, all 20 routes generated, no new warnings.

### Do Not Claim

This does not claim "role is now fully validated end-to-end" - the DB-level CHECK constraint exists only in this repo's migration file and the local/test DB; it has **not** been applied to the live Turso database (see 15.5), so until that separate, explicit step happens, the live DB's own defense against a bad write is application-level only (`isValidRole()` at read time - real, tested, and independent of the DB constraint, but not the same guarantee). It does not claim this closed an authorization vulnerability, because inspection plus a real corrupted-row test both confirmed there wasn't one (see 15.1) - this is data-integrity/defense-in-depth hardening, exactly as the roadmap itself framed it. It does not claim every `role`-adjacent read in the codebase now goes through `isValidRole()` - `app/app/settings/page.tsx`'s admin-link visibility check still reads the raw value directly (see 15.3), left alone deliberately because it was already safe and touching it was outside this task's stated scope.

## Phase 16 — Test Strategy (gap-filling) — 2026-08-23

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **54/54 files, 602/602 tests passing** - confirmed by running the suite before making any change, matching the Phase 15 entry above exactly. This was a gap-filling task against the checklist below, not a from-scratch suite - existing coverage was read first, not assumed, for every item.

### Step 0 — confirmed gap inventory (before writing any test)

Enumerated every `*.test.ts`/`*.test.tsx` file in the repo and cross-referenced against each checklist section. Results below are what was actually found, not what the prompt assumed:

- **No test file existed** (confirmed via `find` + `grep`, not assumed) for: `app/api/auth/send-otp/route.ts`, `app/api/auth/logout/route.ts`, `app/api/auth/onboarding/route.ts`, `app/api/admin/users/[id]/route.ts`, `app/api/admin/default-categories/route.ts` and its `[id]` route, `app/api/log-error/route.ts`, `auth.ts` (the NextAuth config), `lib/auth/password.ts`, `lib/auth/phone.ts`. All nine confirmed real gaps - filled (see below).
- **`lib/auth/otp.test.ts` (re-read in full):** covers `generateOtpCode`, `createOtpToken`/`verifyOtpToken` round-trip/expiry/tampering, and `sendOtpSms`'s dev-mock-vs-production-fail-closed branches (i.e. the checklist's "production mock disabled" item was **already covered**, confirmed by reading the two existing tests, not assumed missing). It does **not** touch `auth.ts`'s `authorize()` at all - the full attempt-counting/lockout/reuse/rate-limit state machine lives entirely in that closure and had zero coverage. Confirmed real gap, filled.
- **Authorization (admin routes):** `app/api/admin/users/[id]/route.ts` and `app/api/admin/default-categories/**` had no test of any kind, so "a non-admin is rejected" was unverified for both - confirmed real gap, filled for all four handlers (PATCH/DELETE, GET/POST, PATCH/DELETE).
- **Transactions:** idempotency (SEC-10), pagination, and cross-user ownership at the **data-layer** (`lib/data/transactions.test.ts`) were already thorough and current - confirmed by reading the file, not re-tested. But **`POST /api/transactions`'s malformed-input validation and `PATCH`/`DELETE /api/transactions/[id]`'s validation/not-found/ownership had no route-level test at all**, and **`DELETE /api/transactions/[id]` had zero test coverage of any kind** (not even a happy path) - confirmed real gaps, filled.
- **Bank parser:** re-confirmed all 17 members of the `Bank` union already have at least one full-pipeline fixture (Phase 7's own work) - checked via `grep`, nothing missing.
- **Categorization:** re-confirmed exact/alias/unknown-merchant/user-mapping/low-confidence/AI-fallback are all covered (Phase 7/8) - nothing missing.
- **AI:** timeout, retry, malformed output, `max_tokens`/prompt-length caps, invalid-category/invalid-amount validation, and oversized-input rejection were all already covered (Phases 4, 8, 9) - confirmed by reading the actual tests, not the changelog prose alone. **One real gap found**: neither `app/api/transactions/parse/route.ts` nor `app/api/chat/route.ts` had a route-level test proving what happens when the underlying AI call actually fails (`nvidia-ai.test.ts` only proves `chatCompletion()`/`streamChatCompletion()` themselves reject on an HTTP error - nothing exercised the route's own catch block, status code, or `ErrorLog`/`reportError` side effects). Filled for both routes.
- **Database - migration:** `lib/auth/session.test.ts`'s `"DB CHECK constraint on User.role"` block already exercises Phase 15's migration directly against the real (test) DB on every run - confirmed already covered, nothing added.
- **Database - relationships (cascade):** **no test anywhere deleted a user and verified the cascade** - confirmed via `grep` across every `*.test.ts` for "cascade" (zero hits). Real gap, filled - and filling it surfaced a real bug (below).
- **Database - deletion behavior (Restrict):** **no test anywhere covered `AccountInUseError`/`CategoryInUseError`** (`grep` for the error names, zero hits in any test file) despite `lib/data/accounts.ts`/`categories.ts` having implemented them since Phase 5. Real gap, filled for both, plus a direct DB-level test of `Category.parent`'s self-referential Restrict (which `deleteCategory()` itself does **not** pre-check - see Remaining Risks) and `DefaultCategory`'s equivalent parent/child Restrict via `deleteDefaultCategory()`'s own explicit guard.
- **Database - transaction integrity (idempotency):** re-confirmed current and thorough at both the data and route layers (Phase 4's SEC-10 work) - nothing added.

### A real, previously-unknown bug found and fixed while filling the cascade-delete gap

Writing the "delete a user, verify the cascade" test the checklist asked for immediately failed - not because the test was wrong, but because **`lib/data/admin-users.ts`'s `deleteUserAsAdmin()` was already broken for almost every real user in the app.** Root-caused before writing any fix, per this project's own "Inspect First" convention:

- A bare `prisma.user.delete({ where: { id } })` throws a genuine SQLite `FOREIGN KEY constraint failed` (Prisma error `P2003`) whenever the target user has **any** `Transaction`, **any** `MerchantMapping`, or (the far more common case) **any category with a parent** - which is every normally-onboarded user, since `seedDefaultsForUser()` always creates a parent+child category pair. Confirmed this is a genuine SQLite cascade-ordering limitation, not a Prisma quirk: reproduced with a raw `$executeRawUnsafe("DELETE FROM \"User\" WHERE id = ?")` bypassing Prisma's query layer entirely, same failure.
- Cause: `Transaction.account`/`Transaction.category`/`MerchantMapping.category` are `onDelete: Restrict`, and `Category.parent` is a self-referential `onDelete: Restrict` - all four are also transitively `onDelete: Cascade` from `User`. SQLite's own cascade processing does not guarantee it deletes the Restrict-referencing child rows before the rows they Restrict-reference, within one multi-table cascade triggered by a single `User` delete - so a Restrict constraint can fire mid-cascade even though every row involved was ultimately headed for deletion anyway.
- **Fix** (`lib/data/admin-users.ts`): `deleteUserAsAdmin()` now explicitly deletes, inside one `prisma.$transaction([...])`, in dependency order - `Transaction` rows, then `MerchantMapping` rows, then child `Category` rows, then parent `Category` rows, then the `User` row itself (children-before-parents for categories mirrors the exact pattern this codebase's own test cleanup code already used, e.g. `lib/data/categories.test.ts`'s `cleanupUser`). After that, nothing Restrict-references anything left for the `User` row's own cascade to touch.
- Confirmed this was the *only* live call site: `grep`-ed the whole repo for `.user.delete(` outside tests - `deleteUserAsAdmin()` is the sole real place a `User` row is ever deleted, so this is a complete fix, not a partial one.
- Regression tests (`app/api/admin/users/[id]/route.test.ts`): one full-cascade test (creates one row of `FinanceAccount`/`Category`/`Transaction`/`ChatMessage`/`MerchantMapping`/`SpendingSummaryCache`/`UserFact` for a target user, deletes via the real admin route, asserts every one is gone) and a second, narrower regression test reproducing the more commonly-hit shape of the bug specifically (a plain `seedDefaultsForUser()`-onboarded user with **no** transactions at all - proves the bug wasn't only about transactions).

### What was built

- **New test files (10, 83 tests):** `auth.test.ts` (9 - the `phone-otp` provider's full OTP state machine, see below), `lib/auth/password.test.ts` (5), `lib/auth/phone.test.ts` (14), `app/api/auth/send-otp/route.test.ts` (5), `app/api/auth/logout/route.test.ts` (4), `app/api/auth/onboarding/route.test.ts` (8), `app/api/admin/users/[id]/route.test.ts` (14), `app/api/admin/default-categories/route.test.ts` (8), `app/api/admin/default-categories/[id]/route.test.ts` (11), `app/api/log-error/route.test.ts` (5).
- **Extended existing test files (32 new tests across 6 files):** `lib/data/accounts.test.ts` (+2, `AccountInUseError`), `lib/data/categories.test.ts` (+3, `CategoryInUseError` + `Category.parent` Restrict), `app/api/transactions/route.test.ts` (+11, `POST` malformed-input/validation), `app/api/transactions/[id]/route.test.ts` (+14, `PATCH` validation/not-found/ownership + a brand-new `DELETE` describe block), `app/api/transactions/parse/route.test.ts` (+1, AI provider failure -> 502 + `ErrorLog`), `app/api/chat/route.test.ts` (+1, `streamChatCompletion` failure -> 502).
- **`auth.ts` refactor (behavior-preserving):** the `phone-otp` `Credentials` provider's inline `authorize()` closure was extracted to a named, exported `authorizePhoneOtp()` function, referenced as `authorize: authorizePhoneOtp` in the same provider config - same body, same behavior, just directly importable for a test. This was necessary, not a style choice: `NextAuth({...})` consumes its `providers` array internally with no way to reach back into one provider's closure from the returned `{ handlers, auth, ... }`, and driving this through `handlers.POST` instead would mean reimplementing NextAuth's own CSRF/cookie-encoding machinery just to run a test - exactly what this task's own instructions said not to do.
- **`vitest.config.ts` fix (enabled the above):** importing `auth.ts` for real (needed so `authorizePhoneOtp` is the actual production closure, not a hand-rolled stand-in) failed under Vitest with `Cannot find module '.../node_modules/next/server' imported from '.../node_modules/next-auth/lib/env.js'` - confirmed via a standalone probe import, not assumed. Root cause is on the `next`/`next-auth` side (this installed `next` 16.2.12 has no `exports` field in its `package.json` at all, and `next-auth/lib/env.js` imports the extension-less `"next/server"` specifier with its own `@ts-expect-error` comment acknowledging this), not something wrong with this repo's code - Next's own webpack/Turbopack build never hits this, only Vitest's plain Node ESM resolution does. Fixed the same way this file already fixed an analogous `server-only` resolution gap (Phase 4.2.6): a `resolve.alias` mapping the exact bare specifier to the real file, plus `test.server.deps.inline: ["next-auth"]` (needed for the alias to even apply - Vitest externalizes `node_modules` packages, bypassing Vite's own resolver/alias handling, unless told to inline them; confirmed empirically that the alias alone did nothing without this). Verified this doesn't change behavior for any existing test: full suite re-run clean before moving on.
- **`authorizePhoneOtp` (the phone-otp provider's OTP state machine) - every checklist scenario covered directly against the real closure:** valid code (new user created, returning user reused, no duplicate row), the OTP cookie deleted after success (so a resubmitted/reused code is rejected as expired, not silently re-accepted), invalid code format (rejected before the cookie is even read), no cookie / expired cookie, wrong code (cookie re-signed with `attempts + 1`, remaining-attempts count in the thrown error's `.code`, and the *same* correct code still works on retry), too many wrong attempts (locks out, deletes the cookie, and the correct code is then rejected too since the cookie carrying the attempt count is gone), and `OTP_VERIFY_PHONE_RULE`'s rate limit (blocks the 9th verify attempt for one phone within the window, isolated from the separate per-code attempt lockout via a fresh cookie each iteration).
- **`app/api/auth/send-otp/route.test.ts`:** invalid phone (400, no SMS call), valid phone (200, cookie set, decodes to the right phone/zero attempts), SMS provider failure (502, no cookie set, a real `ErrorLog` row recorded with the provider's message - not the phone number), and the resend cooldown - both `OTP_REQUEST_PHONE_RULE` (5th request for one phone within 15 min -> 429) and `OTP_REQUEST_IP_RULE` (16th request from one IP within an hour -> 429, regardless of phone).
- **`app/api/admin/users/[id]/route.test.ts`:** non-admin rejected with 403 for both `PATCH` and `DELETE` (target left untouched); block/unblock; `CannotModifySelfError`; not-found; invalid id; the cascade-delete regression above.
- **`app/api/admin/default-categories/route.test.ts` + `[id]/route.test.ts`:** non-admin rejected (403) for all four handlers; validation (missing fields, non-hex color, no-valid-fields-to-update); duplicate name+type (409); not-found (404); parent/child creation; and `DefaultCategoryInUseError` (409, deletes neither row) when deleting a category that still has children.
- **`app/api/log-error/route.test.ts`:** missing/whitespace-only message (400, nothing written); unauthenticated request still logs (`userId: null`); authenticated request attaches the session's `userId`; `stack` is optional.
- **Restrict/in-use deletion tests:** `lib/data/accounts.test.ts`/`categories.test.ts` now prove `deleteAccount`/`deleteCategory` reject (and leave both rows intact) while a `Transaction` references them, and succeed once it's gone. A separate `categories.test.ts` test proves - directly against the DB, not `deleteCategory()`'s own logic - that a parent category with a child is rejected by the schema's `Category.parent` Restrict even when `deleteCategory()`'s own pre-check has nothing to catch it (see Remaining Risks).
- **Route-level transaction validation:** `POST /api/transactions` now has direct tests for missing/non-numeric/non-positive `amount`, invalid `type`, missing `category`/`rawInput`, missing/non-integer `accountId`, an unknown category name (`InvalidCategoryError` -> 400), and an `accountId` that isn't the caller's (`InvalidAccountError` -> 400) - on top of the pre-existing length-limit/idempotency coverage. `PATCH /api/transactions/[id]` gained the equivalent validation set plus 404-for-not-found and 404-for-another-user's-transaction (proving the row is left untouched). `DELETE /api/transactions/[id]` went from **zero** test coverage to 401/400/404/cross-user-404/success.

### Gaps suspected but found already covered (no test added)

Per this task's own instruction to distinguish these from real gaps: OTP production-mock-disabled behavior (`lib/auth/otp.test.ts`), all 17 bank fixtures (Phase 7), categorization's full signal set (Phase 7/8), AI timeout/retry/malformed-output/prompt-limits/invalid-category/invalid-amount (Phases 4, 8, 9), the migration CHECK constraint (Phase 15/`lib/auth/session.test.ts`), and SEC-10 idempotency (Phase 4) were all re-confirmed current by reading the actual test bodies, not re-implemented.

### Remaining Risks

- **`deleteCategory()` still does not pre-check for child categories** the way `deleteDefaultCategory()` does - a parent category with children hits the DB's own `Category.parent` Restrict (confirmed correct - no data corruption, nothing is silently orphaned), but surfaces as an unhandled exception -> a generic 500 through `app/api/categories/[id]/route.ts`'s existing fallback `reportError`+`throw`, not a clean `CategoryInUseError`-style 409. This is a real, narrower UX gap (a worse error message, not incorrect behavior) - **flagged, not fixed**: this task's scope is test coverage, and this codebase has an explicit standing precedent (see that same route file's own comment on `P2002` never actually firing) for leaving a spotted-but-unrelated pre-existing gap in place rather than expanding scope mid-task. Distinct in kind from the `deleteUserAsAdmin()` bug above, which was fixed because it made a core admin feature fail for essentially every real user, not a narrow edge case.
- **13 of 17 `bank-patterns.ts` entries are still backed by synthetic SMS samples** (unchanged, pre-existing, see Phase 7's own entry) - not this phase's scope.
- **`streamChatCompletion()`'s token usage remains unlogged** (Phase 9.4's own documented deferral) - unchanged.
- Everything in Phase 8/9/15's own "Do Not Claim" sections still applies unchanged - this phase didn't touch confidence modeling, financial-intelligence definitions, or role validation.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`).
- `npm run test`: **64/64 files, 717/717 tests passing** (up from 54/602 at session start - net +10 files, +115 tests), confirmed reliable across two consecutive full runs.
- `next build` (Turbopack): clean, all 20 routes generated (including the `auth.ts` refactor and the `admin-users.ts` fix), no new warnings.
- No live-database access at any point - every test in this phase runs against the isolated local-SQLite test datasource, same as every prior phase.

### Do Not Claim

This does not claim "full test coverage" or a "comprehensive regression suite" - it closes the specific, confirmed gaps listed above against this phase's checklist, nothing broader. Known, deliberately untested surface: NextAuth's `email-password` provider's `authorize()` closure (not extracted or tested - out of this phase's explicit OTP-focused checklist scope, and `app/api/auth/register/route.test.ts` already covers account creation for that path); the Google OAuth `signIn` callback's account-linking logic in `auth.ts` (not reachable without a real Google ID token, genuinely hard to unit-test, and not named in this phase's checklist); `deleteCategory()`'s missing child-category pre-check (see Remaining Risks - a real but narrower, out-of-scope gap, not silently ignored); and this phase does not claim the `deleteUserAsAdmin()` fix has been verified against the live Turso database - only the isolated local-SQLite test datasource, per this project's standing no-live-DB-access convention for every test-writing phase.

## Phase 17 — Performance — 2026-08-23

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **64/64 files, 717/717 tests passing** - taken from the Phase 16 entry immediately above (same date, no code touched in between reading it and starting this phase's edits), not re-run fresh from a clean checkout.

Per this phase's own rule ("measure before optimizing"), every change below is backed by an actual query pattern shown in this codebase and, where practical, a real `EXPLAIN QUERY PLAN`/timing comparison against the local SQLite test DB - not speculation. The measurement scripts were disposable one-off `tsx` files (own throwaway SQLite DB, own seed data, deleted immediately after use) - never touched the shared `.vitest-test.db` a live `npm run test` run uses, and never touched the live Turso DB.

### 1. Inspection findings (every query in `lib/data/*.ts` and `app/api/**/route.ts`, plus `lib/analytics/`, `lib/reports/`, `lib/facts/`, `lib/merchant-lookup.ts`, and client-side `fetch()` usage)

**Confirmed and fixed:**

- **`lib/data/dashboard.ts`'s `getDashboardData()` `totalBalance`** (the roadmap's own pre-flagged starting point): `financeAccount.findMany({ include: { transactions: { select: { amount, type } } } })` loaded **every transaction row ever created** for each of the user's accounts, just to sum `amount`/`type` in JS - unbounded work that grows forever with usage, on the single most-loaded page in the app.
- **`lib/analytics/spending-summary.ts`'s `getSpendingSummary()` `totalBalance`** - **a second, previously-undocumented copy of the exact same bug**, found during the "go through each data-access file" sweep this task asked for, not something the roadmap's own starting point had named. Same `financeAccount.findMany({ include: { transactions: {...} } })` pattern, same unbounded full-history load - and arguably the hotter of the two copies: `getSpendingSummary()` is `getFinancialContextSummary`'s sole data source, which runs on **every chat message** (Phase 10/11's own framing), not just every dashboard page view. Treated as a genuine "other finding" under this task's step 3 (not a re-statement of step 2's item) and fixed the same way, sharing one implementation rather than duplicating the fix.

**Checked and confirmed already fine (no change):**

- **`getDashboardData()`'s other two `Promise.all` queries** - `monthTransactions` (date-range-filtered to the current Jalali month) and `recentTransactions` (`take: 5`) - both already bounded, not unbounded-growth patterns.
- **`getSpendingSummary()`'s other queries** - `currentTransactions` (current-month range), `recentTransactions` (`take: RECENT_TRANSACTIONS_TAKE = 10`), `lookbackExpenseTransactions` (bounded to a fixed 2-prior-month window), and the previous-month `SpendingSummaryCache` reuse (Phase 9/10's own work) - all already bounded or cached, not re-touched.
- **`listTransactions()` in `lib/data/transactions.ts`** - already paginated (Phase 4.1 follow-up #3), `pageSize` hard-clamped to `MAX_TRANSACTIONS_PAGE_SIZE`. Re-confirmed no route bypasses it: every `app/api/**/route.ts` handler and every `app/app/**/page.tsx` server component that reads transactions was checked, and the only two paths that read `Transaction` rows in bulk are this function and `getSpendingSummary`'s/`getDashboardData`'s own bounded queries above.
- **`GET /api/accounts` / `GET /api/categories`** - still unpaginated, but re-confirmed still fine per the Phase 4.1 follow-up #3 reasoning already on record (bounded by real-world account/category counts per user, no per-transaction growth vector, no live frontend caller of either GET route today) - nothing new found to change that conclusion.
- **`listAccountsWithUsage()`/`listCategoriesWithUsage()`** (`lib/data/accounts.ts`/`lib/data/categories.ts`) - already use `transaction.groupBy({ by: ["accountId"/"categoryId"], _count })` for the usage-count column, not a per-row N+1 - already the same aggregate-not-load-everything shape this phase's dashboard fix moves *toward*.
- **Admin routes** (`lib/data/admin-users.ts`, `admin-logs.ts`, `admin-stats.ts`) - `listUsersForAdmin`/`listErrorLogsForAdmin` are both properly paginated (`skip`/`take` + a matching `count()`); `getAdminOverviewStats`'s 6-month trend runs one `transaction.aggregate()` per month (6 small, bounded queries), not a per-transaction load.
- **`lib/facts/infer-facts.ts`** - each inference query is bounded to a fixed lookback window (90/120/180 days), and the whole module is confirmed **not wired into any request path** (own doc comment, verified via `grep` for callers) - not a live performance concern regardless.
- **AI calls** (`lib/nvidia-ai.ts`, `lib/ai/parse-transaction.ts`, `lib/ai/detect-transaction-intent.ts`, `app/api/chat/route.ts`) - re-confirmed Phase 11's two-calls-per-turn analysis still holds (same code, not touched); `parseTransactionWithAI`'s deterministic-fast-path-before-AI structure (Phase 12 audit) still means a bank-SMS/confident-merchant-match transaction never reaches the AI call at all. Not re-litigated per this task's own instruction.
- **Duplicate parsing** - confirmed no request path parses the same SMS/text twice: `parseTransactionWithAI` is called once per `/api/transactions/parse` request and once per `trySuggestTransaction` call in `/api/chat`, never both in the same request; `detectTransactionIntent` and `parseTransactionWithAI` are two AI calls with two distinct jobs (binary intent trigger vs. actual extraction), not the same work done twice.
- **Client-side fetching** (`components/**`) - every `fetch()` call site was checked (`chat-interface.tsx`, `add-transaction-form.tsx`, `accounts-manager.tsx`, `categories-manager.tsx`, `default-categories-manager.tsx`, `user-danger-zone.tsx`, `user-row.tsx`, `transaction-list-item.tsx`, `profile-facts-form.tsx`, auth forms). Every one of these components receives its initial list data as server-rendered props (from the server component that already fetched it) and only calls `fetch()` in response to an explicit user action (form submit, delete click) - none fire on every render/mount or duplicate a server component's own fetch. `add-transaction-form.tsx`'s only `useEffect` is an abort-controller cleanup on unmount, not a data fetch.

**Found, real, but deliberately not fixed here - flagged for future attention:**

- **`lib/merchant-lookup.ts`'s `lookupUserMapping()`** loads **every** `MerchantMapping` row for a user (`findMany({ where: { userId }, include: {...} } })`, no `take`/pagination) on every transaction parse that doesn't hit a deterministic bank-SMS match, to run fuzzy text matching (`findBestMatch`) against the full candidate set in memory. This is a real unbounded-`findMany` pattern in the same family as the totalBalance bug, but judged out of scope to fix speculatively this phase: (1) `MerchantMapping` grows by one row per **unique** merchant a user's transactions ever get (re)categorized to (write path: `updateTransaction`'s upsert on `{userId, merchantKey}` when the category changes) - not one row per transaction, so it grows far slower than `Transaction` does; (2) the fuzzy/normalized-text matching this function does genuinely needs the full candidate set in memory today - there's no existing DB-level index or filter that could narrow it down first without either building full-text-search infrastructure this app doesn't have, or risking missing the correct fuzzy match; (3) no evidence (measured or otherwise) was found that this is actually slow for any real user's mapping count. Not fixed - noted here so it isn't silently forgotten if a user's mapping count ever grows large enough to matter.

### 2. `totalBalance` fix

New shared `getTotalBalance(userId, client = prisma)` in `lib/data/accounts.ts`, used by both `lib/data/dashboard.ts`'s `getDashboardData()` and `lib/analytics/spending-summary.ts`'s `getSpendingSummary()` (via its own `client` DI param, unchanged) instead of each keeping its own copy of the same bug. Replaces the full-history load with:

```ts
const [accounts, balanceGroups] = await Promise.all([
  client.financeAccount.findMany({ where: { userId }, select: { id: true, initialBalance: true } }),
  client.transaction.groupBy({ by: ["accountId", "type"], where: { userId }, _sum: { amount: true } }),
]);
```
then sums `initialBalance + income - expense` per account from the (small, bounded) `balanceGroups` result. `groupBy` (scoped to the user's own `accountId`s via the `userId` filter, matching `listAccountsWithUsage`'s existing precedent for the same shape) was chosen over one `aggregate()` call per account - one query total regardless of account count, versus N. **Return shape and balance formula are byte-for-byte unchanged** - `getDashboardData()`'s return object and `getSpendingSummary()`'s `SpendingSummary.totalBalance` field are identical in shape to before; this is a query-strategy change only, verified by the equivalence tests below (not just "the new query runs").

**Measured (local SQLite test DB, disposable seed: 3 accounts, 20,000 transactions spanning 2020-present, mixed income/expense - through the real generated Prisma Client + `@prisma/adapter-libsql`, the same runtime path `lib/prisma.ts` uses, with Prisma's own query-event logging enabled to capture the literal SQL issued, not a guess):**

| | SQL issued | Rows loaded into JS | Time |
|---|---|---|---|
| OLD (`financeAccount.findMany` + `include: { transactions }`) | 2 queries: `SELECT id,name,type,initialBalance,... FROM FinanceAccount WHERE userId=?` then `SELECT id,amount,type,accountId FROM Transaction WHERE accountId IN (?,?,?)` | 20,000 | 785.9ms |
| NEW (`findMany` select + `groupBy`) | 2 queries: `SELECT id,initialBalance FROM FinanceAccount WHERE userId=?` then `SELECT SUM(amount),accountId,type FROM Transaction WHERE userId=? GROUP BY accountId,type` | 9 (3 accounts + 6 groupBy rows) | 80.9ms |

Both computed the identical `totalBalance` (`-695249000` on that seeded dataset) - confirmed programmatically in the same script, not just visually. ~9.7x faster locally; the gap only grows with a real user's transaction history size, and widens further once real Turso network round-trip cost per row (not just local-file I/O, which this benchmark used) is factored in for the 20,000-row case. This script was a one-off, deleted after use - not committed, not a permanent fixture.

**Regression tests proving identical output to the old calculation** (not just "doesn't error"), per this task's own requirement:
- `lib/data/accounts.test.ts` - new `getTotalBalance` describe block: 3 accounts (one with zero transactions, to prove an account with no `groupBy` rows still contributes its `initialBalance`), mixed income/expense/transfer transactions spread across several months (not just the current one). Compares `getTotalBalance()`'s result directly against a standalone re-implementation of the *old* full-load calculation (kept only in the test file, not reintroduced into application code), and separately pins both to the actual expected number (`2540000`) so a bug shared by both implementations couldn't silently pass the test. A second test confirms the `client` DI param works (mirrors `getSpendingSummary`'s own pattern).
- `lib/data/dashboard.test.ts` - new describe block: 2 accounts, mixed income/expense across several months, `getDashboardData()`'s `totalBalance` compared against the same old-calculation reference, pinned to `1845000`.
- `lib/analytics/spending-summary.test.ts` - new describe block: 2 accounts, mixed income/expense across several months, `getSpendingSummary()`'s `totalBalance` compared the same way, pinned to `1200000`.
- The pre-existing transfer-inclusion tests in both files (`dashboard.test.ts`'s "still counts transfer transactions in totalBalance", `spending-summary.test.ts`'s equivalent) continued to pass unmodified, confirming the transfer-inclusion behavior survived the query-strategy change.

### 3. Other genuine findings from step 1 - fixed

None beyond the `getSpendingSummary()` copy of the `totalBalance` bug (folded into section 2 above, since it's the same fix). Every other finding from step 1 was either already fine (no change) or explicitly flagged as a real-but-deliberately-deferred gap (the `MerchantMapping` lookup, above) - nothing else met the bar of "confirmed real N+1/unbounded-load/duplicate-work pattern."

### 4. Indexes

Checked every existing index (`Transaction`: `[userId, date]`, `[type]`, `[categoryId]`, `[accountId]`; `FinanceAccount`: `[userId]`; `Category`: `[parentId]`; `MerchantMapping`: `[categoryId]` + `@@unique([userId, merchantKey])`; `ChatMessage`: `[userId, timestamp]`) against both the roadmap's suggested list and the new `groupBy` query this phase introduces, per the "leftmost-prefix of a compound index/unique already serves a query filtering on the prefix alone" rule:

- **`userId` alone / `userId + date`** - already served by `Transaction`'s existing `[userId, date]` index. No change.
- **`accountId`** - already exists as its own single-column index. No change.
- **Merchant lookup fields** - `MerchantMapping`'s `@@unique([userId, merchantKey])` already serves `lookupUserMapping()`'s `where: { userId }` filter via its leftmost prefix, same rule as above. No change. (The unbounded-`findMany` shape of that function is a separate concern from indexing - see the flagged-not-fixed finding above; no index would change what "load every row" means.)
- **`userId + categoryId`** - evaluated, not added. `Category` rows are per-user (each user has their own distinct `Category` rows, never shared across users), so a `categoryId` value is already highly selective on its own - `Transaction`'s existing single-column `[categoryId]` index already narrows a lookup to essentially one user's rows for that category; a compound `[userId, categoryId]` wouldn't meaningfully narrow it further. Also checked `Category`'s own `userId + name + type` lookup (`updateTransaction`/`createTransaction`'s category resolution, `findCategoryByNameAndType`) - not added either: `Category` row counts per user are small and bounded (28 seeded + manual, deliberate-action-only growth, same reasoning already on record for why `GET /api/categories` itself was left unpaginated in Phase 4.1 follow-up #3), not a scale concern an index would meaningfully help.
- **New: `@@index([userId, accountId, type, amount])` on `Transaction`** - added specifically for the `groupBy({ by: ["accountId", "type"], where: { userId }, _sum: { amount } })` query this phase's `totalBalance` fix introduces, not speculatively. Column order matches the query's own WHERE-then-GROUP-BY shape; `amount` trails so the index can cover the `SUM` without a separate row lookup. **Measured**, same local SQLite test DB (20,000 seeded rows): before the index, `EXPLAIN QUERY PLAN` showed `SEARCH Transaction USING INDEX Transaction_userId_date_idx (userId=?)` (the existing index still finds the user's own rows correctly) followed by `USE TEMP B-TREE FOR GROUP BY` (~32-40ms across runs); after adding the index, the plan becomes a single `SEARCH Transaction USING COVERING INDEX idx_..._idx (userId=?)` step with no temp-sort and no table access at all (~6ms) - roughly 6-7x faster on top of section 2's already-measured row-count fix. Migration generated via the offline `migrate diff` process from `AGENTS.md`: `prisma/migrations/20260823072849_add_transaction_balance_groupby_index/migration.sql`, applied to and verified against the local test DB only (every `npm run test` run applies every migration folder in order - this one included, and the equivalence tests above ran with it applied). **Not applied to the live Turso DB** - per `AGENTS.md`'s standing rule, that (plus the matching `_prisma_migrations` bookkeeping row) needs a separate, explicit go-ahead before being run for real; nothing in this session wrote to the live database. `scripts/backfill-migration-history.ts`'s `MIGRATION_NAMES` list was deliberately **not** updated yet either, matching Phase 15's own precedent for its still-unapplied `20260822213426_add_user_role_check_constraint` migration (also still absent from that list) - the name gets added as part of the live-apply step itself, not before it's approved.

### 5. Not done (per this task's own scope)

No caching layer (Redis, in-memory LRU) was added - not needed given section 2's fix already turns the dominant cost into a single bounded, now-indexed aggregate query; would have been speculative. No schema restructuring beyond the one index in section 4. AI call structure untouched beyond re-confirming Phase 11's existing analysis still holds (see section 1).

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`).
- `npm run test`: **64/64 files, 721/721 tests passing** (up from 64/717 at session start - net +0 files, +4 tests: the totalBalance-equivalence tests in `accounts.test.ts`/`dashboard.test.ts`/`spending-summary.test.ts` above), confirmed reliable across two consecutive full runs.
- `next build` (Turbopack): clean, no new warnings. Route count wasn't re-pinned to a specific number this entry (this branch has added several routes - `/app/chat`, `/api/facts`, `/app/reports`, `/app/settings/*`, `/app/admin/logs`, etc. - since the "20 routes" figure was last recorded in Phase 15/16, so restating that number here without re-deriving it fresh would risk carrying forward a stale claim; "no new warnings" is the check that actually matters for this phase's changes).
- Dashboard fix: see section 2's table - **9.7x faster, 20,000 rows -> 9 rows** loaded into JS, measured through the real Prisma Client against a local SQLite test DB seeded with a large, multi-year transaction history; both old and new calculations verified to produce the identical `totalBalance`.
- Index fix: see section 4 - **~6-7x faster** on top of the above, measured via `EXPLAIN QUERY PLAN` before/after on the same seeded dataset.
- No live-database writes at any point - every test and every measurement script in this phase ran against either the isolated local-SQLite test datasource or a disposable, deleted-after-use scratch SQLite file, never the live Turso DB. The one live-DB-relevant artifact this phase produced (the new index's `migration.sql`) has **not** been applied to Turso and awaits explicit go-ahead per `AGENTS.md`.

### Do Not Claim

This does not claim the app is "now fast" or "fully optimized" - it fixes the one confirmed unbounded-growth pattern found in this codebase (present in two places, both fixed) and adds the one index a real introduced query pattern was measured to need, nothing broader. It does not claim every possible query in the codebase was benchmarked - most of section 1's "already fine" findings were confirmed by reading the actual bounding logic (`take`, date-range filters, existing pagination, fixed lookback windows), not by running a timing comparison for each one individually; a timing comparison was only run where a real change was being considered (sections 2 and 4). It does not claim the `MerchantMapping` full-load pattern is fine forever - it's flagged, not fixed, and not verified against any real user's actual mapping count (none exists in this local test environment to check against). It does not claim the Turso-live-DB version of any of this has been measured - every number in this entry comes from a local SQLite file (both the shared `.vitest-test.db` test datasource and disposable one-off scratch files), and real network round-trip cost per query against Turso was reasoned about qualitatively (the row-count reduction matters more, not less, once each of those 20,000 rows would otherwise have crossed a network boundary) but not measured directly.

## Phase 18 — Security Review (Final Pre-Launch Audit) — 2026-08-23

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **64/64 files, 721/721 tests passing** - taken from the Phase 17 entry immediately above. Full context loaded first per this task's own instruction: `security-audit-report.md` (2026-08-06 baseline), this file in full (845 lines at the time), `AGENTS.md`.

### Part A - Re-verification of `security-audit-report.md`'s findings

Every row below cites the current file/line actually read this session, not carried forward from the original report or from `docs/roadmap-status.md`'s own prose.

| ID | Title | Status | Evidence |
|---|---|---|---|
| SEC-1 | No security headers | **RESOLVED** | [next.config.ts:69-113](../next.config.ts#L69-L113) - CSP, HSTS (prod-gated), X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy (Phase 4.1 batch, 2026-08-15) |
| SEC-2 | Financial data persists in SW Cache Storage after logout | **RESOLVED** | [components/layout/logout-button.tsx:19-33](../components/layout/logout-button.tsx#L19-L33) (`clearAuthCache()`, awaited before redirect) + [public/sw.js:27-34](../public/sw.js#L27-L34) (`CLEAR_AUTH_CACHE` message handler, deletes `PAGES_CACHE`). Not previously logged under this ID anywhere in this file - found by reading the current code, not by trusting the log's silence |
| SEC-3 | Rate limits keyed off spoofable `X-Forwarded-For` | **PARTIALLY RESOLVED** | App-side fixed: [lib/rate-limit.ts:109-125](../lib/rate-limit.ts#L109-L125)'s `getClientIp()` now trusts `X-Real-IP` first, then the **last** `X-Forwarded-For` hop (not the first, attacker-controlled one). The reverse-proxy config this still depends on (proxy must overwrite/strip client-supplied values) remains unconfirmed/out of this repo's scope - documented in the function's own comment and DR-1's Remaining Risks; not attempted here per this task's own instruction |
| SEC-4 | `next-auth` beta, unpinned | **RESOLVED** | [package.json:24](../package.json#L24) - `"next-auth": "5.0.0-beta.32"`, no caret |
| SEC-5 | In-memory, non-distributed rate limiter | **STILL OPEN (accepted)** | [lib/rate-limit.ts:1-11](../lib/rate-limit.ts#L1-L11) - comment unchanged, still documents this as an interim tradeoff. See Part C |
| SEC-6 | No `max_tokens` cap on LLM calls | **RESOLVED** | `lib/nvidia-ai.ts` - `JSON_EXTRACTION_MAX_TOKENS`/`CHAT_REPLY_MAX_TOKENS` (Phase 4.1 follow-up #2, 2026-08-09) |
| SEC-7 | OTP mock-SMS fallback fails open in prod | **RESOLVED** | [lib/auth/otp.ts:69-77](../lib/auth/otp.ts#L69-L77) - gated on `NODE_ENV === "production"`, fails closed (`{success:false}`) instead of logging a real code |
| SEC-8 | Single `AUTH_SECRET` for OTP + legacy + NextAuth | **RESOLVED** | [lib/auth/otp.ts:17](../lib/auth/otp.ts#L17) (`OTP_SECRET`), [lib/auth/session.ts:42](../lib/auth/session.ts#L42) (`LEGACY_SESSION_SECRET`) - three independent secrets now, `AUTH_SECRET` reserved for NextAuth only ([auth.ts:84](../auth.ts#L84)) |
| SEC-9 | `trustHost: true`, reverse-proxy hardening unverifiable | **STILL OPEN (accepted, infra-only)** | [auth.ts:85-88](../auth.ts#L85-L88) - unchanged, same comment. Re-confirmed accurate; no code fix possible from this repo. See Part C |
| SEC-10 | No transaction-creation idempotency | **RESOLVED** | Schema (`idempotencyKey`) + dedup logic in `createTransaction()` (Phase 6 session, 2026-08-19) - **applied to the live Turso DB** the same day (see that entry's "SEC-10 (continued)" section) |
| SEC-11 | `X-Powered-By` not disabled | **RESOLVED** | [next.config.ts:98](../next.config.ts#L98) - `poweredByHeader: false` |
| SEC-12 | 90-day session, no step-up re-auth | **STILL OPEN - explicit decision: defer** | See Part C |
| T-1 | Tests hit the live DB | **RESOLVED** | Isolated local-SQLite datasource (`test/setup/`), 2026-08-09 |
| T-2 | No CI | **RESOLVED** | `.github/workflows/ci.yml`, 2026-08-15 |
| CQ-1 | Stale README (OpenRouter/better-sqlite3) | **RESOLVED** | README's stack/getting-started sections corrected, 2026-08-15 |
| OBS-1 | No `instrumentation.ts`/APM | **RESOLVED** | [instrumentation.ts](../instrumentation.ts), [sentry.server.config.ts](../sentry.server.config.ts), `lib/observability/logger.ts` (pino) - Phase 12, 2026-08-16 |
| IV-1 | No schema-validation library (Zod) | **STILL OPEN (accepted, out of scope)** | No `zod` in `package.json`, unchanged. Hand-rolled validation in transactions/accounts re-checked under Part B below - one real gap found and fixed this session (see Part B, "Malicious financial input") |
| DR-1 | No Dockerfile/deploy artifact | **RESOLVED** | `Dockerfile`, `.dockerignore`, `docs/deploy-runbook.md` - Phase 6 session, 2026-08-19 |

### Part B - Fresh audit coverage

- **CSRF:** No new gap. Every mutating route added since 2026-08-06 (`/api/facts`, `/api/log-error`, `/api/admin/default-categories[/[id]]`, `/api/auth/onboarding`, SEC-10's idempotency field, Phase 10's chat-context fields) authenticates via `getSession()`, which reads only the NextAuth session cookie or the legacy session cookie - both confirmed `sameSite: "lax"` (see Cookies below). The original audit's reasoning (`SameSite=Lax` blocks the realistic cross-site mutation vector; no Origin-header check exists as a second layer) is unchanged and still holds for every current route.
- **CORS:** No explicit CORS headers anywhere (`grep -rn "Access-Control\|cors(" app/ lib/ proxy.ts next.config.ts` - zero matches). Same-origin default still applies to every API response.
- **Open redirects:** Audited every `redirect()`/`NextResponse.redirect()` call site (15 total: 9 Server Component `redirect("/login")` guards, `proxy.ts`'s 5 redirects, `app/app/transactions/page.tsx`'s out-of-range-page redirect). Every single one is either a hardcoded literal path or `request.nextUrl.clone()` with the pathname then reassigned to a fixed, hardcoded string - never built from `searchParams`, a header, or any other request-controlled value. No open-redirect surface found.
- **SSRF:** Audited every outbound `fetch()` in server code (`lib/nvidia-ai.ts`'s `callNvidiaAI()` → `NVIDIA_BASE_URL` env var; `lib/sms/melipayamak.ts` → hardcoded `MELIPAYAMAK_SEND_URL` constant; `lib/offline/sync-transactions.ts`'s `fetch("/api/transactions")` is client-side/same-origin, not server-side). All three targets are config/env/hardcoded, never derived from user input. No SSRF surface found.
- **Cookies:** All three cookie-`.set()` call sites - [lib/auth/session.ts:201-206](../lib/auth/session.ts#L201-L206) (legacy session), [app/api/auth/send-otp/route.ts:62-67](../app/api/auth/send-otp/route.ts#L62-L67) (OTP), [auth.ts:55-61](../auth.ts#L55-L61) (OTP retry) - set `httpOnly: true`, `secure: process.env.NODE_ENV === "production"`, `sameSite: "lax"`. NextAuth's own session cookie is unmodified from its documented defaults (no `cookies` override block in `auth.ts`). Current values confirmed by reading the code, not carried forward from the 2026-08-06 snapshot.
- **Injection:** `grep -rn "queryRaw\|executeRaw"` across the whole repo (excluding `node_modules`/`.next`/`.test.ts`) - zero matches in application code, confirming zero `$queryRaw`/`$executeRaw` usage, same as the original audit. (`$executeRawUnsafe` appears only in `lib/auth/session.test.ts`, to seed a deliberately-invalid `role` value for testing the Phase 15 DB CHECK constraint, wrapped in `PRAGMA ignore_check_constraints` - test-only, not application code.)
- **Dependency vulnerabilities:** `npm audit` run (not skipped, unlike the original audit). Full: **10 high-severity** findings, all transitive - `next`→`postcss`/`sharp` (fix needs `next@16.3.2`, outside `package.json`'s stated range - a breaking upgrade), `prisma`→`@prisma/config`→`deepmerge-ts` (fix needs `prisma@6.12.0`, a breaking downgrade), plus `fast-uri`/`js-yaml`/`nanoid`. `npm audit --omit=dev`: **8 high-severity** (drops `js-yaml`, dev-only). Matches Phase 14's own prior note that these are pre-existing and unaffected by other work (that entry diffed `npm audit` with/without its own changes and found the same set). `npm audit fix --dry-run` was attempted to see if the 3 non-`next`/`prisma` findings had a non-breaking fix, but failed outright (`ETIMEDOUT` reaching `registry.npmjs.org` - no network access in this environment) - so no dependency version was changed this session, fixable-or-not; reported as-is, matching this task's "report actual current output" instruction rather than a claimed fix that couldn't be verified.
- **AI prompt injection:** Re-confirmed `app/api/chat/route.ts` and `lib/ai/parse-transaction.ts` unchanged in the ways that matter - the system prompt is still server-built ([app/api/chat/route.ts:32-37](../app/api/chat/route.ts#L32-L37)) from `getFinancialContextSummary()`'s output (real, server-computed numbers - never raw user text), the user's message is still a separate `user`-role message, never concatenated into the system prompt ([app/api/chat/route.ts:158-166](../app/api/chat/route.ts#L158-L166)). Checked the one new AI-touching surface since the original audit, Phase 10's financial-intelligence fields (`incomeChange`, `savingsRate`, `unusualTransactions`, `recurringExpenses` in `lib/data/chat-context.ts`) - all are computed numbers/derived strings rendered through the same capped-line convention as the pre-existing category/transaction lists, not new raw-text injection surface. No new gap.
- **Malicious financial input - real gap found and fixed:** `Transaction.amount` and `FinanceAccount.initialBalance` are both declared `Int` in `prisma/schema.prisma`, but neither `app/api/transactions/route.ts`'s POST, `app/api/transactions/[id]/route.ts`'s PATCH, `app/api/accounts/route.ts`'s POST, nor `app/api/accounts/[id]/route.ts`'s PATCH ever bounded the *magnitude* - only `Number.isFinite(amount) && amount > 0` (transactions) or `Number.isFinite(initialBalance)` (accounts). **Confirmed exploitable, not just theoretical**: a probe request with `amount: 99999999999999` (14 nines, ~47,000x the `Int` column's declared 32-bit range) was accepted with `201` and persisted verbatim - SQLite's `INTEGER` storage class has no fixed width, so neither the libSQL driver adapter nor Prisma Client rejected it before writing. A single such row would badly skew every amount-aggregate the app computes (`getTotalBalance`'s `groupBy` `_sum`, dashboard/spending-summary totals, category breakdowns). **Fixed:** new `MAX_TRANSACTION_AMOUNT`/`MAX_ACCOUNT_BALANCE_MAGNITUDE` constants in [lib/limits.ts](../lib/limits.ts) (both `2_147_483_647`, the `Int` column's actual declared range - not a guessed currency-sanity figure), enforced in all four route handlers; `initialBalance` bounds the magnitude on both signs (a negative starting balance, e.g. seeding a credit-card account with existing debt, is legitimate) while `amount` reuses the existing positive-only check. `NaN`/`Infinity`/`-Infinity` were already rejected by the pre-existing `Number.isFinite` check (confirmed with a new explicit test, since the original audit's "consistently validated as finite" claim had never been tested for `Infinity` specifically) - the gap was purely the missing upper/magnitude bound. **Not changed, noted as a separate, lower-severity observation:** `dateInput` parsing (both transaction routes) silently falls back to "today" for a malformed date string (`Number.isNaN(Date.parse(dateInput))`) rather than rejecting - benign fail-safe behavior (a user can already backdate their own transaction to any date deliberately), not the same class of issue as the unbounded-amount gap, and V8's lenient non-ISO `Date.parse` fallback was already flagged as a known characteristic in Phase 9's 9.2 entry for the *AI-provided* date specifically - left as-is here, matching this task's "only fix genuine confirmed findings" scope.
- **Error leakage / sensitive logging:** Spot-checked 4 recently-added call sites (since the Phase 6 privacy/redaction audit) against `lib/observability/redact.ts`'s pipeline: [lib/auth/session.ts:130-137](../lib/auth/session.ts#L130-L137) (`getActiveUser()`'s invalid-role path), [lib/data/admin-users.ts:75-81](../lib/data/admin-users.ts#L75-L81) and [:142](../lib/data/admin-users.ts#L142) (`listUsersForAdmin`/`getUserDetailForAdmin`'s equivalent), and the Phase 17 `getTotalBalance()` addition (`lib/data/accounts.ts`/`dashboard.ts`/`spending-summary.ts` - no new error-handling code was added there, confirmed via `grep`, so nothing to check). All three real call sites route through `reportError()` (the Phase 12 pino+Sentry pipeline, `redact()`-wired), none use a bypassing `console.error()`. A repo-wide `grep` for `console.(error|warn|log)` outside `.test.ts` files turned up only the same 5 sites the Phase 12 audit already catalogued (dev-only mock SMS, two Melipayamak failure logs, `error-log.ts`'s own last-resort fallback, `parse-transaction.ts`'s dev-only drift guard) plus `app/global-error.tsx`'s `console.error` - already documented in Phase 12's own Deferred section as a known, un-Sentry-wired gap, not new. No new bypass found.

### Part C - Explicit decisions on still-open items

- **SEC-12 (90-day session, no step-up re-auth) - decision: defer, not fixed this phase.** Checked first, per this task's instruction: no self-service account-deletion feature exists anywhere in the app (`grep` for a delete-own-account route/page - none) - the only destructive actions in the entire codebase are the two admin routes (`PATCH`/`DELETE /api/admin/users/[id]`), and both already sit behind two independent layers before any step-up would even apply: `proxy.ts`'s edge-level `session.role !== "admin"` gate, and `requireAdminSession()`'s own independent re-check inside `setUserBlocked`/`deleteUserAsAdmin` (Phase 15 also closed the one way this could have been undermined - a corrupted `role` value - with `isValidRole()` + a DB CHECK constraint). Self-lockout is separately guarded (`CannotModifySelfError`). Given that, real step-up re-auth (re-enter password/OTP before a block/delete) is genuine new feature work, not a hardening tweak: it needs a fresh short-lived step-up token, a UI re-prompt flow in `user-danger-zone.tsx` distinct per auth method (OTP vs. password vs. Google-only admins have no password to re-prompt at all), and new route wiring - matching the original report's own "Medium, a few hours" effort estimate, not the "<1hr" bucket most of this phase's other fixes fell into. Deferred to a follow-up phase rather than built here, per this task's explicit "no scope creep" instruction; recommend it be scoped as its own task if pursued, since the OAuth-admin case (no password to re-prompt) needs its own design decision this review shouldn't make unilaterally.
- **SEC-9 (`trustHost`/reverse-proxy hardening) - confirmed still accurately documented as infra-only, no code change.** `auth.ts:85-88`'s comment is unchanged and still correctly states the dependency on a reverse-proxy config not present in this repo; `DR-1`'s deploy runbook already documents the exact required config. Nothing to fix from this repo.
- **IV-1 (no Zod) - confirmed hand-rolled validation in transactions/accounts is sound, one real gap closed.** No Zod migration attempted (explicitly out of scope). The one concrete gap Part B's malicious-input check found (unbounded `amount`/`initialBalance` magnitude) is now closed the same way every other bound in these routes already works (a shared constant in `lib/limits.ts`, checked inline) - consistent with, not a departure from, the existing hand-rolled style this finding was originally rated "Low risk, no exploitable gap found" for. That specific sub-claim ("no exploitable gap was found") no longer holds as stated in the original report; it now does, following this session's fix.
- **SEC-5 (in-memory rate limiter) - confirmed reasoning still holds, no code change.** Phase 13.1 (2026-08-19) already re-confirmed "a single Node process on one VPS" as the current, operative deployment assumption, and DR-1's Docker artifact (same session) was built for exactly that shape - one container, not a multi-instance/serverless target. No hosting-provider decision has been made since that would change this tradeoff. `lib/rate-limit.ts`'s own comment is left as-is, matching the roadmap's standing note that this is an accepted interim tradeoff pending a hosting decision.

### Code changed this session

- `lib/limits.ts`: new `MAX_TRANSACTION_AMOUNT` (2,147,483,647 - `Transaction.amount`'s declared `Int` range) and `MAX_ACCOUNT_BALANCE_MAGNITUDE` (same value, applied symmetrically since a starting balance can be negative).
- `app/api/transactions/route.ts` (POST), `app/api/transactions/[id]/route.ts` (PATCH): reject `amount > MAX_TRANSACTION_AMOUNT`, folded into the existing validation `if`.
- `app/api/accounts/route.ts` (POST), `app/api/accounts/[id]/route.ts` (PATCH): reject/drop `Math.abs(initialBalance) > MAX_ACCOUNT_BALANCE_MAGNITUDE`, matching each route's existing reject-vs-silently-drop convention (POST rejects the whole request; PATCH silently excludes just that field from the partial update, same as its existing `type` handling).
- Tests: `app/api/transactions/route.test.ts` (+3: `Infinity`/`-Infinity` rejected, over-limit rejected and confirmed not persisted, exactly-at-limit accepted), `app/api/transactions/[id]/route.test.ts` (+1: over-limit rejected, row left untouched), `app/api/accounts/route.test.ts` (+2: over-limit rejected both signs, exactly-at-limit accepted both signs), `app/api/accounts/[id]/route.test.ts` (+2: over-limit silently dropped and row left untouched, exactly-at-limit accepted).

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean - same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`).
- `npm run test`: **64/64 files, 729/729 tests passing** (up from 64/721 at session start - net +0 files, +8 tests, all listed above), confirmed via one full run (all newly-added tests independently re-run in isolation first, verbose, to confirm each assertion actually exercises the new code path rather than passing vacuously).
- `next build` (Turbopack): clean, every route compiled with no errors or new warnings - not re-pinning a specific route count here either, for the same reason Phase 17 stopped doing so (the "20 routes" figure from Phase 15/16 was already stale by then; route count isn't what this phase's changes affect).
- No live-database access or writes at any point - every test ran against the isolated local-SQLite test datasource. Both migrations already flagged as unapplied-to-live in Phase 15/17 (`20260822213426_add_user_role_check_constraint`, `20260823072849_add_transaction_balance_groupby_index`) remain unapplied; this session introduced no new migration (the `amount`/`initialBalance` fix is application-level validation only, no schema change).

### Do Not Claim

This does not claim every finding in the original 2026-08-06 report was independently re-discovered from scratch - most were already fixed and logged in this file's own prior entries, and Part A's job was to verify each against the actual current file/line, not redo the fix. It does not claim `npm audit`'s findings are resolved - all 8-10 are transitive, all require a breaking upgrade or downgrade to fix, and this session could not even attempt `npm audit fix` (no network access in this environment) - they remain open, reported honestly rather than silently dropped. It does not claim SEC-3/SEC-9's reverse-proxy dependency is confirmed configured anywhere real - both remain infra-only, unverifiable from this repo, exactly as the original report already said. It does not claim SEC-12 is resolved or that deferring it was a mechanical call - it's a real scope judgment, stated with reasoning, that could reasonably go the other way in a future session with a concrete step-up-auth design brief. It does not claim this was a from-scratch security audit - per this task's own instruction, this was a targeted re-verification plus fresh coverage in the specific areas listed, not a full repeat of the original read-only sweep.


## Phase 19 — Final Production Readiness Review — 2026-08-23

Baseline before this session: `npx tsc --noEmit` clean, `npm run lint` clean (same 2 pre-existing warnings), `npm run test` **64/64 files, 729/729 tests passing** — taken from the Phase 18 entry immediately above (same date). Context loaded first per this task's own instruction: this file in full (913 lines at the time, all of Phase 6 through Phase 18 read), `AGENTS.md` in full, `security-audit-report.md` deliberately *not* re-read in depth — Phase 18's own Part A table was treated as current fact instead, per this task's explicit instruction not to re-derive it.

This is a review-and-decide task, not a build task. One small, genuinely in-scope gap was found and fixed while reviewing (see Data section); everything else below is verification only.

### Verdict table

| Area | Verdict | Evidence |
|---|---|---|
| Security | **Ready** | No code/config change since Phase 18 that Phase 18 wouldn't have seen - confirmed by diff, not assumed (see below). Phase 18's own table stands as current fact. |
| Data integrity & backup | **Ready, with caveat** | Two migrations correctly staged-but-unapplied; one real bookkeeping-drift bug found and fixed this session (see below); backup runbook real and previously exercised; live-DB scale not re-checked this session (see below, deliberate). |
| AI reliability & cost | **Ready, with caveat** | Timeout/retry/token-caps/rate-limits all confirmed unchanged and correctly wired. A real, previously-undocumented UX gap found: the primary add-transaction form has no manual-entry path if both the AI and every deterministic fast path fail - reported, not fixed (non-trivial). |
| Reliability / operational | **Ready, with caveat** | Fresh `next build`, `tsc`, `lint`, `npm test` all clean/passing this session, matching Phase 18's exact numbers. Docker image rebuilt fresh against current HEAD, booted, and re-passed every one of DR-1's original smoke checks (see below). Only remaining gap: CI's actual remote run status could not be checked (`gh` returned HTTP 403, account suspended) - the workflow's own commands were all independently re-run locally and passed. The Phase 14 offline-queue SSR regression is **not** an open item - already root-caused and fixed within Phase 14's own 2026-08-20 addendum; re-confirmed the fix is still present in `next.config.ts` today. |
| Product / launch-readiness | **Ready** | New-user flow covered end-to-end by existing tests, step by step (not one chained E2E test - see below). No placeholder/lorem text found. No admin UI reachable by a non-admin (`proxy.ts`-gated). The two already-tracked deployment blockers (hosting/VPS+domain choice, reverse-proxy `X-Real-IP` config) remain accurately open - not touched, per this task's own instruction. |

### 1. Security

No new routes, dependencies, or env vars since Phase 18 (same date, same session cluster) - checked concretely, not assumed:
- `git diff HEAD -- .env.example`: only additions are `OTP_SECRET`/`LEGACY_SESSION_SECRET` (SEC-8, already `RESOLVED` in Phase 18's own table) and `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` (OBS-1, Phase 12, predates Phase 18). Nothing new.
- `git diff HEAD -- package.json`: only additions are `@sentry/nextjs`, `pino`, `server-only` (all Phase 12) and `fake-indexeddb` (Phase 14, devDependency). All predate Phase 18.
- `git status --porcelain | grep "^??"`: zero new `route.ts` files - every untracked file is either a test file, a doc, a migration folder, or an observability/offline module already accounted for in Phases 12-18. Every modified (`M`) `route.ts` is an existing route Phase 18 already reviewed (transactions, accounts, categories, admin/default-categories, auth/register, auth/send-otp, chat).

Conclusion: Phase 18's Part A/B/C tables and decisions are still accurate today; nothing here re-opens or changes any of them.

### 2. Data integrity & backup readiness

- **The two migrations are still correctly unapplied to live**, re-confirmed from the actual files/scripts (not the live DB, per this phase's own hard rule): `prisma/migrations/20260822213426_add_user_role_check_constraint/migration.sql` and `prisma/migrations/20260823072849_add_transaction_balance_groupby_index/migration.sql` both exist and are well-formed (spot-read). Neither name appears with a matching applied-and-verified live row anywhere in this repo's own bookkeeping.
- **Real gap found and fixed:** `scripts/backfill-migration-history.ts`'s `MIGRATION_NAMES` list (in the current, uncommitted working tree) had drifted to *include* `20260823072849_add_transaction_balance_groupby_index` - but Phase 17's own entry explicitly says that migration's DDL was never applied live, and explicitly says the name should be added "as part of the live-apply step itself, not before it's approved." Had this script been run with `--execute` as-is, it would have inserted a bookkeeping row into the live `_prisma_migrations` table falsely claiming this migration was already applied, while the live schema would still be missing the actual index - a real, if latent, data-integrity risk (the script defaults to a dry run, so nothing live was actually corrupted by this drift, but the next person to run `--execute` without independently re-checking would have been misled by the script itself). Fixed by removing that one entry and adding a comment explaining why, so the list now accurately reflects only the 7 migrations genuinely confirmed applied live (`20260819081756_add_transaction_idempotency_key` correctly remains - it *was* applied live, per that day's own "SEC-10 (continued)" entry with a real inserted bookkeeping row). `20260822213426_add_user_role_check_constraint` was never in the list at all, so no equivalent fix was needed there. **This did not touch the live database in any way** - only a local TypeScript source file (a dry-run-by-default script) was edited. Small, self-contained, directly evidenced by this phase's own checklist item - didn't warrant its own phase.
- **Backup runbook confirmed real and realistic, not just documented:** `AGENTS.md`'s "Backing up the live database (Turso)" section (read in full at this session's start) documents the `turso db shell <db> .dump` command; `scripts/backup-live-db.ts` is a working stand-in for when Turso CLI access isn't available, and - per this file's own Phase 6/"SEC-10 (continued)" entry - it was actually run for real once (2026-08-19), producing a verified, byte-for-byte-spot-checked export immediately before that session's live migration. So "realistic to run before a live migration" isn't speculative here - it's the exact process already used the one time this repo applied a live schema change.
- **Live-DB scale (61 users / 29 transactions) - deliberately NOT re-verified this session.** That specific figure doesn't appear anywhere in this file (`grep`-ed for "61" and "29 transactions" - zero hits), so it isn't traceable to a prior `docs/roadmap-status.md` entry either; the most recent number *this file* actually records is the Phase 6 backup session's pre-migration count (2026-08-19: 49 users, 28 transactions), which will have grown since. This phase's own instructions offer a conditional ("if a cheap read-only check exists... if not, don't invent one") but this phase's own hard requirement is unconditional ("Do not touch the live Turso database under any circumstances in this phase") - an admin-stats read is still a live-DB connection, so the hard rule wins and no check was attempted. Stated plainly rather than guessed at.

### 3. AI reliability & cost

- **Timeout/retry (Phase 9.1): confirmed unchanged**, read directly from `lib/nvidia-ai.ts`: `NVIDIA_REQUEST_TIMEOUT_MS = 30_000`, `fetchWithTimeout()` (real `AbortController`), one retry via `isConnectionLevelFailure()` gated to connection-level failures only (not HTTP errors, not our own timeout abort) - matches Phase 9's own description exactly, byte-for-byte.
- **`MAX_TOKENS` caps (SEC-6) and per-user rate limits: confirmed still wired at both call sites.** `JSON_EXTRACTION_MAX_TOKENS = 500` / `CHAT_REPLY_MAX_TOKENS = 1000` both present and passed into `callNvidiaAI()`. `TRANSACTION_PARSE_USER_RULE` (60/5min) is checked in both `app/api/transactions/parse/route.ts` and `app/api/chat/route.ts`'s `trySuggestTransaction()` path; `CHAT_USER_RULE` (15/5min) is checked in `app/api/chat/route.ts`'s main `POST`. All four checked by reading the actual call sites, not the changelog prose.
- **NVIDIA NIM outage behavior - traced concretely, real gap found, not fixed (non-trivial):**
  - `app/api/chat/route.ts`: a `streamChatCompletion()` failure returns a flat `502` JSON error with no fallback (by design, per Phase 12.4.2's "re-throw after logging" default) - the chat feature hard-fails visibly, which is reasonable, expected behavior for a chat feature.
  - `app/api/transactions/parse/route.ts` / `parseTransactionWithAI()`: degrades gracefully **only** when the input matches one of the two deterministic fast paths (a recognized bank-SMS format, or a known merchant name with confident amount/date extraction) - both skip the AI call entirely and can't be affected by an outage. Free text that needs real AI extraction still hard-fails to `502` if NVIDIA NIM is down.
  - **New finding this session:** traced this all the way to the UI. `components/transactions/add-transaction-form.tsx` has no manual-entry escape hatch - it only transitions from the raw-text `"input"` stage to the editable `"preview"` stage (where amount/category become directly editable) *after* a successful parse, deterministic or AI. So a real NVIDIA NIM outage combined with free-form text that isn't a recognized bank-SMS format or a known merchant name leaves a user stuck at the input stage with a visible inline error and **no way to log that transaction through the primary form at all**, until the outage clears. This is real, current, verified-by-reading-the-code behavior, not a hypothetical - and not something this phase should build a fix for (a manual "enter without parsing" stage is genuine new UI work, not a trivial gap). Reported as a launch-readiness observation, not a blocker: bank-SMS/known-merchant entries (very likely most real usage) are unaffected, and the chat path is unaffected by this specific gap since it never routed through this form.

### 4. Reliability / operational readiness

All four commands re-run fresh this session, not cited from a prior one:

- `npx tsc --noEmit`: **clean.**
- `npm run lint`: **clean** - the same 2 pre-existing warnings as every prior entry (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused `categoryId`), confirmed unrelated and unchanged.
- `npm run test`: **64/64 files, 729/729 tests passing** - exact match to Phase 18's own baseline, confirmed by a fresh full run in this session.
- `next build` (Turbopack): **clean.** 37 routes generated (up from the "20 routes" figure Phase 15/16/17/18 all noted as already stale by their own time - not re-pinning it as a fixed number here either, for the same reason those entries gave: route count isn't what this phase's own checks are about). No errors, no new warnings.
- **Docker (DR-1): rebuilt fresh against current HEAD and re-verified end-to-end - succeeded.** `docker build` (unchanged Dockerfile since DR-1's own 2026-08-19 build - confirmed via `stat`, mtime 2026-08-19, no later phase entry touches it) failed once with a transient `ETIMEDOUT` reaching the npm registry (confirmed the sandbox *can* reach `registry.npmjs.org`, both from the host and from inside a fresh container, before retrying) and succeeded on retry - slowly (~30min total in this sandbox, vs. DR-1's original session, likely resource contention with other, unrelated background containers observed starting/stopping during the wait), but completely: final image `463MB`. Booted with placeholder env vars and re-ran DR-1's exact own smoke checks: `GET /` -> 200 with the full 40KB body and every `next.config.ts` security header present (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) and `X-Powered-By` absent; `GET /login`, `/manifest.webmanifest` -> 200; `GET /sw.js` -> 200 with its own `Content-Type`/`Cache-Control` override intact; `GET /api/transactions` (unauthenticated) -> 401; container process runs as `nextjs`, uid 1001/gid 1001, not root (`docker exec ... whoami`/`id`). Full match to DR-1's original verification, actually re-run this session, not assumed. Test container/image removed after verification (`docker stop`/`rm`/`rmi`), matching DR-1's own convention.
- **CI (`.github/workflows/ci.yml`, T-2): actual remote run status could not be checked this session** - `gh run list`/`gh repo view` both returned `HTTP 403: Sorry. Your account was suspended` for this repo, on both the current branch and `main`. Not silently assumed green: the workflow's own three commands (`npm ci` implied via the fresh installs above, `npm run lint`, `npx tsc --noEmit`, `npm run test`) were independently re-run locally this session with the exact same results the workflow would produce (its dummy env vars - `AUTH_SECRET`/`OTP_SECRET`/`LEGACY_SESSION_SECRET`/`NVIDIA_*` - were re-read from `ci.yml` and confirmed to still match every env var this codebase's auth/test suite actually needs, no drift since Phase 4.1's original CI addition). High confidence, not confirmed fact - reported as such.
- **TODO/FIXME/`@ts-expect-error` sweep (application code, tests excluded):** every hit (`grep -rE "TODO|FIXME|@ts-expect-error"` across `app/`, `lib/`, `components/`, minus `*.test.*`) is one of the already-documented, already-tracked `bank-patterns.ts` "verify with real SMS sample" placeholders (13 of 17 banks, tracked since Phase 7) or `lib/merchants.ts`'s matcher-collision-risk notes (also pre-existing, documented in-line) - nothing new, nothing load-bearing-but-silent. Zero `@ts-expect-error` anywhere in application code.
- **Phase 14 offline-queue SSR regression: re-confirmed RESOLVED, not open.** Re-read Phase 14's own "Addendum, 2026-08-20" entry in full: the white-screen regression was root-caused (an unconditional `upgrade-insecure-requests` CSP directive breaking `npm run dev`'s plain-HTTP navigations) and fixed the same session (`next.config.ts`'s existing `isDev` check extended to gate both `upgrade-insecure-requests` and `Strict-Transport-Security`), verified with real Playwright/Chromium across a full register -> onboarding -> multi-route session with zero console errors/failed requests. **Re-verified the fix is still present in the current `next.config.ts`** (`isDev` gate confirmed wrapping both directives, read directly this session) - not reverted, not regressed. The offline-queue feature itself was separately confirmed, in that same addendum, not to have been the cause, and was manually verified working in a real browser the same session. This item should not be carried forward as open in any future handoff summary - the roadmap itself already shows it closed.

### 5. Product / launch-readiness

- **New-user end-to-end flow (register -> OTP/password -> onboarding -> add transaction -> dashboard): verified via the existing test suite, not a manual click-through - stated explicitly per this task's own instruction.** Coverage confirmed step by step, each independently real (not one chained E2E test - no Playwright/`.spec.ts` suite exists in this repo, confirmed via `find`, zero results): registration (`app/api/auth/register/route.test.ts`), phone-OTP send + the full `authorizePhoneOtp` state machine (`app/api/auth/send-otp/route.test.ts`, `auth.test.ts`), onboarding (`app/api/auth/onboarding/route.test.ts`), transaction creation (`app/api/transactions/route.test.ts` - 33 test cases including validation, idempotency, and limits - plus `components/transactions/add-transaction-form.test.tsx`), and the dashboard read path (`lib/data/dashboard.test.ts`). No single test proves the full chain end-to-end in one run.
- **Placeholder/unfinished content:** none found. `grep`-ed `app/`/`components/` for "lorem ipsum", "coming soon", "not implemented", TODO-styled copy - zero hits.
- **Admin-only UI reachable by a normal user:** none found. All four `/app/admin/*` pages and every `/api/admin/*` route sit behind `proxy.ts`'s edge-level `session.role !== "admin"` gate (read directly - `pathname.startsWith("/api/admin/")` and the `isAdminRoute` check both redirect/403 non-admins before any page code runs), independently re-checked a second time inside the data layer by `requireAdminSession()` (Phase 15's defense-in-depth). No admin page was found skipping this gate.
- **The two already-tracked deployment blockers - confirmed still accurately open, not touched:** hosting/VPS+domain choice (Phase 13.1/Phase 18's SEC-5 Part C: "no hosting-provider decision has been made") and the reverse-proxy `X-Real-IP` config (DR-1's Remaining Risks, Phase 18's SEC-3/SEC-9 Part A/C) - both re-read this session, both still explicitly unconfirmed/undecided, unchanged since Phase 18. Left alone entirely, per this task's own explicit instruction.

### Overall launch-readiness verdict

**Ready to deploy, with caveats** - nothing found this session rises to a hard blocker in application code, and the one real bug found (the migration-bookkeeping drift) was small enough to fix in place without its own phase. What stands between this and an unqualified "ready," in priority order:

1. **The two already-known infrastructure blockers** (hosting/VPS+domain choice; reverse-proxy `X-Real-IP` config) - both re-confirmed still open, both prerequisites to actually deploying anywhere, both explicitly out of this phase's scope per its own instructions. Not new information.
2. **The two staged-but-unapplied migrations need an explicit go/no-go** before launch, following `AGENTS.md`'s existing process exactly (fresh backup via `scripts/backup-live-db.ts` or a working `turso db shell .dump`, then apply, then verify, then backfill bookkeeping) - this is process, not a code gap; both migrations are additive/non-destructive (a nullable-safe CHECK constraint, an index) and already verified against the local/test DB dozens of times over.
3. **One verification gap this session couldn't close, not indicating an actual regression:** CI's real green status on this branch/HEAD (`gh` returned HTTP 403, account suspended) - the underlying `lint`/`tsc`/`test` commands were independently re-run locally and passed, and the Docker image (built by the same three-plus-`next build` commands) was separately rebuilt, booted, and smoke-tested fresh and passed cleanly, so there's strong indirect evidence CI would be green too - just not a direct confirmation of the actual remote run.
4. **The AI-outage manual-entry gap** (section 3 above) is worth a conscious product decision, not a blocker - most real usage (bank-SMS paste, known merchants) is unaffected, and the failure mode is a visible, honest error rather than data loss or a crash.

None of Security, Reliability, or Product surfaced anything beyond these four items.


## Phase 20 — Scale & Cost Readiness (1M DAU prep) — 2026-08-26

Prompted by a request to optimize the whole codebase so it stays fast and
cost-controlled if the app reached 1M daily active users (DAU), without
damaging the live app. Asked the user up front how to scope this, given
Jib currently has ~60 real users on a single VPS with no hosting decision
made yet (Phase 13.1/18) — chosen scope: implement safe, code-only wins
now (no live-DB writes, no speculative infra choices made on the user's
behalf), and write up everything gated on an infrastructure decision as a
doc instead of guessing. See `docs/scale-readiness-1m-dau.md` for that
doc — this entry covers only the code changes.

**Baseline at session start was NOT clean** (a first, before finding
anything): `npm run lint` clean (same 3 pre-existing warnings). `npx tsc
--noEmit` — pre-existing failures, unrelated to this phase (see "Found,
not fixed" below). `npm run test` — **68 files discovered (up from Phase
19's 64, via the Assets feature added since), but 2 files / 5 tests
already failing** (`lib/auth/session.test.ts`'s two DB-CHECK-constraint
tests, `lib/data/admin-users.test.ts`'s three role-validation tests) — a
regression from Phase 19's own "64/64, 729/729" clean baseline, introduced
sometime after Phase 19 by the Assets feature (also new since Phase 19),
confirmed **not** caused by this session's own changes (reproduced by
running `lib/data/admin-users.test.ts` in isolation before touching
anything: passes standalone, only fails as part of the full suite — the
signature of cross-file DB state, not a flaky/unrelated test). Root-caused
and fixed below.

### 1. Real regression found and fixed: the Assets migration silently dropped the User role CHECK constraint

`prisma/migrations/20260825171540_add_assets/migration.sql` needed a
SQLite table-rebuild ("RedefineTables") of `User` to add the new
`showBalanceInAssets` column — same pattern the schema-engine used for
`20260806144050_add_category_is_essential` and, before this migration, for
`20260822213426_add_user_role_check_constraint`. That last migration added
a hand-written `CONSTRAINT "User_role_check" CHECK ("role" IN ('user',
'admin'))` — hand-written specifically because `schema.prisma` has no way
to express a CHECK constraint in this installed Prisma version (confirmed
directly in that migration's own comment, not assumed here). `prisma
migrate diff` has no visibility into that hand-written SQL when it later
regenerated `20260825171540`'s own `CREATE TABLE "new_User"` straight from
`schema.prisma` — so the rebuild silently omitted the constraint, undoing
Phase 15's role-hardening work the moment this migration runs, without
touching `schema.prisma` or the CHECK-constraint migration's own file at
all.

**Fix:** restored `CONSTRAINT "User_role_check" CHECK ("role" IN ('user',
'admin'))` in `20260825171540`'s `CREATE TABLE "new_User"`, verbatim from
the migration it was silently dropped from, with a comment explaining why.
**Neither migration has been applied to the live Turso DB yet** (per
Phase 19's own confirmation this session re-checked, not re-derived) — so
this is a fix to a migration file before it was ever applied for real, not
a live-DB change; nothing here touched Turso. `npm run test` after the fix:
**68/68 files, 769/769 tests passing**, confirmed via a fresh full run.

### 2. Single-flight de-dup for `getLivePrices()` (`lib/prices/get-live-prices.ts`)

**Finding:** `getLivePrices()` is called from four places (`lib/data/
dashboard.ts`, `lib/data/assets.ts`, `lib/ai/parse-transaction.ts`,
`app/api/assets/live-prices/route.ts`), backed by one shared DB row
(`LivePriceCache`) refreshed at most once per 5-minute TTL from nerkh.io.
At current traffic this never matters — but at real concurrent load, many
requests can land in the gap between "the cached row just expired" and "a
fresh fetch+upsert finishes" (a real network round-trip, not instant), and
each of them would independently re-fetch and re-upsert the same three
symbols: wasted nerkh.io quota (an externally rate-limited/billed
resource, the same class of concern `lib/nvidia-ai.ts`'s `max_tokens` caps
and timeout/retry policy already address for the other third-party API
this codebase calls defensively) and redundant DB writes, all computing
the identical result. This is the one place in the codebase where
concurrent requests pile onto one shared external resource — everything
else reviewed this session (see section 3) is already per-user-scoped or
already cached/bounded from Phase 17.

**Fix:** a `WeakMap<object, Promise<LivePrices>>` keyed by the `client`
object reference itself (not a hardcoded check for the real `prisma`
singleton), so concurrent callers sharing the same client join one
in-flight fetch instead of starting their own. Deliberately keyed by
reference rather than special-cased to `prisma`: every call site's default
param resolves to the same real singleton in production, so those are all
correctly deduped, while every existing test in `get-live-prices.test.ts`
already uses its own distinct `fakeClient(...)` instance per the codebase's
established DI-over-module-mocking convention for `prisma` — so tests stay
naturally isolated with zero special-casing needed. Zero behavior change
for a single caller (every pre-existing test in that file passed
unmodified).

**New tests** (`lib/prices/get-live-prices.test.ts`): concurrent calls
sharing one client dedupe to one fetch+upsert (3 nerkh.io calls, not 6);
concurrent calls with distinct client instances stay fully independent (6
calls, not shared); a later call after the first has settled starts a
fresh fetch rather than replaying a stale resolved promise forever.

### 3. Reviewed, found already fine — not re-touched

- **Every other AI/external-API call site** (`lib/nvidia-ai.ts`'s two call
  sites, `lib/prices/get-live-prices.ts`'s own nerkh.io fetch) already has
  an explicit timeout + narrowly-scoped connection-level retry (Phase 9.1),
  confirmed still wired by direct read, not re-implemented.
- **The new Assets feature's own queries** (`lib/data/assets.ts`'s
  `listAssetsWithValue`) - a plain `findMany({ where: { userId } })` with
  no `include`, no N+1, bounded by one user's own asset count; calls
  `getLivePrices()` at most once per request regardless of how many
  live-priced assets the user holds. No change needed.
- **Phase 17's DB query/index work** - re-confirmed still the only
  unbounded-query pattern on record (already fixed there) and the only
  index a real new query needed (already added there); nothing new found
  in that category this session.
- **Sentry cost** - `sentry.server.config.ts`/`instrumentation-client.ts`
  set no `tracesSampleRate` (tracing already off, Phase 12's own explicit
  scope) - no APM spend risk from this codebase's own config.

### Found, not fixed - written up instead (see `docs/scale-readiness-1m-dau.md`)

Everything gated on an infrastructure decision this repo can't make:
hosting topology (VPS vs. the linked-but-unconfirmed `.vercel/repo.json`
Vercel project - a real discrepancy found this session, not resolved),
moving `lib/rate-limit.ts` to a shared store once more than one instance
runs, the NVIDIA NIM `build.nvidia.com` developer endpoint's suitability
for real production volume (plus a note that `docs/openrouter-cost-
estimate.md` is now stale - the app moved off OpenRouter since that doc
was written), Turso plan tier / read replicas, the complete absence of a
query-level timeout anywhere in the DB access path (flagged as a real gap,
not fixed - `@prisma/adapter-libsql`'s `PrismaLibSql` doesn't expose a
custom-fetch/timeout option in the installed version, and patching around
that touches the one DB client every route depends on, more invasive than
this pass's bar for a contained, well-tested change), and CDN/static-asset
serving. Full reasoning and a recommended order of operations in that doc.

### Verification

- `npx tsc --noEmit`: **pre-existing failures, unrelated to this phase,
  not introduced or fixed here** - `BigInt literals are not available when
  targeting lower than ES2020` in `app/api/assets/route.test.ts` (2 hits)
  and `lib/prices/get-live-prices.test.ts` (6 hits, all in
  pre-existing test code this session didn't write - the new tests added
  this session use plain numbers, not BigInt literals). `tsconfig.json`'s
  `target` is `ES2017`; the Assets feature's tests use `1n`-style BigInt
  literals (matching `Asset.purchasePricePerUnit`'s real BigInt type -
  see `prisma/schema.prisma`'s own comment on why that column is BigInt).
  Confirmed pre-existing and not caused by this session:
  `app/api/assets/route.test.ts` was never touched this session and shows
  the identical error class. **Not fixed here** - resolving it means
  either changing `tsconfig.json`'s project-wide `target` (a consequential,
  build-output-affecting change) or rewriting every BigInt literal in
  those test files to `BigInt(n)` calls, neither of which is in scope for
  a scale/cost-readiness pass; flagged here so it isn't lost, since it
  would fail `.github/workflows/ci.yml`'s `tsc --noEmit` step as-is.
- `npm run lint`: clean - same 3 pre-existing warnings as every prior
  entry.
- `npm run test`: **68/68 files, 769/769 tests passing** (up from the
  broken 66/68, 764/769 this session found at its own start - see
  "Baseline" above), confirmed via a fresh full run after both fixes.

### Do Not Claim

This does not claim Jib is ready for 1M DAU - see
`docs/scale-readiness-1m-dau.md`'s own "Do not claim" section, which this
entry defers to rather than repeating. It does not claim the `tsc
--noEmit` BigInt-literal failures are new or caused by this session - they
were found while verifying this phase's own changes, confirmed pre-existing
via a file this session never touched, and are reported, not fixed, since
fixing them means a project-wide `tsconfig.json` change out of this pass's
scope. It does not claim every possible concurrency/thundering-herd pattern
in the codebase was audited exhaustively - `getLivePrices()` was the one
concrete instance found (a shared, externally-rate-limited resource behind
a TTL cache with multiple call sites), not the result of a systematic sweep
for the general category.


## Multi-Conversation Chat History — 2026-09-04

The assistant («دستیار مالی جیب») used to give every user exactly one
endless chat thread — every message they ever sent, forever, in one
`ChatMessage` list and one AI prompt history. This phase splits that into
N conversations per user, each with its own bounded message history, its
own AI context (nothing from one thread can bleed into another's prompt),
its own title, and its own delete. No product-scope reduction — this is
additive: existing chat history is preserved and reorganized, not
discarded.

### 1. Schema — `Conversation` model + staged migration

`prisma/schema.prisma` gained a `Conversation` model (`id`, nullable
`title`, `createdAt`, `updatedAt`, `lastMessageAt`, `userId` →
`User.id` cascade) and `ChatMessage` gained a required `conversationId` →
`Conversation.id` cascade FK alongside its existing `userId` (kept,
deliberately denormalized, per this schema's existing per-user-model
pattern — the `User` cascade delete and any userId-only cleanup still work
without a join). A new `[conversationId, timestamp]` index serves
`listMessages()`'s per-conversation read; the old `[userId, timestamp]`
index stays since nothing else queries chat history by user alone anymore
but the User cascade still benefits from it.

The migration — `prisma/migrations/20260904102636_add_conversation` — is
`prisma migrate diff` output per `AGENTS.md`'s offline-diff process, with
one hand-added data migration the diff tool has no way to express: a
backfill `INSERT INTO "Conversation"` (one row per distinct user who has
any existing `ChatMessage`, titled from that user's earliest `role='user'`
message — truncated to 40 codepoints the same way `truncateTitle()` in
`lib/data/conversations.ts` does for new conversations, falling back to
"مکالمه قبلی" for a user whose only messages are `role='assistant'`),
run between the `CREATE TABLE "Conversation"` and the `RedefineTables`
rebuild of `ChatMessage` so every pre-existing message resolves to a
non-NULL `conversationId` before the `NOT NULL` constraint is enforced.
The `RedefineTables` block does **not** touch `User`, so the hand-written
`User_role_check` CHECK constraint (Phase 15) is untouched by this
migration — the file's own header calls out why, referencing the Assets
migration regression (Phase 20 §1) as the precedent this was written to
avoid repeating. As of this entry, the migration was staged, reviewed, and
approved but **not yet applied to the live Turso DB**; see this session's
separate live-apply report for that step.

### 2. Data layer — `lib/data/conversations.ts`

New module: `listConversations`, `createConversation`, `getConversation`
(throws `ConversationNotFoundError` for a missing-or-not-yours id — same
"not yours looks like doesn't exist" convention as `AccountNotFoundError`/
`AssetNotFoundError`), `listMessages`, `deleteConversation` (cascade does
the message cleanup), `touchConversation` (bumps `lastMessageAt`, the
history list's sort key — deliberately separate from Prisma's own
`@updatedAt`, which also moves on a title write), and `maybeAutoTitle` (a
single atomic `updateMany({ where: { title: null } })`, so a conversation
is titled exactly once, safe under concurrent turns, with no read-then-
write race).

**The `asc`/`take` history-display bug, found and fixed here:** the old
`app/app/chat/page.tsx` loaded chat history with
`orderBy: { timestamp: "asc" }, take: 50` — for any thread past 50
messages, that returns the **oldest** 50, not the most recent 50, so a
long-running user's chat screen would load frozen in the past instead of
showing where the conversation currently was. `listMessages()` replaces it
with the pattern `app/api/chat/route.ts` already used correctly for AI
prompt history (`desc` + `take`, then reversed in JS) — most-recent-N,
oldest-first for display. Regression-covered by
`lib/data/conversations.test.ts`'s "returns the most recent \`take\`
messages, oldest-first (not the oldest N)" test.

### 3. New endpoints — `app/api/chat/conversations/`

`GET`/`POST /api/chat/conversations` (list the session user's
conversations; create a new untitled one) and
`GET`/`DELETE /api/chat/conversations/[id]` (this conversation's messages,
oldest-first; delete it and its messages). All four session-gate first,
then ownership-check via `getConversation`/`listMessages`/
`deleteConversation` before reading or writing anything, returning the
same 404 for a nonexistent id and one that belongs to someone else. None
of the four sit behind `CHAT_USER_RULE` or a rule of their own — see
"Found, not fixed" below.

### 4. `app/api/chat/route.ts` — `conversationId` is now required

`POST /api/chat` no longer creates or reads "the user's thread" — it takes
a required `conversationId` in the body (400 if missing/non-numeric),
ownership-checks it via `getConversation` before any write or AI call (a
guessed id belonging to someone else costs nothing, reveals nothing beyond
the same 404), writes both the user and assistant `ChatMessage` rows
against it, and scopes the 16-message AI prompt-history read
(`HISTORY_MESSAGE_TAKE`) to that conversation via `listMessages` instead
of the old userId-wide `chatMessage.findMany`. A new
`finalizeConversationTurn()` runs at the end of both reply paths (the
`transaction_suggestion` JSON response and the normal streamed one):
`touchConversation` + `maybeAutoTitle` in parallel, called unconditionally
(auto-title is a no-op past the first turn, and the user's message is
already persisted either way, so there's no case where skipping it would
be more correct).

### 5. UI — `conversation-list-drawer.tsx` + `page.tsx`/`chat-interface.tsx`

New `ConversationListDrawer` (bottom-sheet list: title or "گفتگوی بدون
عنوان" for a still-untitled thread, Jalali `lastMessageAt`, switch, delete
with an inline confirm step). `app/app/chat/page.tsx` now resolves the
active conversation from a `conversationId` search param (falling back to
the most recently active one, or `null` for a brand-new user or `?new=1`),
redirecting to the canonical URL if the requested id isn't in the user's
own `listConversations()` result — membership in that list **is** the
ownership check at this layer, and `listMessages()` re-checks
independently regardless. `ChatInterface` gained header buttons for
"گفتگوی جدید" (new) and history; a new conversation is created lazily on
first send rather than on button click, so opening a new chat and walking
away leaves no empty thread behind; the URL is updated via
`history.replaceState` (not `router.refresh`) after a successful first
send so a reload lands on the right thread without remounting the
component and losing in-flight client state (a pending transaction
suggestion, an error banner).

### Found, not fixed — unbounded `POST /api/chat/conversations`

Unlike `POST /api/chat` (behind `CHAT_USER_RULE`) or transaction parsing
(`TRANSACTION_PARSE_USER_RULE`), `POST /api/chat/conversations` has no
rate limit — a deliberate scope call at the time, reasoned as "it makes no
AI call and costs nothing in third-party API terms," not an oversight.
That reasoning covers cost but not abuse: a logged-in user (or a script
using their session) can call it in a tight loop with no cap, growing
their own `Conversation` table unboundedly. Nothing downstream is
unbounded-query-broken by that — `listConversations()` has no `take`, so
the history drawer would render an ever-growing, un-paginated list, and
each spam row is cheap but not free (DB storage, one query response getting
linearly slower per user). No fix applied this session — flagged here
rather than guessed at, since the right bound (a rate limit like the other
two rules, a hard per-user cap, pagination on `listConversations`, or some
combination) is a product/cost judgment call this session didn't have
grounds to make unilaterally.

### Other fix: `admin-users` test needed a conversation

`app/api/admin/users/[id]/route.test.ts`'s cascade-delete test created a
`ChatMessage` directly with no `conversationId` — no longer valid once
that column became `NOT NULL`. Fixed by creating a `Conversation` first
and asserting it's gone too after `deleteUserAsAdmin()`, alongside the
`ChatMessage` it owns (both cascade from `User`). No other pre-existing
test file created `ChatMessage` rows directly; every other hit is one of
this phase's own new test files.

### Verification

- `npm run test`: **71/71 files, 808/808 tests passing** (up from Phase
  20's 68/68, 769/769 — +3 files, +39 tests, all new: `lib/data/
  conversations.test.ts`, `app/api/chat/conversations/route.test.ts`,
  `app/api/chat/conversations/[id]/route.test.ts`, plus the extended
  existing `app/api/chat/route.test.ts` and `admin-users/[id]/
  route.test.ts`), confirmed via a fresh full run.
- `npx tsc --noEmit`: unchanged from Phase 20's baseline — same 8
  pre-existing `TS2737` BigInt-literal errors in `app/api/assets/
  route.test.ts` and `lib/prices/get-live-prices.test.ts`, neither file
  touched this session.
- `npm run lint`: clean — same 3 pre-existing warnings (`components/
  logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused
  `categoryId`, and the workflow route's unused eslint-disable directive).

### Do Not Claim

This does not claim the live Turso database reflects any of this schema
yet — the migration is staged and reviewed but its live application is
tracked as a separate step with its own explicit approval gate, per
`AGENTS.md`; nothing in this entry's verification touched Turso. It does
not claim the unbounded-`POST /api/chat/conversations` gap is anything
more than a known, written-up risk — no rate limit, cap, or pagination was
added, and the right one wasn't this session's call to make alone (see
"Found, not fixed"). It does not claim every chat-history read in the
codebase is now conversation-scoped from a from-scratch audit — the two
call sites that mattered (`app/api/chat/route.ts`'s AI prompt history,
`app/app/chat/page.tsx`'s display history) were both found and fixed
because they were the two places `ChatMessage` was ever queried outside
`lib/data/conversations.ts` itself, not because every query in the
codebase was re-swept for a userId-only chat read. It does not claim the
backfill migration's per-user title choice (earliest `role='user'`
message) was validated against real user data — the live DB has never
been queried to see what those titles will actually look like once
applied.

## Default Category Tree Expansion + AI Disambiguation Examples — 2026-09-04

The default category tree only had 9 expense top-levels (~15
subcategories) and 5 flat income categories — too sparse for
`lib/ai/parse-transaction.ts`'s free-text categorization to have a real
match for common expenses (insurance, pets, personal care, gifts, savings,
sports, travel), so the model was falling back to «سایر هزینه‌ها» more
than it should. This session replaces the tree and adds prompt examples
for the categories most likely to be confused with each other. All
current users are internal testers explicitly told not to use the app
until this ships — **no backward-compatibility, migration, or backfill
logic was added, deliberately**; existing `Category` rows for those
testers were explicitly out of scope for this session.

- **`prisma/default-categories.ts`:** `DEFAULT_CATEGORIES` replaced
  wholesale — **23 top-level categories / 59 subcategories** (up from
  9/15), covering the gaps called out above (بیمه, حیوان خانگی, خدمات
  شخصی و زیبایی, هدیه و خیریه, اقساط و بدهی, پس‌انداز و سرمایه‌گذاری as
  its own expense bucket, سفر and ورزش و تناسب‌اندام promoted to
  top-level, income split into 6 top-levels with سرمایه‌گذاری gaining 2
  subcategories). `DefaultCategorySeed`'s interface and `isEssential`
  semantics (non-discretionary; see `lib/analytics/spending-summary.ts`'s
  `discretionaryExpense`) are unchanged — every new leaf was assigned
  `isEssential` by the same judgment already applied to the existing ones
  (e.g. لوازم آرایشی و بهداشتی: `true`, but آرایشگاه و سالن
  زیبایی/خشکشویی: `false`; کمک مالی به خانواده: `true`, but هدیه تولد و
  مناسبت/خیریه و صدقه: `false`).

- **Re-seeding `DefaultCategory` — real bug found, not fixed (outside
  this session's approved file list):** This project has no separate
  "dev" database — `lib/prisma.ts` reads `TURSO_DATABASE_URL`/
  `TURSO_AUTH_TOKEN` directly with no override, and only `npm test` (via
  `vitest.config.ts` + `test/setup/global-setup.ts`) redirects to a local
  SQLite file; running `npx tsx prisma/seed.ts` as-is would hit the
  **live** Turso DB, which this task explicitly forbade touching. So
  verification ran the real, unmodified `prisma/seed.ts` against a
  scratch local SQLite file instead — schema built by applying every
  `prisma/migrations/*/migration.sql` in order, the same way
  `global-setup.ts` does, with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` set
  to the scratch file *before* `dotenv/config` runs (which only fills
  already-unset vars, so `.env`'s live credentials are never loaded) —
  never against `.vitest-test.db` and never against live Turso. Printed
  result: **`Seeded default categories. Total rows: 109`** (82 = 23+59
  from the new tree, +27 pre-existing rows from the legacy
  Postgres-derived seed snapshot baked into
  `20260802175335_..._default_categories`'s `migration.sql`, per
  `AGENTS.md`'s own documented history — upserting by design leaves
  unused old-named rows in place, e.g. `خانه و زندگی`/`سلامت و
  درمان`/`انتقال بین حساب‌ها`×2/`سایر`×2/`درآمد`, matching the exact
  behavior `global-setup.ts`'s own comment already describes).

  Diffing the seeded table against the new `DEFAULT_CATEGORIES` surfaced a
  real bug in `prisma/seed.ts`: the top-level upsert's `update:` clause
  sets `icon`/`color`/`isEssential` but never reset `parentId`, so a
  `(name, type)` that already existed **as a child** in that legacy
  snapshot stayed a child instead of being promoted to top-level. Four of
  this session's new top-level names collided with legacy children:
  `حقوق`/`هدیه`/`سرمایه‌گذاری` (income) were already children of the
  legacy `درآمد`, and `بیمه` (expense) was already a child of `قبوض و
  اشتراک` — all four got their `icon`/`color`/`isEssential` correctly
  refreshed but **stayed nested under their stale legacy parent** instead
  of becoming real top-level rows. Since `lib/data/onboarding.ts`'s
  `seedDefaultCategoriesForUser()` builds a new user's category list from
  `where: { parentId: null }`, a real signup would have gotten `درآمد`
  (not in the new tree at all) as a top-level income category with
  `حقوق`/`هدیه`/`سرمایه‌گذاری` nested under it, and `بیمه` nested under
  `قبوض و اشتراک`, instead of four independent top-levels — plus all 7
  other legacy top-level rows copied into every new user's list too,
  since that query has no filter beyond `parentId: null`. The child-side
  upsert didn't have this bug (its own `update:` clause already set
  `parentId: parent.id`).

  This was outside this session's originally-approved file list
  (`prisma/seed.ts`, `test/setup/global-setup.ts`), so it was surfaced to
  the user rather than silently patched — asked via `AskUserQuestion`
  once the bug and its blast radius were fully understood, and the user
  chose to have it fixed now. **Fixed:** both upserts now add `parentId:
  null` to their `update:`/`ON CONFLICT ... DO UPDATE SET` clause —
  `prisma/seed.ts`'s Prisma-Client upsert and `test/setup/global-setup.ts`'s
  raw-SQL mirror (kept in sync deliberately, since the latter is what
  every `npm run test` run actually seeds with). Re-verified against a
  fresh scratch local SQLite file (same build process as above, not
  `.vitest-test.db`, not live Turso): all 4 previously-misplaced names now
  read `parentId: null` (`SELECT ... WHERE name IN (...)`), top-level count
  moved from 26→30 (23 new + 7 harmless legacy leftovers, as intended) and
  child count from 83→79, and a full sweep confirmed every name in the new
  `DEFAULT_CATEGORIES` now has `parentId: null` with zero exceptions. **Not
  applied to live Turso** — this fix only changed the two source files;
  actually re-seeding the live DB with the corrected script remains a
  separate, explicitly-gated step per `AGENTS.md`, not taken this session.

- **`lib/ai/parse-transaction.ts` (`buildSystemPrompt`, additive only):**
  6 new lines in the existing "نمونه برای دسته‌های مشابه" example block —
  بیمه خودرو (vs. حمل‌ونقل), غذای حیوان خانگی (vs. سوپرمارکت), قسط وام
  شخصی vs. قسط وام مسکن (only مسکن on an explicit خانه/مسکن mention),
  خرید طلا و ارز for an explicitly-for-savings gold purchase (checked it
  doesn't conflict with the existing `assetPurchase` rule — "برای
  پس‌انداز" already matches that rule's own "سرمایه‌گذاری/پس‌انداز"
  wording, so `assetPurchase` still fires independently of `category`),
  آرایشگاه و سالن زیبایی (vs. تفریح و سرگرمی), and کمک مالی به خانواده
  (vs. هدیه تولد و مناسبت, unless a specific occasion is named). No other
  prompt structure changed — confirmed via `lib/ai/parse-transaction.test.ts`'s
  existing `.toContain()` assertions on the older 6 example lines, all
  still passing unmodified.

- **`lib/category-aliases.ts`: checked, no changes needed.** Its 3 keys
  were audited against the new tree: `سوپرمارکت` and `دارو` are
  unchanged (still the exact same subcategory strings, under the same
  parents). `دخانیات` was never a seeded `DefaultCategory` name in either
  the old or new tree — it's a `resolveNewCategoryIcon`-recognized name
  for a category the AI is instructed to *suggest* (`newCategorySuggestion`)
  that a user may have created for themselves, which the alias comment's
  own "existing seeded **or user-created** category name" rule already
  covers; nothing to fix.

- **Verification (re-run after the `prisma/seed.ts`/`global-setup.ts`
  fix above):** `npm run test`: **72/72 files, 820/820 tests passing**
  (unchanged file/test count — this session added no new tests; every
  prompt-block assertion touched is additive/`.toContain()`-based, and no
  existing test happened to assert on the specific top-level/child
  placement the seed bug affected, so the fix shows up as "still green,"
  not as new passing assertions). `npx tsc --noEmit`: same 8 pre-existing
  `TS2737` BigInt-literal errors in `app/api/assets/route.test.ts`/
  `lib/prices/get-live-prices.test.ts`, neither file touched this
  session. `npm run lint`: same 3 pre-existing warnings (`components/
  logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s unused
  `categoryId`, the workflow route's unused eslint-disable directive). No
  live-database reads or writes at any point this session.

## Default Category Tree — Applied to Live Turso — 2026-09-04

Follow-up to "Default Category Tree Expansion + AI Disambiguation Examples"
above, same day. That entry staged the 23-top-level/59-subcategory
`DEFAULT_CATEGORIES` tree and the `prisma/seed.ts` `parentId: null` upsert
fix, but verified both only against a scratch local SQLite file — applying
either to live Turso was explicitly left as a separate, gated step. This
session ran the same, unmodified `prisma/seed.ts` for real against live
Turso, per explicit user approval.

**Pre-flight found live's baseline didn't match the scratch test's, in a
good way.** Live `DefaultCategory` had 26 rows going in, but not the same
26/27-ish legacy-Postgres-snapshot content the prior entry's scratch DB had
— that scratch baseline came from replaying every `prisma/migrations/*/
migration.sql` from scratch, which includes the legacy seed rows baked into
`20260802175335_..._default_categories` (`خانه و زندگی`, `سلامت و درمان`,
etc., per `AGENTS.md`'s note that this migration's SQL was never actually
run as-is against Turso). Live's real 26 rows never had that legacy
content at all — they were the *old* real tree (9 expense top-levels, 12
subcategories, 5 flat income top-levels), evidently from an actual past
run of the old `prisma/seed.ts` against live. Consequence: the 4 names the
prior entry named (`حقوق`/`هدیه`/`سرمایه‌گذاری`/`بیمه`) did not reproduce
the bug on live — `حقوق`/`سرمایه‌گذاری`/`هدیه` were already top-level, and
`بیمه` didn't exist yet. So all 23 new top-level names were cross-checked
against live's actual rows instead of stopping at those 4, and one real
live instance of the same bug turned up: `سفر`, a child of `تفریح و
سرگرمی` in the old tree, promoted to top-level in the new one — exactly
the kind of stale-`parentId` collision the fix targets. Every other new
top-level name was either already correctly top-level live or didn't
exist yet (plain create, bug not reachable there).

**Run:** `npx tsx prisma/seed.ts` → printed **`Seeded default categories.
Total rows: 82`** (23 top-level + 59 subcategories, matching the prior
entry's tree exactly).

**Verified against live Turso directly (not a scratch file):**

- `حقوق`/`سرمایه‌گذاری`/`هدیه`/`بیمه`: all `parentId = NULL`.
- All 23 `DEFAULT_CATEGORIES` top-level names present with `parentId =
  NULL` and the correct `type` — checked exhaustively, not just spot-check
  names, and `حیوان خانگی`/`بیمه`/`سفر`/`ورزش و تناسب‌اندام`/`خدمات شخصی
  و زیبایی`/`هدیه و خیریه`/`اقساط و بدهی`/`پس‌انداز و سرمایه‌گذاری` also
  individually confirmed with matching `icon`/`color`/`isEssential`.
- `lib/data/onboarding.ts`'s `seedDefaultCategoriesForUser()` (`where: {
  parentId: null }`, not modified) would now return **exactly the 23 new
  top-levels — zero legacy leftovers**, cleaner than the prior entry's
  scratch-test outcome of "23 + 7 harmless leftovers": live never had
  those 7 rows to begin with, and every one of its 26 pre-existing rows
  matched a name in the new tree (9 expense top-levels + `سفر` + 5 income
  top-levels + 11 retained subcategories = 26), so nothing was left
  stranded.

**Scope held:** only `DefaultCategory` was written. No existing user's
`Category` rows were read or touched this session — that backfill remains
explicitly out of scope, per the prior entry's own decision.

## Per-User Category Backfill + New-Category Icon Table + Personal-Care Disambiguation — 2026-09-04

Follow-up to the two entries above, same day. Those left every user's own
`Category` rows on the old 9/15 tree deliberately — this session is that
backfill, plus two related bugs reported by the user: the AI finding no
match for things like "ترمیم ناخن" (nail repair) against a user's stale
category list and proposing a duplicate new category instead of the
now-existing «خدمات شخصی و زیبایی» / «آرایشگاه و سالن زیبایی», and
`resolveNewCategoryIcon` (`lib/categories.ts`) falling back to a generic
📦 for almost every AI-suggested new category since `NEW_CATEGORY_ICONS`
only had 6 entries. All current `User` rows are internal test accounts
with disposable data, confirmed explicitly by the user for this session.

### 1. Investigation — `Category`/`Transaction` FK, before touching data

`Transaction.categoryId → Category` and `MerchantMapping.categoryId →
Category` are both `onDelete: Restrict` (`prisma/schema.prisma`), not
Cascade or SetNull — confirmed DB-enforced on the live connection
(`PRAGMA foreign_keys` returned `1`), not just a schema-level annotation.
`Category.parentId`'s own self-relation is `Restrict` too, so a parent row
can't be deleted while a child still points to it either.

A read-only count against live Turso (74 users, 466 total `Category` rows)
found **29 `Transaction` rows + 3 `MerchantMapping` rows across 7 users**
(`1, 2, 623, 626, 683, 685, 700`) still referencing their own old
`Category` rows — count > 0, so per the task's own instruction this
stopped short of any write and was reported back rather than decided
unilaterally. Digging into *which* old names those 29+3 rows pointed at:
23/29 transactions + 2/3 mappings matched a new-tree name verbatim (e.g.
`رستوران و کافه`, `سایر هزینه‌ها`, `دارو`, `حقوق`); the remaining 6
transactions + 1 mapping referenced names with no new-tree equivalent at
all — `دسته مالکیت الف` / `دسته تست منبع` (literal leftover fixture
categories from automated E2E test runs on users 623/626) and `دخانیات` /
`استارتاپ` (custom categories on user 1, apparently created via the AI's
own `newCategorySuggestion` flow rather than seeded from
`DefaultCategory`).

Presented two options via `AskUserQuestion` per the task's instructions
(remap the 29+3 rows to new-tree categories by name before deleting vs.
wipe `Transaction`+`MerchantMapping`+`Category` entirely and reseed
clean) — user responded "هرکدوم بهتره" ("whichever is better"), delegating
the choice. Went with **wipe + reseed clean**: simpler and less
error-prone than fuzzy name-matching + a permanent carve-out for the 7
unmatched rows, matches this project's own already-stated precedent for
this exact tree change ("no backward-compatibility, migration, or
backfill logic was added, deliberately" — prior entry above), and the
data is already confirmed disposable (2 of the 7 affected users are
literal automated-test leftovers, not real usage).

### 2. Live refresh — wipe + reseed, `prisma/refresh-user-categories.ts` (kept)

New script, following the existing `prisma/backfill-categories.ts` /
`prisma/backfill-category-essentiality.ts` convention (dry run by default,
`--execute` to write) — kept rather than deleted after use, same as its
siblings, in case a future cohort of test users needs the same operation.
Also wipes `SpendingSummaryCache` (13 rows, across the same 7 users plus 3
more whose cache already referenced no live transactions before this
session even started): no FK to `Category`, but a cached
previous-month-by-category breakdown for transactions that no longer
exist would otherwise silently show wrong numbers on reports/chat rather
than recomputing live.

Before any write, dumps every current `Category`/`Transaction`/
`MerchantMapping`/`SpendingSummaryCache` row to a local timestamped JSON
snapshot (`/home/abt/jib-db-backups/pre-category-refresh-*.json`) as a
restorable safety net — `scripts/backup-live-db.ts` (the repo's general
export tool) currently self-aborts on this schema (its `EXPECTED_TABLES`
list predates the `Conversation`/`Asset`/`LivePriceCache` tables added
since it was written), so this script takes its own narrow snapshot
instead of relying on it; fixing that script was out of this session's
approved file list.

**Two infrastructure snags along the way, both fixed without touching
`lib/prisma.ts` or `lib/data/onboarding.ts`** (neither in scope, and the
task asked to reuse `seedDefaultCategoriesForUser()` unmodified):

- `seedDefaultCategoriesForUser()`'s own `$transaction()` (~40 sequential
  create/createMany round trips per user against remote Turso) exceeded
  Prisma's default 5000ms interactive-transaction timeout — the first
  attempt failed at 5354ms, rolling back cleanly (verified: all 74 users
  sat at exactly 0 categories afterward, never a partial count). Fixed via
  a new `prisma/_long-timeout-prisma-setup.ts` (kept, required by the
  refresh script), which constructs a `PrismaClient` with a longer
  `transactionOptions.timeout` and assigns it to `globalThis.prisma`
  *before* anything imports `@/lib/prisma` — exploiting that file's own
  existing global-singleton reuse hook
  (`globalForPrisma.prisma ?? new PrismaClient(...)`, originally there for
  Next.js dev-mode HMR dedup) rather than editing it.
- Running the script at all required `npx tsx --conditions=react-server`:
  `lib/data/onboarding.ts` starts with `import "server-only"`, which only
  no-ops under Next's own webpack/Turbopack build and otherwise
  unconditionally throws — the exact issue `vitest.config.ts` already
  documents and aliases around for test runs, not previously hit by any
  plain-`tsx` script in this repo since none of them imported
  `lib/data/onboarding.ts` before now. Node's own `--conditions` CLI flag
  satisfies the same export condition directly; documented in the
  script's own usage comment for reuse.
- Even with the longer client-side timeout, one run hit a second,
  *server-side* failure: `SQLITE_BUSY: ... interactive transaction was
  rolled back because the stream was idle for too long` (a libsql/Turso
  idle-stream limit, unrelated to and not fixed by Prisma's own timeout
  setting) — intermittent, not tied to a specific user, confirmed safe to
  retry (every failure, on both snags, left the affected user at exactly
  0 categories). Fixed with a 5-attempt retry-with-backoff wrapper around
  each user's seed call.
- Along the way, also found and fixed a real gap in the script's own
  resumability: the delete phase ran unconditionally on every
  `--execute`, so a partially-succeeded run's already-correctly-reseeded
  users got deleted and recreated all over again on the next retry
  instead of being left alone (not a correctness bug — reseeding is
  deterministic, so the end state was still right — but wasteful, and it
  needlessly re-exposed already-done users to the same intermittent
  failure above). Fixed by excluding any user already sitting at exactly
  `EXPECTED_TREE_SIZE` categories (computed from `DEFAULT_CATEGORIES`
  itself, not hardcoded) from the delete phase.

**Result, verified independently against live Turso after completion:**
all 74 users sit at exactly 82 categories each (23 top-level + 59
subcategories, matching `DEFAULT_CATEGORIES` with zero missing/unexpected
entries — spot-checked exhaustively for user 1); total `Category` rows
466 → 6068 (74 × 82, exact); `Transaction`/`MerchantMapping`/
`SpendingSummaryCache` all at 0; zero `Category` rows with a `parentId`
not resolving to a real row. User 1 (the account matching this project's
own owner) now has both «خدمات شخصی و زیبایی» (parent) and «آرایشگاه و
سالن زیبایی» (child) present — the exact pair this session's reported bug
was about.

### 3. `lib/categories.ts` — `NEW_CATEGORY_ICONS` expanded (icon table only)

6 → 29 entries. Kept the existing 6 unchanged; added 23 more grouped by
theme (personal care/beauty, entertainment/lifestyle, finance/
speculative, religious/charitable, family/childcare, transport/errands,
home services) — mostly the concepts named in this session's task
(`مانیکور`, `پدیکور`, `تتو`, `جراحی زیبایی`, `لوازم آرایشی`, `بازی
ویدیویی`, `کریپتو`, `رمزارز`, `قمار و شرط‌بندی`, `بلیط بخت‌آزمایی`,
`مذهبی`, `زکات`, `شهریه مهدکودک`, `کلاس موسیقی`, `لوازم بچه`, `کافه‌گردی`,
`پیک موتوری`), plus two judged additions (`اجاره خودرو`, `کارگر نظافت`) —
each chosen for having no reasonable fit among the 23/59 tree's own
subcategories. `DEFAULT_NEW_CATEGORY_ICON` (📦) unchanged as the
fallback for the genuine long tail, deliberately not eliminated.

Found and documented (didn't change the matching logic, out of scope for
this file's icon-table-only mandate): `resolveNewCategoryIcon` does a
plain `normalizeText(name)` dictionary lookup, and `normalizeText`
(`lib/normalize.ts`) replaces a ZWNJ/half-space with a plain space — so a
key written with a literal ZWNJ (the "correct" Persian spelling for
compounds like `شرط‌بندی`/`بخت‌آزمایی`/`کافه‌گردی`) would never match.
Every multi-word key added is written with a plain space instead, and the
gotcha is now called out directly above the table for whoever adds the
next entry.

### 4. `lib/ai/parse-transaction.ts` — one disambiguation example (additive only)

Added to `buildSystemPrompt`'s existing "نمونه برای دسته‌های مشابه" block,
directly after the existing «رفتم آرایشگاه» example: "«ترمیم ناخن کردم» /
«مانیکور کردم» → category: «خدمات شخصی و زیبایی»، subcategory: «آرایشگاه
و سالن زیبایی» (نه «لوازم آرایشی و بهداشتی»، چون این یک خدمت است نه خرید
لوازم آرایشی)" — same format as every existing line, clarifying that a
nail service is a *service* (`آرایشگاه و سالن زیبایی`), not a product
purchase (`لوازم آرایشی و بهداشتی`), the two subcategories under the same
parent an LLM could plausibly conflate here.

### Verification

- `npm run test`: **72/72 files, 820/820 tests passing** — unchanged from
  the prior entry's baseline (no test asserted the old 6-entry
  `NEW_CATEGORY_ICONS` size or a specific prompt-block line count; every
  assertion touched by this session's changes was already
  `resolveNewCategoryIcon(...)`-relative or `.toContain()`-based).
- `npx tsc --noEmit`: unchanged — same 8 pre-existing `TS2737`
  BigInt-literal errors in `app/api/assets/route.test.ts`/
  `lib/prices/get-live-prices.test.ts`, neither file touched this
  session.
- `npm run lint`: unchanged — same 3 pre-existing warnings
  (`components/logo.tsx`'s `<img>`, `lib/data/transactions.test.ts`'s
  unused `categoryId`, the workflow route's unused eslint-disable
  directive).
- Live-Turso state independently re-verified after the refresh completed
  (see "Result" under §2 above) — not inferred from the script's own
  printed output alone.

### Scope held

Touched: `prisma/refresh-user-categories.ts` (new, kept) +
`prisma/_long-timeout-prisma-setup.ts` (new, kept, required by the
former) for the live refresh; `lib/categories.ts` (icon table only);
`lib/ai/parse-transaction.ts` (one prompt example, additive only). No
schema migration. No admin-UI changes. `lib/prisma.ts` and
`lib/data/onboarding.ts` were read but never edited, per the task's own
instructions — the transaction-timeout fix works around both from the
outside instead (§2 above). `scripts/backup-live-db.ts`'s
`EXPECTED_TABLES` gap was found and reported, not fixed — outside this
session's approved file list.

### Do Not Claim

This does not claim the 6 unmatched old-category rows (`دسته مالکیت الف`
/ `دسته تست منبع` / `دخانیات` / `استارتاپ`) had any value worth
preserving beyond what the backup JSON snapshot now holds — the "wipe"
option was chosen specifically because they didn't. It does not claim
`scripts/backup-live-db.ts` is fixed or usable as-is; it still self-aborts
on this schema. It does not claim every realistic `newCategorySuggestion`
concept now has a dedicated icon — `NEW_CATEGORY_ICONS` covers 29 named
concepts judged likely, not an exhaustive set, and `DEFAULT_NEW_CATEGORY_ICON`
is still expected to fire for genuine long-tail suggestions. It does not
claim the two live-only failures in §2 (the client-side transaction
timeout and the server-side idle-stream error) are fully understood at
the libsql/Turso infrastructure level — both were worked around
(longer timeout, retry-with-backoff) and confirmed safe (clean rollback,
no partial state) rather than root-caused further.

## Reports: Essential/Discretionary Awareness + Comparable Bar Charts — 2026-09-05

The week/month/year comparison tabs on the Reports page (`app/app/reports/page.tsx`)
already had `Category.isEssential` sitting unused right next to them —
`lib/analytics/spending-summary.ts` (the chat assistant's data) already reads it,
but `lib/reports/monthly-comparison.ts` didn't even select the column, and
`lib/reports/generate-highlights.ts` judged every category by `percentChange` alone,
with no notion of "can the user actually cut this" or of absolute toman amounts. Separately,
`CategoryComparisonBar` scaled each bar against its own local `max(previous, current)`, so a
50,000 toman category and a 5,000,000 toman category could render with similarly-sized bars.

### 1. `lib/reports/monthly-comparison.ts` — select and surface `isEssential`

Added `isEssential: boolean` to `CategoryComparison`. `getComparison()`'s category query now
selects `isEssential` alongside `id`/`name`, and each built `CategoryComparison` carries the
matching category's value (defaulting to `true` — same as `Category.isEssential`'s own schema
default — in the defensive case a record isn't found, which shouldn't happen since `categoryIds`
is derived from these same rows). `lib/reports/monthly-comparison.test.ts`: the food/insurance
test categories are now created with explicit `isEssential: false`/`true` (previously relying on
the schema default for both), with assertions added to the existing "normal case" and "drops to
zero" tests rather than new ones.

### 2. `lib/reports/generate-highlights.ts` — essential-aware, amount-aware, re-ranked

- **Essential vs. discretionary tone.** The old single `categoryWarningCandidate` (any category,
  percent-only) is now two candidates: `discretionaryWarningCandidate` (isEssential: false only,
  unchanged actionable "کمی مراقب باشید" wording) and `essentialIncreaseCandidate` (isEssential:
  true only, neutral wording — "هزینه ضروری «X» ... افزایش یافته است." with no "be careful"
  framing). This needed a third `HighlightType`, `"info"`, since the existing `"warning"` type's
  red/amber `HighlightCard` styling would have contradicted the neutral tone the task asked for
  no matter what the message text said — `HighlightCard.tsx` now maps each of the three types to
  its own tone (`positive`/`warning` unchanged, `info` new: muted/gray, `ShieldIcon`, matching the
  neutral-badge pattern `CategoryComparisonBar` already used for a flat 0% change).
- **Amount-aware warning trigger.** `discretionaryWarningCandidate` now also qualifies a category
  whose absolute increase (`currentAmount - previousAmount`) exceeds `WARNING_ABSOLUTE_INCREASE_SHARE`
  (15%, picked as this session's default) of `totalCurrent` (falling back to `totalPrevious` if
  `totalCurrent` is 0) — independent of `WARNING_INCREASE_THRESHOLD` (50%), so a big-money
  discretionary category growing only 20% still surfaces. Ranked by whichever of the two signals
  (percent or share) is larger.
- **New `discretionaryTotalCandidate`.** Reports the current period's total discretionary spending
  as a concrete, real figure — `"{formatToman(discretionaryTotal)} از هزینه‌های این دوره غیرضروری
  بوده و قابل کاهش است."` — independent of whether any single category increased. `Highlight`
  gained an optional `amount?: number` field carrying the raw figure alongside the formatted
  message, matching the existing `category?` pattern rather than restructuring the interface.
- **Re-tuned ranking.** `Candidate.isOverall: boolean` became `Candidate.priority: 0 | 1 | 2`
  (0 = the overall-savings headline, 1 = discretionary/actionable candidates + the new
  discretionary-total figure, 2 = essential-cost "noise"), sorted by priority first and magnitude
  only as a tiebreak within a tier. Without this, a huge essential-cost increase (e.g. rent
  jumping 200%) would out-rank real discretionary/actionable candidates under plain
  magnitude-only sorting — a new regression test constructs exactly that scenario (a 200%
  essential increase alongside three qualifying discretionary/actionable candidates) and asserts
  the essential one is the one dropped by the `MAX_HIGHLIGHTS` cap, not one of the other three.
- **Tests:** `lib/reports/generate-highlights.test.ts` — the `category()` helper now defaults
  `isEssential: false` (most of the file's existing categories are discretionary-flavored anyway,
  e.g. خوراک/سرگرمی/پوشاک/سفر). Every existing test was re-checked against the new
  `discretionaryTotalCandidate` firing implicitly whenever there's discretionary spending: two
  tests needed their expected output updated (a highlight the old code couldn't produce now
  legitimately also qualifies), two others were verified to still resolve to the same 3-highlight
  output because the new candidate's magnitude loses the tiebreak (comment added explaining why),
  and one was given explicit `isEssential: true` categories so it still asserts "no highlights at
  all" cleanly. Five new tests cover: the absolute-share trigger firing under the 50% percent
  threshold, the essential-increase `"info"` highlight (asserting it does *not* contain "مراقب
  باشید"), an essential category's large decrease still producing a `"positive"` savings
  highlight, and the anti-drowning ranking regression described above.

### 3. Chart scaling + essential/discretionary visuals

- `CategoryComparisonBar.tsx`: replaced the per-bar local `Math.max(previousAmount,
  currentAmount, 1)` with a `sharedMax: number` prop. `MonthlyComparisonReport.tsx` computes it
  once — `Math.max(...categories.flatMap(c => [c.previousAmount, c.currentAmount]), 1)` — and
  passes it to every bar, so bar widths are now comparable across the whole category list, not
  just within one category's own previous/current pair.
- Each bar now also shows an essential/discretionary indicator next to the category name —
  `ShieldIcon` (essential) or `TagIcon` (discretionary), both already existing in
  `components/icons.tsx`; no new icon needed.
- New `components/reports/DiscretionarySplitCard.tsx`: a dependency-free CSS stacked bar (two
  `<div>`s sized by percentage, no SVG needed) showing the current period's essential vs.
  discretionary split, with a legend giving both totals via `formatToman` and the discretionary
  share as a percentage via `formatNumber`. Same `rounded-2xl border border-border bg-surface p-4`
  card style as its siblings. Rendered in `MonthlyComparisonReport.tsx` above the per-category
  bars. `TodaySpendingReport.tsx` and `ActivityHeatmap.tsx` were left untouched, per the task's
  own scope note (neither tab has a previous-period comparison to build this off of).

### Verification

- `npm run test`: **73/73 files, 829/829 tests passing** (baseline: 72/72 files, 820/820 — the
  extra file/5 of the 9 extra tests are `components/transactions/batch-add-transaction-form.test.tsx`,
  pre-existing uncommitted work from before this session, not touched here; this session's own
  net addition is +4 tests, all in `lib/reports/generate-highlights.test.ts`).
- `npx tsc --noEmit`: unchanged — same 8 pre-existing `TS2737` BigInt-literal errors in
  `app/api/assets/route.test.ts`/`lib/prices/get-live-prices.test.ts`, neither file touched this
  session.
- `npm run lint`: unchanged — same 3 pre-existing warnings (`components/logo.tsx`'s `<img>`,
  `lib/data/transactions.test.ts`'s unused `categoryId`, the workflow route's unused
  eslint-disable directive).

### Scope held

Touched: `lib/reports/monthly-comparison.ts` + its test, `lib/reports/generate-highlights.ts` +
its test, `components/reports/MonthlyComparisonReport.tsx`, `components/reports/
CategoryComparisonBar.tsx`, `components/reports/HighlightCard.tsx` (render-side change required
by the new `"info"` type), `components/reports/DiscretionarySplitCard.tsx` (new). No changes to
`app/app/reports/page.tsx` — it already passed `comparison` straight through, and `comparison.
categories` carries `isEssential` once Goal 1 landed, so no new prop threading was needed. No
schema migration. No new npm dependency — the split card is plain CSS, matching
`ActivityHeatmap.tsx`'s existing hand-rolled-visual precedent. No icon files added — `ShieldIcon`/
`TagIcon` already existed and fit.

### Do Not Claim

`WARNING_ABSOLUTE_INCREASE_SHARE` (15%) and the exact Persian wording for the new/changed
highlight messages were confirmed with the project owner before implementation, not derived from
the codebase — there was no existing precedent for either in this repo. This does not claim the
15% figure is empirically tuned against real user data; it's a reasonable starting default the
project owner explicitly approved, adjustable later if it fires too often or too rarely in
practice.

## Reports: Granularity-Agnostic Trend/Insight Data Layer (Phase 1) — 2026-09-05

Data-layer-only phase: new `lib/reports/trend-insights.ts` builds week/month/year cash-flow
trend, recurring-expense, and unusual-transaction primitives for the Reports page, reusing
`lib/reports/period-range.ts`'s existing generic period arithmetic and
`lib/analytics/spending-summary.ts`'s existing pure `computeRecurringExpenses`/
`computeUnusualTransactions`/`computeSavingsRate` functions rather than duplicating their logic.
No UI changes — `components/reports/` was not touched.

### 1. `lib/reports/trend-insights.ts` (new)

- **`getPeriodTrend(userId, currentPeriod, granularity, periodsBack)`** — `periodsBack + 1`
  periods (current + N prior), oldest first, each `{ periodKey, label, income, expense, net }`.
  Walks backward via `getPreviousPeriod`, then batches all periods' `prisma.transaction.groupBy`
  reads with one `Promise.all` (not sequential awaits). Same computational idea as
  `spending-summary.ts`'s `computeCashFlowTrend` (net = income - expense per period) but built
  fresh against `period-range.ts`'s generic arithmetic instead of that function's Jalali-month +
  `SpendingSummaryCache`-specific wiring, per the task's explicit instruction not to reuse it
  directly.
- **`getRecurringExpenses(userId, currentPeriod, granularity)`** — buckets expense transactions
  per period and delegates to the existing `computeRecurringExpenses`. The lookback *count* (how
  many periods to bucket) needed per-granularity judgement since `computeRecurringExpenses`'s own
  "present in >= 2 buckets" threshold is already granularity-agnostic:
  - `month` reuses `RECURRING_EXPENSE_LOOKBACK_MONTHS` (3) unchanged — exported from
    `spending-summary.ts` (was private) specifically so this module's month behavior can't drift
    from the chat assistant's.
  - `week` also uses 3 — the same "present in >= 2 of the last 3" reasoning holds for a
    weekly-cadence expense as it does for a monthly one.
  - `year` uses **2**, not 3 — reasoned through per the task's own prompt: a 3-year lookback would
    require 3 full years of history from every user before ever firing once, an unreasonably high
    bar; "present in both of the last 2 years" is still a real recurring signal (an annual
    renewal) at a much more reachable one. Documented as a code comment on
    `RECURRING_EXPENSE_LOOKBACK_PERIODS` in the new file, and covered by a test that deliberately
    plants a description 2 years back (present in year N and N-2 but not N-1) to prove the
    2-period lookback doesn't reach that far.
- **`getUnusualTransactions(userId, currentPeriod, granularity)`** — fetches the current period's
  expense transactions with `category: { name, isEssential }` and calls the existing
  `computeUnusualTransactions` directly; already granularity-agnostic, no new decision needed.
- **`getPeriodSavingsRate(income, expense)`** — thin wrapper over the existing
  `computeSavingsRate`, not a reimplementation.
- `computeUnusualTransactions`/`computeRecurringExpenses`/`computeSavingsRate` and the
  `RecurringExpense`/`UnusualTransaction` types were already exported from `spending-summary.ts`
  before this phase (checked first, per the task's scope note) — a no-op there. The private
  `UnusualTransactionCandidate`/`DescriptionTransaction` input-shape types were left private and
  un-exported; this file's own Prisma `select`s structurally match them, which TypeScript accepts
  without a nominal import.
- `lib/format.ts` gained three label helpers, since only a bare-month-name one
  (`jalaaliMonthKeyToLabel`) existed and none of the three fit a multi-period trend that can cross
  a year boundary: `jalaaliMonthKeyToFullLabel` (month + year, e.g. "مرداد ۱۴۰۴"),
  `jalaaliWeekKeyToLabel` ("هفته ۵ - ۱۴۰۴"), `jalaaliYearKeyToLabel` ("۱۴۰۴").

### 2. `isEssential` gap in `lib/reports/monthly-comparison.ts`

Already fixed by uncommitted work already present in the working tree at the start of this phase
(see the "Essential/Discretionary Awareness" entry above, dated the same day) — `CategoryComparison`
already carries `isEssential`, `getComparison()`'s category query already selects it, and
`monthly-comparison.test.ts` already asserts it on explicit `isEssential: true`/`false` test
categories. Verified, not re-done.

### 3. Integration into `app/app/reports/page.tsx`

Went with "wire it in now, unused" rather than stopping short: the week/month/year branch's
`getComparison` call now runs alongside `getPeriodTrend`/`getRecurringExpenses`/
`getUnusualTransactions` in one `Promise.all`, with the three new results explicitly `void`-ed
(with a comment pointing at this entry) rather than rendered — Phase 2 wires them into the UI.
`TREND_PERIODS_BACK = 5` (current + 5 prior) is a new page-level constant, same "enough for a real
trend, not just current-vs-previous" reasoning as `spending-summary.ts`'s `CASH_FLOW_TREND_MONTHS`,
shared across all three granularities since the not-yet-built chart is expected to have the same
shape regardless of tab. No `components/reports/` file was touched.

### Testing

New `lib/reports/trend-insights.test.ts`, mirroring `monthly-comparison.test.ts`/
`today-spending.test.ts`'s conventions (real Prisma test-DB writes in `beforeAll`, cleanup in
`afterAll`, one `describe` per exported function, named test constants). Covers: period bucketing
across a Jalaali year boundary for both week granularity (`getPeriodTrend`) and month granularity
(`getPeriodTrend` with `periodsBack: 2`, and `getRecurringExpenses`'s 3-month lookback), `isTransfer`
exclusion (asserted directly in all three DB-backed describes, including a transfer-categorized
transaction large enough to obviously skew results if it leaked through), income/expense
separation, recurring detection (both the general 2-of-3 case and the year-specific 2-period-lookback
edge case above), and unusual-transaction detection against a deliberately crafted 3-transaction
category (one outlier at 5x the other two's average).

- `npm run test`: **74/74 files, 836/836 tests passing** (this session's own starting point, after
  the already-present uncommitted "Essential/Discretionary" work above, was 73/73 files, 829/829 —
  this phase's net addition is +1 file / +7 tests, all in the new `trend-insights.test.ts`; original
  task baseline was 72/72, 820/820 before either phase).
- `npx tsc --noEmit`: unchanged — same 8 pre-existing `TS2737` BigInt-literal errors in
  `app/api/assets/route.test.ts`/`lib/prices/get-live-prices.test.ts`, neither file touched.
- `npm run lint`: unchanged — same 3 pre-existing warnings (`components/logo.tsx`'s `<img>`,
  `lib/data/transactions.test.ts`'s unused `categoryId`, the workflow route's unused
  eslint-disable directive).

### Scope held

Touched: `lib/reports/trend-insights.ts` (new), `lib/reports/trend-insights.test.ts` (new),
`lib/analytics/spending-summary.ts` (only to export `RECURRING_EXPENSE_LOOKBACK_MONTHS` — the
other three functions/types needed no change, already exported), `lib/format.ts` (three new label
helpers), `app/app/reports/page.tsx` (data fetching only, per Integration above). No changes under
`components/reports/`. No schema migration. `lib/reports/monthly-comparison.ts`/its test were
inspected but not modified — the `isEssential` fix this phase asked for already existed.

### Do Not Claim

The year-granularity recurring-expense lookback of 2 (vs. week/month's 3) is a reasoned default
following the task's own explicit prompt to reconsider it, not a number confirmed with the project
owner — flagged here the same way `WARNING_ABSOLUTE_INCREASE_SHARE` was flagged in the entry above,
in case it turns out to need tuning once real usage data exists.

## Reports UI — Trend Chart + Recurring/Unusual Cards (Phase 2) — 2026-09-05

Consumes Phase 1's data layer (`lib/reports/trend-insights.ts`) on the Reports page, which fetched
`trend`/`recurringExpenses`/`unusualTransactions` but `void`-ed all three unrendered. Goals 1
(shared-max bar scaling), 3 (`DiscretionarySplitCard`), and 5 (amount-/essential-aware highlights)
from this phase's task were checked first and found already done by uncommitted work already
present in the working tree at the start of this session (see the "Essential/Discretionary
Awareness" entry above, same day) — verified against the task's own acceptance criteria
line-by-line, not re-done. This entry covers what was actually still open: the trend chart and the
two secondary insight cards, plus wiring all three Phase 1 values into the render tree.

### 1. `components/reports/PeriodTrendChart.tsx` (new)

Raw SVG bar chart of `TrendPeriod.net` per period (oldest-first) — no chart library is installed
(re-confirmed against `package.json`). Chose a single net bar per period over paired income/expense
bars: net directly answers "did I save or overspend this period", the same question
`generateHighlights`' savings/warning candidates are already built around, without asking the
reader to mentally subtract two bars against each other — and it reuses the success/warning color
semantics `CategoryComparisonBar`'s percent badges and `HighlightCard` already use, rather than
introducing a third color for "income". Bars share one `maxAbsNet` scale across the whole series.
A horizontal zero-baseline is always drawn (`var(--border)`); when every period is non-negative it
sits at the chart floor (an ordinary bar chart), and moves to the vertical middle the moment any
period goes negative, so bars can extend both directions off it. Colors come from CSS custom
properties (`var(--success)`/`var(--warning)`/`var(--muted)`/`var(--border)`, checked against
`app/globals.css`'s actual token names) applied via the `style` prop rather than the `fill`/`stroke`
attributes directly, matching how `CategoryComparisonBar` already threads a `var(--...)` string
through `style` rather than a presentation attribute. Each period's label
(`jalaaliWeekKeyToLabel`/`jalaaliMonthKeyToFullLabel`/`jalaaliYearKeyToLabel`, all Phase 1) is drawn
under its bar; week/month labels are long enough ("هفته ۵ - ۱۴۰۴", "مرداد ۱۴۰۴") to overlap their
neighbors at 6-wide unrotated, so they're rotated -40° and truncated past 11 characters, while
year's short "۱۴۰۴" labels stay flat and centered — this reads more naturally for year's "fewer,
wider bars" case the task called out, even though `TREND_PERIODS_BACK` (Phase 1) is currently the
same 5-prior-periods constant for all three granularities, so bar *count* doesn't actually differ
today; only label length does. A native SVG `<title>` per bar gives the exact `formatToman(net)`
figure on hover instead of drawing numeric labels that would overflow Persian-formatted toman
figures at this bar width. Rendered in `MonthlyComparisonReport.tsx` above `DiscretionarySplitCard`,
per the task's placement instruction.

### 2. `components/reports/RecurringExpensesCard.tsx` + `UnusualTransactionsCard.tsx` (new)

Both list their respective Phase 1 arrays (`RecurringExpense[]`/`UnusualTransaction[]`) and render
`null` outright when empty — checked how the page's own `emptyState()` helper works first: it's a
full-page `EmptyState` swap used when `comparison.categories`/`heatmap.activeDays` is empty, which
would be wrong for these two since they're secondary cards alongside real primary content, not the
whole page's content. `RecurringExpensesCard` is deliberately framed as "review these" — "این‌ها را
مرور کنید — شاید اشتراک یا قبضی باشد که یادتان رفته" — not a warning tone, using the existing
`RefreshIcon` (no new icon needed); a recurring expense isn't inherently a problem.
`UnusualTransactionsCard` uses the existing `AlertIcon`/`text-warning` tone already established by
`HighlightCard`'s own `warning` type, showing each transaction's category, amount, and its multiple
of the category average. Both match the `rounded-2xl border-border bg-surface p-4` card shell every
other `components/reports/` file uses.

### 3. Wiring — `MonthlyComparisonReport.tsx` + `app/app/reports/page.tsx`

`MonthlyComparisonReportProps` gained `trend`, `granularity` (`ReportGranularity` — the chart needs
it for label rotation/truncation, `MonthlyComparisonResult` itself carries no granularity),
`recurringExpenses`, and `unusualTransactions`. Render order: `PeriodTrendChart` →
`DiscretionarySplitCard` → per-category bars → `RecurringExpensesCard` →
`UnusualTransactionsCard` → highlights (kept last, as the report's closing takeaways). The file's
trailing "usage example" comment block was deleted rather than updated — it was already stale
(`page.tsx` had wired real usage in Phase 1) and would only have kept rotting as more props were
added. `app/app/reports/page.tsx`'s week/month/year branch: removed the three `void trend` /
`void recurringExpenses` / `void unusualTransactions` lines and passes all three straight through
to `MonthlyComparisonReport`, along with `granularity={tab}`. No change to the branch's existing
`comparison.categories.length === 0` empty-state check — out of this phase's scope, and Phase 1's
data-fetching shape didn't call for revisiting it.

### Verification

- `npm run test`: **74/74 files, 836/836 tests passing** — unchanged from this session's own
  starting baseline (the Phase 1 entry above). No new test files: this phase's scope was UI
  components with no test-file instruction (only `generate-highlights.test.ts` was named, and its
  changes were already done — see above), consistent with this codebase's own precedent of not
  unit-testing presentational `components/reports/` files (`ActivityHeatmap.tsx`,
  `DiscretionarySplitCard.tsx`, etc. have none either).
- `npx tsc --noEmit`: unchanged — same 8 pre-existing `TS2737` BigInt-literal errors in
  `app/api/assets/route.test.ts`/`lib/prices/get-live-prices.test.ts`, neither file touched.
- `npm run lint`: unchanged — same 3 pre-existing warnings (`components/logo.tsx`'s `<img>`,
  `lib/data/transactions.test.ts`'s unused `categoryId`, the workflow route's unused
  eslint-disable directive).

### Scope held

Touched: `components/reports/PeriodTrendChart.tsx` (new), `components/reports/
RecurringExpensesCard.tsx` (new), `components/reports/UnusualTransactionsCard.tsx` (new),
`components/reports/MonthlyComparisonReport.tsx`, `app/app/reports/page.tsx` (prop wiring only).
No changes to `components/reports/CategoryComparisonBar.tsx`, `lib/reports/generate-highlights.ts`,
or its test — already done by prior uncommitted work, verified not re-done. No changes to
`components/icons.tsx` — `RefreshIcon`/`AlertIcon` already existed and fit. No new npm dependency —
the trend chart is raw SVG, matching `ActivityHeatmap.tsx`'s hand-rolled-visual precedent. No
schema migration.

### Do Not Claim

The single-net-bar-vs-paired-income/expense-bars chart shape was this session's own judgment call,
made under the task's explicit instruction to pick and justify one rather than ask — not confirmed
with the project owner. Same for the exact rotation angle (-40°) and truncation length (11
characters) for week/month labels — reasonable defaults, not pixel-tested against real narrow
mobile viewports in a running browser.

## Reports: Deterministic Narrative Report Card (Phase 3) — 2026-09-05

Verified Phase 1/2 were both actually complete (checked their code, not just their roadmap
entries, before starting) before building on top of them: `lib/reports/trend-insights.ts`'s data
layer and `MonthlyComparisonReport.tsx`'s trend chart/recurring/unusual cards both matched their
entries above. New `lib/reports/narrative-report.ts` is a pure, deterministic (no LLM) function
that turns the week/month/year branch's already-computed `comparison`/`trend`/
`unusualTransactions` into one cohesive narrative — status, headline income/expense, top
category, overall trend, one key insight, an end-of-period projection, a suggested cap, and a
savings opportunity — rendered as a single card at the top of `MonthlyComparisonReport`.

### 1. `lib/reports/narrative-report.ts` (new)

`generateNarrativeReport({ granularity, currentPeriod, comparison, trend, unusualTransactions, now? })`
→ `NarrativeReport`. Every sub-field follows the task's confirmed rules exactly:

- **Status**: `getPeriodSavingsRate(income, expense)` (trend-insights.ts) → `"unknown"` when
  undefined (no income yet — deliberately not "bad"), `"good"` at ≥20%, `"medium"` at 0–19%,
  `"bad"` below 0%. `income`/`expense` themselves come from `trend`'s entry matching
  `currentPeriod` (found by `periodKey`, not assumed to be `trend[trend.length - 1]`) — `getComparison`'s
  own totals are expense-only, so trend is the only source for income here. Throws if no matching
  entry exists (same "fail loud on a caller invariant violation" precedent as
  `spending-summary.ts`'s recurring-expense lookback check) rather than silently reporting `income: 0`.
- **topCategory**: `comparison.categories[0]` — re-verified `getComparison`'s sort (descending by
  `currentAmount`) still holds by reading it, not assumed.
- **Insight** (rule 3): the highest-`multiple` unusual transaction if any exist (defensively
  picked via `Math.max`-style reduce rather than trusting `unusualTransactions[0]`'s documented
  sort order blindly), else the category with the largest *absolute* toman increase
  (`currentAmount - previousAmount > 0`), else omitted. generate-highlights.ts's own
  amount-over-percent constant (`WARNING_ABSOLUTE_INCREASE_SHARE`) is private and this phase's
  scope forbids modifying that file to export it — judged, and documented in code, that it
  wouldn't quite fit here anyway (it exists to gate "is this warning-worthy", not to pick a single
  top observation), so the fallback's only bar is "increase > 0", no imported or duplicated
  threshold.
- **Projection** (rule 4): elapsed-time-based linear extrapolation
  (`projectedTotal = currentAmountSoFar / elapsedFraction`, via `periodToGregorianRange` +
  injectable `now`), targeting the insight's category if one exists, else `topCategory`, else the
  period's total expense (`TOTAL_EXPENSE_LABEL`) — one `resolveTarget` helper shared with the
  suggestion below so both always talk about the same thing. Omitted below
  `MIN_ELAPSED_FRACTION_FOR_PROJECTION` (10%, named/documented — a projection off less than that
  explodes to a meaningless number), when the target has no previous-period baseline to call
  "usual" (`previousAmount <= 0`), or when the projection doesn't actually exceed that baseline —
  simply omitted rather than reframed as good news, a documented judgment call per the task's own
  "your call, but be consistent" allowance.
- **Suggestion** (rule 5): cap = the same target's previous-period `currentAmount`, independent of
  whether the projection itself was gated out by the elapsed-fraction floor (a suggested cap is
  still useful at the very start of a period) — omitted only when that baseline is `<= 0`.
- **Opportunity** (rule 6): `OPPORTUNITY_REDUCTION_PERCENT` (10, named/documented the same way
  `UNUSUAL_TRANSACTION_MULTIPLIER` is in spending-summary.ts) of current-period discretionary
  (`isEssential: false`) spend, omitted when that total is 0.

Every message field is a fully-formed Persian string (matching `Highlight.message`'s own
convention), with the raw numbers alongside it so `NarrativeReportCard` never re-parses text.

### 2. `components/reports/NarrativeReportCard.tsx` (new)

One card, `rounded-2xl border-border bg-surface p-4`-adjacent, reusing `HighlightCard`'s
tone-color mapping approach (`TONE`/`STATUS_TONE`) rather than inventing a new one — `"unknown"`
gets its own neutral (`border-border bg-border/10`, muted text) entry, distinct from `"good"`/
`"medium"`/`"bad"`'s success/warning tones, so a no-income period reads as "not enough data", never
as a red judgment. Each present field (`topCategory`, `insight`, `projection`, `suggestion`,
`opportunity`) renders as its own block; an omitted field renders nothing, never a placeholder.

### 3. Wiring

`MonthlyComparisonReportProps` gained `narrative: NarrativeReport`; `NarrativeReportCard` renders
first, above `PeriodTrendChart`, per the task's placement instruction. `app/app/reports/page.tsx`'s
week/month/year branch calls `generateNarrativeReport` right after `generateHighlights`, passing
the same `comparison`/`trend`/`unusualTransactions` already fetched in that branch's `Promise.all`,
plus `granularity`/`currentPeriod`, and threads the result through unchanged.

### Testing

New `lib/reports/narrative-report.test.ts`, mirroring `generate-highlights.test.ts`'s
pure-function/no-DB convention (`category()`/`result()` builders, plus new `trendPeriod()`/
`unusual()` ones) — confirmed no DB fixture is needed, since every input is hand-built. Covers
every status tier (including the exact 0% boundary), income/expense sourced from the matching
trend entry (not comparison's expense-only totals), the trend-mismatch throw, `topCategory`
present/absent, the unusual-transaction-vs-absolute-increase insight priority (including
"amount over percent" winning against a much larger percent-change category), the insight omission
cases (no increase / no categories), the elapsed-fraction floor (both too-early and normal cases,
via an injected `now` computed from `periodToGregorianRange`), projection omission when it doesn't
exceed baseline and when there's no baseline, the total-expense projection fallback, the
suggestion's independence from the projection's elapsed-fraction gate, and both opportunity cases
(present and zero-discretionary omission). 26 tests, all passing.

- `npm run test`: **75/75 files, 862/862 tests passing** — this session's own starting point
  (Phase 2's end state, verified by re-running before touching anything) was 74/74, 836/836; this
  phase's net addition is +1 file / +26 tests, all in the new `narrative-report.test.ts`.
- `npx tsc --noEmit`: unchanged — same 8 pre-existing `TS2737` BigInt-literal errors in
  `app/api/assets/route.test.ts`/`lib/prices/get-live-prices.test.ts`, neither file touched.
- `npm run lint`: unchanged — same 3 pre-existing warnings (`components/logo.tsx`'s `<img>`,
  `lib/data/transactions.test.ts`'s unused `categoryId`, the workflow route's unused
  eslint-disable directive).

### Scope held

Touched: `lib/reports/narrative-report.ts` (new), `lib/reports/narrative-report.test.ts` (new),
`components/reports/NarrativeReportCard.tsx` (new), `components/reports/MonthlyComparisonReport.tsx`
(prop + render wiring only), `app/app/reports/page.tsx` (calls the new function, passes its result
down). No changes to `lib/reports/trend-insights.ts`, `lib/reports/monthly-comparison.ts`,
`lib/analytics/spending-summary.ts`, or `lib/reports/generate-highlights.ts` — each was read for
context/reuse (per the task's own pointers) but not modified. No new npm dependency. No schema
migration. No AI/LLM call anywhere in this feature.

### Do Not Claim

Two judgment calls were made under the task's own "if ambiguous, your call — but document it"
allowance, not confirmed with the project owner: (1) not reusing `generate-highlights.ts`'s private
`WARNING_ABSOLUTE_INCREASE_SHARE` for the rule-3b insight fallback's qualifying bar (reasoned
through above — the semantics didn't quite fit, and the file couldn't be modified to export it
either way); (2) omitting the projection outright (rather than phrasing it positively) when it
doesn't exceed the previous-period baseline. Both are internally consistent and documented in code,
but neither was put to the project owner directly the way the status-tier/insight-priority/
projection-target/suggestion-baseline/opportunity-percent rules already were.

## Financial Goals — Goals UI (Phase 3) — 2026-09-05 (retroactive entry)

**Retroactive documentation only** — this entry records a phase that was already fully built and
live in the working tree (`components/goals/goals-manager.tsx`, `app/app/dashboard/page.tsx`'s
"هدف‌ها" tab) before this session started; no code in this phase was written or changed as part of
adding this entry. It's added now because the roadmap had no record of it at all despite Phase 1
(the CRUD API + deterministic feasibility engine, `lib/data/goals.ts`/`lib/goals/feasibility.ts`)
and this UI both being fully implemented, so the roadmap was silently out of sync with the
codebase — verified by actually reading the component and page code (not assumed from the task
description) before writing this summary.

### What's live

`GoalsManager` (`components/goals/goals-manager.tsx`), rendered from `/app/dashboard?tab=goals`
(one of three tabs alongside transactions/assets on the consolidated dashboard page) - consumes
Phase 1's already-live `GET/POST/PATCH/DELETE /api/goals` (`lib/data/goals.ts`) unmodified:

- **List**: each goal as a card - name, target amount, days remaining, a progress bar
  (`initialAmount / targetAmount`), and its computed `GoalFeasibility` rendered as a status badge
  (`FEASIBILITY_TONE`: "در مسیر" / "نیاز به تعدیل" / "غیرواقعی", reusing this app's existing
  success/warning tone colors - no third real color exists, so the latter two share a tone and are
  told apart by icon/label only, same precedent as `NarrativeReportCard`'s "medium"/"bad" pair),
  estimated months to completion, and monthly shortfall (`gap`) when positive.
- **Create/edit**: a bottom-sheet modal (same shape as `AssetsManager`'s own) with a name field, two
  Toman `MoneyInput`s (target amount, optional current saved amount), and a `JalaliDatePicker` for
  the deadline (min: tomorrow, matching the API's own "past/today rejected" rule enforced
  client-side too). The category picker that originally sat in this form was later removed once the
  product decision landed that the goal's free-text name is enough on its own - new goals still send
  `category: "other"` to satisfy the API's existing required field, edits omit it entirely since
  `PATCH` never reads it.
- **Status/delete**: "محقق شد"/"رها شد" buttons (active goals only) PATCH `status`; delete uses an
  inline confirm/cancel toggle (modeled on `transaction-list-item.tsx`'s own per-row pattern, not
  `AssetsManager`/`AccountsManager`'s immediate-delete-no-confirmation, since this task wanted a
  confirmation step).

### Verification

No new tests were added or needed for this entry (documentation only) - the existing suite already
covers Phase 1's API layer (`app/api/goals/route.test.ts`, `app/api/goals/[id]/route.test.ts`:
validation, ownership scoping, feasibility attachment) and `GoalsManager` itself has no test file,
consistent with this codebase's established "no tests for presentational components" precedent
(`AssetsManager`, `MonthlyComparisonReport`, etc. have none either).

### Do Not Claim

This entry does not claim any new functional work happened in this phase - it is a documentation
correction only, describing code that already existed. The exact wording/order of the retired
category-picker removal (mentioned above) was reconstructed from the component's own code comments,
not from a separate change log entry, since none existed.

## Financial Goals — AI-Generated Strategy (Phase 2) — 2026-09-05

Adds the one piece Phase 1 (feasibility engine + CRUD, live) and Phase 3 (Goals UI, see the
retroactive entry above) didn't cover: for a given goal, a real NVIDIA NIM call (via
`lib/nvidia-ai.ts`'s existing `chatCompletion`, no new AI client) that generates 3-5 concrete,
actionable Persian suggestions grounded in the user's real spending data.

### 1. Grounding data

`lib/goals/strategy.ts`'s `generateGoalStrategy(goal, feasibility, userId)` takes the goal's own
fields and an already-computed `GoalFeasibility` (`lib/goals/feasibility.ts`'s
`computeGoalFeasibility` - reused, not recomputed; the caller, the new API route, computes it the
same way `listGoalsWithFeasibility` does) as parameters, then itself calls `getSpendingSummary`
(`lib/analytics/spending-summary.ts`) once for `topDiscretionaryCategories` and `recurringExpenses`
- the *only* categories/merchants the prompt allows the model to name in a `reduce_expense` action.
`getSpendingSummary` computes considerably more than these two fields (total balance, recent
transactions, cash-flow trend, ...), but it's reused as-is rather than hand-rolling a narrower
query: this runs once per button press (not per chat message, its other caller's hot path), so the
extra cost is negligible, and reuse keeps this feature's numbers in lockstep with that file's own
isTransfer-exclusion/discretionary rules instead of risking a second, drifting copy of them. All of
this - goal, feasibility, discretionary categories, recurring expenses - is rendered into a
clean, labeled Persian text block (Toman amounts pre-formatted via `formatToman`,
the deadline via `formatJalaaliDate`, feasibility status via the same Persian labels
`goals-manager.tsx`'s own `FEASIBILITY_TONE` already shows the user) inside a
`buildSystemPrompt`, following `lib/ai/parse-transaction.ts`'s own prompt-construction pattern -
never as raw pasted JSON.

### 2. `lib/goals/strategy.ts` (new)

`chatCompletion([...], { json: true })`, same call shape as `parseTransactionWithAI`. The raw JSON
response is validated with the same rigor as that file's `isRawParsedTransaction`:
`isRawGoalStrategy` only gates on `actions` being an array (so a completely wrong-shaped response is
rejected up front); each element is then independently validated/sanitized by
`sanitizeGoalStrategyAction` - `type` must be one of the three allowed values, `title`/`description`
must be non-empty strings, or the *entire* action is dropped. `relatedAmount`, being additive and
non-essential, is handled differently: an invalid value (not a positive finite number) is dropped
on its own, keeping the rest of an otherwise-valid action - a deliberate, documented asymmetry
between "fields nothing downstream can safely default" (type/title/description) and "a UI nicety a
caller can render around" (relatedAmount). If fewer than `MIN_STRATEGY_ACTIONS` (3) survive, the
whole call throws rather than returning a degraded/thin strategy - same "fail loud" precedent as
`spending-summary.ts`'s own recurring-expense lookback-mismatch throw. Every surviving action's
`priority` is reassigned sequentially (1..n, by array order) rather than trusting a number the model
separately supplies - the model's own array order already is its priority signal, and this
guarantees a clean, gap-free sequence regardless of what a possibly-hallucinated numeric field
said. `summary` is treated more leniently (a missing/empty one falls back to a generic Persian
sentence rather than discarding 3-5 otherwise-good actions over it) - a documented asymmetry from
the "throw below the minimum" rule, which only ever governs `actions`.

Every failure path (`chatCompletion` itself, JSON-extraction, shape validation) goes through
`reportError`/`ERROR_TYPES` exactly like `parseTransactionWithAI` (`AI_ERROR` for the call itself,
`PARSER_ERROR` for extraction/shape failures, an `AI-call succeeded` `logger.info` line with
latency+usage on success) and re-throws one single user-facing Persian message
("در تولید استراتژی خطایی رخ داد. دوباره تلاش کنید.") for every branch - a deliberate deviation from
`parseTransactionWithAI`'s own per-branch message wording (it re-throws the raw error unchanged for
an AI-call failure specifically), per this task's own explicit instruction to use one canonical
message here. No caching/persistence - generates fresh on every call, per this phase's own scope.

### 3. `app/api/goals/[id]/strategy/route.ts` (new)

`POST` only. Auth via `getSession`, then `checkRateLimit` against a new `GOAL_STRATEGY_USER_RULE`
(`lib/rate-limit.ts`: 10 per 10 minutes - modeled closer to `CHAT_USER_RULE`'s "deliberate user
action" cadence than the debounced `TRANSACTION_PARSE_USER_RULE`, sized to comfortably cover
regenerating a strategy across a few goals in one sitting while still bounding a runaway client to a
small number of NVIDIA NIM calls) before the ownership lookup, so a rate-limited client doesn't even
spend a DB round-trip. Ownership check via a new `getGoal(userId, id)` in `lib/data/goals.ts` - no
single-goal fetch existed before this (`listGoalsWithFeasibility` only ever returns the whole list);
added minimally, same `{ id, userId }` `findFirst` + `GoalNotFoundError`-on-miss contract as
`updateGoal`/`deleteGoal` right above it in that file. Feasibility is computed in the route (not
inside `generateGoalStrategy`) via `getActualMonthlyAverage` + `computeGoalFeasibility`, the same two
calls `listGoalsWithFeasibility` makes, just scoped to one goal. Returns `{ strategy }` on success;
404 for `GoalNotFoundError`, 429 via `rateLimitResponse` when rate-limited, 500 with
`generateGoalStrategy`'s own thrown Persian message on an AI/parsing failure (that function already
calls `reportError` internally for its own failures, so the route doesn't re-report the same event
under a second errorType).

### 4. UI — `components/goals/goals-manager.tsx`

A "دریافت استراتژی" button added to every active goal's card (relabeled "دریافت مجدد استراتژی" once
a strategy has already been fetched, so regenerating without a page refresh is one more click, not a
dead end) - `SpinnerIcon` while loading, same pattern as this file's existing save/delete buttons.
On success, the returned `GoalStrategy` renders inline: `summary` as a short intro line, then each
action as a small list item (an `ArrowDownIcon`/`ArrowUpIcon`/`PlusIcon` per `type`, `title`,
`description`, and `relatedAmount` via `formatToman` only when present), in `priority` order (the
array order the API already returns, since `priority` is assigned sequentially server-side). On
error, the Persian message renders with this file's existing warning-tone text pattern
(`deleteError`'s own styling). Local `GoalStrategy`/`GoalStrategyAction` types mirror
`lib/goals/strategy.ts`'s exported ones rather than importing them directly - that module is
`"server-only"` (it calls `chatCompletion`/`getSpendingSummary`), same reason this file's existing
`GoalFeasibility` is already a local copy, not an import from `lib/goals/feasibility.ts`.

### Testing

New `lib/goals/strategy.test.ts`, mirroring `lib/ai/parse-transaction.test.ts`'s `chatCompletion`
mocking convention exactly (`vi.mock("@/lib/nvidia-ai", ...)`), plus a same-shaped mock of
`getSpendingSummary` (`lib/analytics/spending-summary.ts`) so this stays a pure unit test with no DB
fixture. 9 tests: a fully valid response (priority reassignment, `relatedAmount` present/absent);
capping at 5 actions when the model returns more; one malformed action dropped with ≥3 surviving
(accepted); too few valid actions surviving (throws the Persian message); an invalid `relatedAmount`
on one action being dropped while the rest of that action survives; a missing `summary` falling back
to the default sentence; a non-JSON response; a well-formed-but-wrong-shaped response (`actions`
missing entirely); and the `chatCompletion` call itself rejecting.

- `npm run test`: **83/83 files, 920/920 tests passing** - this session's own starting point
  (already 82/911 in the working tree before this phase, from prior uncommitted Goals/Dashboard/
  Reports work) plus this phase's net addition of +1 file / +9 tests, all in the new
  `strategy.test.ts`. No existing test file needed a change.
- `npx tsc --noEmit`: unchanged - the same 8 pre-existing `TS2737` BigInt-literal errors in
  `app/api/assets/route.test.ts`/`lib/prices/get-live-prices.test.ts`, neither file touched.
- `npm run lint`: unchanged - the same 3 pre-existing warnings (`components/logo.tsx`'s `<img>`,
  `lib/data/transactions.test.ts`'s unused `categoryId`, the workflow route's unused
  eslint-disable directive).

### Scope held

Touched: `lib/goals/strategy.ts` (new), `lib/goals/strategy.test.ts` (new),
`app/api/goals/[id]/strategy/route.ts` (new), `lib/rate-limit.ts` (one new named rule, additive),
`lib/data/goals.ts` (one new `getGoal` export, additive), `components/goals/goals-manager.tsx` (new
button + inline strategy render only). No changes to `lib/goals/feasibility.ts`,
`lib/analytics/spending-summary.ts`, `prisma/schema.prisma`, or any other `app/api/goals/*` route's
existing behavior - each was read for reuse but not modified. No new npm dependency. No schema
migration.

### Do Not Claim

The exact rate-limit figure (10 per 10 minutes) and the UI's exact grouping/regenerate-button
wording were this session's own judgment calls under the task's explicit "stop and ask if it feels
like a product call, otherwise use your judgment" allowance for the rate-limit number specifically -
not confirmed with the project owner. The choice to always show the strategy button (relabeled
"دریافت مجدد استراتژی" post-fetch) rather than hiding it once a strategy exists was also this
session's own call, reasoned through above but not put to the project owner directly.

## Phase 20: Light/Dark/System Theme Toggle

Added a `jib-theme` cookie ('system' | 'light' | 'dark', default 'system') as the only persistence
mechanism - a device preference, so deliberately no `User` column/migration and no new npm
dependency (no next-themes). `app/globals.css` gained a `[data-theme="light"]` override block
next to the existing (now implicitly dark) `:root` variables. `app/layout.tsx` reads the cookie
server-side for an explicit light/dark choice and additionally carries a blocking inline `<head>`
script (must stay inline/non-deferred - resolves 'system'/missing-cookie via `matchMedia` before
first paint, to avoid a flash of the wrong theme). New `components/settings/theme-toggle.tsx`
(3-segment client pill) and a new "ظاهر برنامه" section in `app/app/settings/page.tsx`, styled
after the existing `AssetDisplayToggle` section.

Audited every hardcoded-color hit this phase's own grep turned up (13 component files) against the
new light theme by hand in-browser - all confirmed fine as-is: the black-gradient hero cards
(`balance-card.tsx`, `assets-hero-card.tsx`) and the landing-page phone mockup are an intentional
always-dark accent design, not theme bugs; `text-white` on `bg-warning`/`bg-success` buttons and on
arbitrary user-chosen category-color swatches keeps sufficient contrast in both themes. No further
component changes made.

- `npm run test`: no regressions (this phase touched no test-covered logic).
- `git diff package.json`: empty - no new dependency.

## Phase 20b: Fixed migration-ordering bug in `20260822213426_add_user_role_check_constraint`

Separate, unrelated fix surfaced by Phase 20's own baseline test run: that migration's
`migration.sql` had `showBalanceInAssets` added to its `CREATE TABLE`/`INSERT`/`SELECT` (via
some other uncommitted work on the branch), a column that migration predates - it's only genuinely
introduced three migrations later, in `20260825171540_add_assets`. Replayed in timestamp order (as
`global-setup.ts` does for the ephemeral test DB), the premature `SELECT "showBalanceInAssets" ...
FROM "User"` failed outright ("no such column"), aborting the entire suite at 0/965 before this fix.

Fix: removed `showBalanceInAssets` from all three places in that one file, restoring it to its
committed (`f079e04`) state - confirmed via `git diff` against HEAD being empty afterward. Nothing
else touched; `20260825171540_add_assets` (which still introduces the column correctly, via its own
`DEFAULT false`) was left as-is. Neither migration has been applied to the live Turso DB.

- `npm run test`: **86/86 files, 1004/1004 tests passing** - new baseline (supersedes the previous
  85/86, 960/965-with-5-known-failures figure; those 5 `suggested-category` route failures are gone
  too, apparently resolved by other uncommitted work on this branch, not by this fix).
- `npm run lint`: unchanged - same 3 pre-existing warnings as prior phases.

## Internal Account Transfers — Schema + Default Categories (Phase A1) — 2026-09-11

Schema-only groundwork for internal account-to-account transfers, the first phase of the savings
roadmap. No API, no UI, no live-DB write - all four deliverables below stop at "generated and
reviewed locally."

**`Transaction.transferGroupId String?`** (`prisma/schema.prisma`) - links the two rows (one
expense, one income) that make up a single internal transfer; null for every existing/regular
transaction. Doc comment follows the `idempotencyKey`/`enrichmentStatus` style already in the file.
Added `@@index([transferGroupId])` alongside it, same pattern as this model's other indexes.

**Two new `DefaultCategory` rows** (`prisma/default-categories.ts`), both named "انتقال بین
حساب‌ها", `isTransfer: true`, `isEssential: true` (matches `پس‌انداز و سرمایه‌گذاری`'s reasoning -
not real spending/income, must never be surfaced as reducible/discretionary). Icon `🔁` (distinct
from `🔄`, already used for `اشتراک نرم‌افزار و سرویس`, to avoid conflating "recurring subscription"
with "account transfer"); color `#94A3B8` for the expense side (neutral/utility, matching `سایر
هزینه‌ها`'s "not really a spending category" gray rather than any of the varied per-category
expense colors) and `#10B981` for the income side (every existing income top-level category shares
this exact green - confirmed by inspection, not assumed). `DefaultCategorySeed`'s `isTransfer?:
boolean` field added to support this (optional/omitted for every pre-existing entry, same harmless
default as the schema column). `prisma/seed.ts`'s upsert updated to actually pass `isTransfer`
through (it previously only carried `icon`/`color`/`isEssential` - the field would otherwise never
reach `DefaultCategory` even after this data change).

**Discrepancy found in the task's own premise, reported per its own instruction rather than forced:**
the task described the Persian naming convention as "reusing a shared name across the income/expense
pair, per existing pairs like `سایر هزینه‌ها`/`سایر درآمدها`" - checked, and that's not accurate:
those two names actually differ (هزینه‌ها vs درآمدها), and no existing pair among all 82 current
category names anywhere in `DEFAULT_CATEGORIES` reuses an identical string across both types. Used
the identical name for both new rows anyway, since the task specified it explicitly and the schema
supports it cleanly (`@@unique([name, type])` is keyed on the pair, not name alone) - just flagging
that this specific pairing has no actual precedent in the current data, unlike the rest of the
approach.

**Migration** - generated fully offline via `migrate diff` per `AGENTS.md`'s process (no DB
connection attempted or needed); saved as
`prisma/migrations/20260911104341_add_transaction_transfer_group_id/migration.sql`:
```sql
-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "transferGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_transferGroupId_idx" ON "Transaction"("transferGroupId");
```
One subtlety worth recording: this schema had already picked up staged-but-uncommitted changes
from other work on this branch (the `suggestedCategory*` fields) before this session started, so
diffing against `git show HEAD:prisma/schema.prisma` would have bundled that
unrelated, already-in-progress change into this migration's SQL. Diffed against `git show
:prisma/schema.prisma` (the index/staged version) instead - confirmed via `diff` that this produces
exactly and only the `transferGroupId` addition, nothing else. **Not applied to the live Turso DB or
any local/test DB** - `npx prisma generate` was run (schema-only, no DB connection) to refresh the
generated client so the rest of the codebase type-checks against the new field, but no migration
was executed anywhere.

**Backfill script** (`prisma/backfill-transfer-categories.ts`, written, not run) - inserts the two
new categories into every existing user's own `Category` rows (not `DefaultCategory`, which is the
global template). No existing script does exactly this shape: `prisma/backfill-categories.ts` only
touches users with zero `Category` rows, `prisma/refresh-user-categories.ts` wipes and reseeds a
user's *entire* tree, and `prisma/backfill-category-essentiality.ts` only updates fields on rows a
user already has - none of them "insert specific new rows into an otherwise-untouched, already-
populated tree." Followed the closest precedent's shape anyway (dry-run-by-default / `--execute` to
write, same `@/lib/prisma` Prisma Client connection pattern as its siblings, per-user row counts
logged, matches on `Category`'s own `@@unique([userId, name, type])` before inserting so a re-run
only ever inserts what's still missing). Requires the two `DefaultCategory` rows to exist
first (aborts loudly, zero writes, if either is missing) rather than hardcoding icon/color/
isEssential values that could drift from whatever actually got seeded.

**Scope held:** only `prisma/schema.prisma`, `prisma/default-categories.ts`, `prisma/seed.ts` (the
one `isTransfer` passthrough fix), the new migration folder, and the new backfill script were
touched. No API route, component, or goals/feasibility code touched - those are separate follow-up
prompts per the task's own instruction. No new npm dependency. No live-DB read or write of any
kind, migration or otherwise.

- `npm run test`: **86/86 files, 1004/1004 tests passing** - unchanged from the pre-existing
  baseline recorded just above; this phase's changes are additive-only and touched no test-covered
  runtime logic.
- `npx tsc --noEmit`: same pre-existing 8 `BigInt literal` target errors in two files this session
  never touched (`app/api/assets/route.test.ts`, `lib/prices/get-live-prices.test.ts`) - no new
  errors from this phase's changes.

