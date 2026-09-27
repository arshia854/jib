# Jib Security Audit Report

**Date:** 2026-08-06
**Auditor mode:** Read-only comprehensive security, performance & code-quality audit

## Repository Summary

Jib ("جیب") is a Persian RTL personal-finance PWA built on Next.js 16.2.12 (App Router, `proxy.ts` convention, React 19.2), TypeScript, Prisma ORM 7 with `@prisma/adapter-libsql` against a Turso (libSQL) database, Tailwind CSS v4, and NVIDIA NIM (OpenAI-compatible) for AI transaction parsing and a financial chat assistant. Auth is Auth.js/NextAuth v5 (beta) with three providers: phone/OTP (custom `Credentials` provider backed by signed JWT cookies), email+password (`bcryptjs`), and Google OAuth. Deployment target is a self-managed VPS behind a reverse proxy (per code comments in `auth.ts`), not Vercel, despite Vercel being mentioned in project context.

Audit scope covered `app/`, `components/`, `lib/`, `auth.ts`, `proxy.ts`, `prisma/`, `public/`, config files, and all Route Handlers / Server data-access functions. No fixes, refactors, or file modifications were made other than this report. The project's `vitest run` was executed read-only to observe current test health (see Testing section) — this is the only command run beyond static inspection, and it writes rows to whatever database is configured in `.env` (see Testing finding T-1); no source files were changed.

---

# Executive Summary

| ID | Category | Risk | Confidence | Short Summary |
|----|----------|------|------------|----------------|
| SEC-1 | API & HTTP Security | 🟠 High | 95% | No security headers configured anywhere (no CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) |
| SEC-2 | Financial App Risks / Encryption at rest | 🟠 High | 85% | Service worker caches full authenticated page HTML (financial data) and is never cleared on logout |
| SEC-3 | Rate Limiting / Auth | 🟠 High | 80% | All IP-based rate limits (OTP, email login, general API) key off a client-spoofable `X-Forwarded-For` header |
| SEC-4 | Dependency Security | 🟡 Medium | 90% | `next-auth` is a pre-1.0 beta (`5.0.0-beta.32`) protecting a financial app's auth |
| SEC-5 | Rate Limiting / Scalability | 🟡 Medium | 95% | Rate limiter is in-process memory only — not shared across instances/restarts |
| SEC-6 | LLM Cost & Abuse Control | 🟡 Medium | 85% | No `max_tokens`/output cap on NVIDIA NIM chat/parse calls |
| SEC-7 | Secrets / OTP delivery | 🟡 Medium | 75% | OTP silently falls back to logging the plaintext code to console if SMS credentials are unset |
| SEC-8 | Authentication | 🟡 Medium | 70% | Single `AUTH_SECRET` reused to sign OTP tokens, legacy sessions, and NextAuth sessions |
| SEC-9 | Authentication | 🟡 Medium | 60% | `trustHost: true` trusts the incoming Host header; safety depends on reverse-proxy config not present in this repo |
| SEC-10 | Financial App Risks / Concurrency | 🟡 Medium | 75% | No server-side idempotency protection on transaction creation (double-submit/retry risk) |
| T-1 | Testing | 🟡 Medium | 95% | Test suite runs against the live configured database, not an isolated test DB; observed 1 failing + 1 timed-out suite at HEAD |
| T-2 | Testing / Deployment | 🟡 Medium | 95% | No CI pipeline (`.github/workflows` absent) — lint/typecheck/tests are not enforced automatically |
| CQ-1 | Code Quality | 🟢 Low | 90% | README documents a stale stack (OpenRouter, better-sqlite3) that no longer matches the implementation (NVIDIA NIM, Turso) |
| OBS-1 | Observability | 🟢 Low | 85% | No `instrumentation.ts` / APM / tracing hook |
| SEC-11 | Security Headers | 🟢 Low | 80% | `X-Powered-By: Next.js` header not disabled |
| SEC-12 | Session Management | 🟢 Low | 70% | 90-day session lifetime with no step-up re-auth for sensitive admin actions |
| IV-1 | Input Validation | 🟢 Low | 70% | No schema-validation library (e.g. Zod); validation is ad-hoc and hand-rolled per route |
| DR-1 | Deployment Readiness | 🟢 Low | 60% | No Dockerfile/process-manager config despite code comments describing a self-managed VPS deployment |

---

# Detailed Findings

## 1. Authentication & Session Management

**Finding SEC-8 — Shared secret across OTP tokens and full sessions**
- **Status:** Confirmed Issue
- **Evidence:** `getSecretKey()`/`getLegacySecretKey()` and NextAuth's `secret` all read `process.env.AUTH_SECRET`, the same single value.
- **File(s):** [lib/auth/otp.ts:8-14](lib/auth/otp.ts#L8-L14), [lib/auth/session.ts:27-31](lib/auth/session.ts#L27-L31), [auth.ts:34](auth.ts#L34)
- **Risk Level:** 🟡 Medium | **Confidence:** 70%
- **Why it matters:** A single compromised secret can forge both short-lived OTP verification tokens and long-lived (90-day) full-session JWTs. Purpose-scoped secrets limit blast radius if one signing context is ever leaked (e.g. via a log, error report, or a lower-security code path).
- **Practical impact:** Low likelihood but high severity if `AUTH_SECRET` ever leaks — full account takeover for any user, not just OTP replay.
- **Recommended fix:** Derive distinct HKDF sub-keys from `AUTH_SECRET` per purpose (OTP, legacy session, NextAuth already manages its own internally) or set a separate `OTP_SECRET`.
- **Estimated implementation effort:** Small (<1hr)

**Finding SEC-9 — `trustHost: true` with no verifiable reverse-proxy hardening in-repo**
- **Status:** Possible Issue
- **Evidence:** `trustHost: true` is set with a comment explaining the app runs behind a self-managed VPS reverse proxy rather than a platform like Vercel that sets trusted forwarded headers by default.
- **File(s):** [auth.ts:35-38](auth.ts#L35-L38)
- **Risk Level:** 🟡 Medium | **Confidence:** 60%
- **Why it matters:** Auth.js uses the request's `Host`/`X-Forwarded-Host` to build callback and redirect URLs when `trustHost` is enabled. If the upstream reverse proxy (nginx/Caddy/etc., not present in this repository) does not pin/override the `Host` header to the app's real domain, a client-supplied `Host` header could influence OAuth callback URL construction.
- **Practical impact:** Depends entirely on infrastructure outside this repo; cannot be confirmed or ruled out from the codebase alone.
- **Recommended fix:** Confirm the reverse proxy config hard-sets `Host`/`X-Forwarded-Host` to the canonical domain (e.g. `proxy_set_header Host jib.example.com;` in nginx) rather than passing through the client's value.
- **Estimated implementation effort:** Small (<1hr, infra change outside this repo)

**Finding SEC-12 — Long-lived sessions without step-up re-auth**
- **Status:** Possible Issue
- **Evidence:** `session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 90 }` — 90 days.
- **File(s):** [auth.ts:33](auth.ts#L33)
- **Risk Level:** 🟢 Low | **Confidence:** 70%
- **Why it matters:** For a financial app, a 90-day session with no re-authentication requirement for sensitive actions (e.g. deleting an account, viewing full transaction history) widens the window in which a stolen device/cookie remains useful to an attacker.
- **Practical impact:** Increases impact of session-cookie theft (XSS, device theft, shared-device scenarios).
- **Recommended fix:** Consider a shorter absolute `maxAge` with rolling refresh, or a step-up confirmation (password/OTP re-entry) before destructive actions.
- **Estimated implementation effort:** Medium (a few hours)

**Positive:** OTP design is solid — 6-digit code, 120s TTL, 5-attempt cap enforced inside a signed JWT cookie (not client-trusted counters), plus independent per-phone/per-IP rate limits (`lib/auth/otp.ts`, `lib/rate-limit.ts:86-93`, `auth.ts:59-77`). Password hashing uses bcrypt with cost factor 12 ([lib/auth/password.ts:3](lib/auth/password.ts#L3)). Blocked/deleted users are centrally rejected in `getSession()` ([lib/auth/session.ts:83-106](lib/auth/session.ts#L83-L106)) so every session consumer sees the same state without re-implementing the check.

## 2. Authorization & Access Control

**Positive (no confirmed findings):** Every data-layer mutation/read for user-owned resources (`lib/data/transactions.ts`, `lib/data/accounts.ts`, `lib/data/categories.ts`) scopes its Prisma query by `{ id, userId }` before acting, so cross-user IDOR was not found in transactions, accounts, categories, or merchant mappings — e.g. `deleteTransaction`, `updateAccount`, `deleteCategory` all `findFirst({ where: { id, userId } })` before mutating ([lib/data/transactions.ts:31-37](lib/data/transactions.ts#L31-L37), [lib/data/accounts.ts:40-64](lib/data/accounts.ts#L40-L64), [lib/data/categories.ts:50-74](lib/data/categories.ts#L50-L74)). Admin authorization is defense-in-depth: `proxy.ts` gates `/api/admin/*` and `/app/admin*` at the edge ([proxy.ts:18-26,60-71](proxy.ts#L18-L26)), and every admin data function independently calls `requireAdminSession()` ([lib/data/admin-users.ts](lib/data/admin-users.ts), [lib/data/admin-categories.ts](lib/data/admin-categories.ts), [lib/data/admin-logs.ts](lib/data/admin-logs.ts), [lib/data/admin-stats.ts](lib/data/admin-stats.ts)), matching the Next.js data-security guidance that Proxy alone must not be the only authorization layer. Self-lockout is guarded (`CannotModifySelfError` in [lib/data/admin-users.ts:120-126](lib/data/admin-users.ts#L120-L126)).

## 3. Input Validation

**Finding IV-1 — No schema-validation library**
- **Status:** Possible Issue (style/consistency, not a concrete vulnerability)
- **Evidence:** Every Route Handler hand-validates `await request.json().catch(() => null)` output field-by-field with manual `typeof`/regex checks (e.g. [app/api/transactions/route.ts:34-53](app/api/transactions/route.ts#L34-L53), [app/api/accounts/route.ts:22-34](app/api/accounts/route.ts#L22-L34), [app/api/categories/route.ts:66-107](app/api/categories/route.ts#L66-L107)). No `zod`/`yup` dependency is present in `package.json`.
- **File(s):** all files under `app/api/**/route.ts`
- **Risk Level:** 🟢 Low | **Confidence:** 70%
- **Why it matters:** The manual checks observed are actually reasonably thorough and type-safe, but the pattern is easy to get subtly wrong at scale (e.g. a forgotten bound check) and harder to keep consistent than a shared schema. Next.js's own authentication guide recommends a schema library for this reason.
- **Practical impact:** No exploitable gap was found in the current handlers, but this raises the cost of introducing one in future changes.
- **Recommended fix:** Introduce `zod` schemas per route incrementally, starting with the money-handling endpoints (transactions, accounts).
- **Estimated implementation effort:** Large (touches every route handler; can be phased)

**Positive:** Amount fields are consistently validated as finite numbers, rounded, and bounded (`amount > 0`) before persistence ([app/api/transactions/route.ts:44-53](app/api/transactions/route.ts#L44-L53)); category/account IDs are validated as integers and re-resolved against the authenticated user's own rows rather than trusted directly, closing off type-confusion/IDOR via forged IDs. No SQL injection surface exists — no `$queryRaw`/`$executeRaw` usage was found anywhere in the codebase (`grep` returned no matches), all persistence goes through Prisma's parameterized query builder.

## 4. CSRF & Request Forgery Protection

**Status:** ✅ OK (Low residual risk, informational only)
- **Evidence:** Custom `Credentials` sign-in and all mutating Route Handlers rely on `sameSite: "lax"` cookies (OTP cookie: [app/api/auth/send-otp/route.ts:38-44](app/api/auth/send-otp/route.ts#L38-L44); NextAuth's own session cookie defaults). No explicit CORS headers are set anywhere, so the default same-origin policy applies to `fetch` responses.
- **Risk Level:** 🟢 Low | **Confidence:** 80%
- **Why it matters:** `SameSite=Lax` already blocks the cookie from being attached to cross-site `POST`/`PATCH`/`DELETE` requests in all modern browsers, which covers the realistic CSRF vector for these JSON APIs. Unlike Server Actions, however, plain Route Handlers under `app/api/**` do **not** get Next.js's automatic Origin/Host header comparison — that protection is specific to `"use server"` actions, not `route.ts` handlers.
- **Practical impact:** Negligible today given `SameSite=Lax`, but there is no explicit Origin-header check as a second layer, and behavior depends on every current and future client remaining a standards-compliant browser.
- **Recommended fix:** Optional defense-in-depth: add an `Origin`/`Host` header comparison in `proxy.ts` for `/api/*` mutating methods, mirroring what Server Actions get automatically.
- **Estimated implementation effort:** Small (<1hr)

## 5. API & HTTP Security

**Finding SEC-1 — No security headers configured**
- **Status:** Confirmed Issue
- **Evidence:** `next.config.ts`'s only `headers()` entry targets `/sw.js` (`Content-Type`, `Cache-Control`); no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` is set anywhere. `proxy.ts` (the app's only other request-interception point) sets no response headers at all — it only redirects or rate-limits.
- **File(s):** [next.config.ts:1-17](next.config.ts#L1-L17), [proxy.ts:1-91](proxy.ts#L1-L91)
- **Risk Level:** 🟠 High | **Confidence:** 95%
- **Why it matters:** This is a financial application handling phone numbers, transaction history, and account balances. Without `X-Frame-Options`/`frame-ancestors`, the app is clickjackable. Without CSP, any future XSS (even a small one, e.g. through a dependency) has no second layer of defense. Without HSTS, users are vulnerable to protocol downgrade on first visit or misconfigured links.
- **Practical impact:** No specific exploit is demonstrated (no XSS was found in this audit), but the absence removes a standard defense-in-depth layer that costs little to add and is explicitly called out in Next.js's own security guidance for App Router projects.
- **Recommended fix:** Add a `headers()` block in `next.config.ts` (or via `proxy.ts` if nonces are desired) setting at minimum `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security`, and a baseline CSP.
- **Estimated implementation effort:** Medium (a few hours to tune CSP against actual asset origins)

**Finding SEC-11 — `X-Powered-By` header not disabled**
- **Status:** Confirmed Issue
- **Evidence:** No `poweredByHeader: false` in `next.config.ts`, so Next.js's default `X-Powered-By: Next.js` response header remains enabled.
- **File(s):** [next.config.ts:1-17](next.config.ts#L1-L17)
- **Risk Level:** 🟢 Low | **Confidence:** 80%
- **Why it matters:** Minor information disclosure (framework fingerprinting) that costs nothing to remove.
- **Practical impact:** Negligible on its own; slightly eases automated recon.
- **Recommended fix:** Add `poweredByHeader: false` to `next.config.ts`.
- **Estimated implementation effort:** Small (<1hr)

**Finding SEC-3 — Rate limits keyed off a spoofable client IP**
- **Status:** Confirmed Issue (mechanism), Possible Issue (real-world exploitability depends on infra)
- **Evidence:** `getClientIp()` takes the **first** comma-separated value of the incoming `X-Forwarded-For` request header (attacker-controlled unless a trusted proxy overwrites it) with no allow-list of trusted proxy hops, falling back to `X-Real-Ip`.
- **File(s):** [lib/rate-limit.ts:60-69](lib/rate-limit.ts#L60-L69), used by [proxy.ts:12-13](proxy.ts#L12-L13), [app/api/auth/send-otp/route.ts:16](app/api/auth/send-otp/route.ts#L16), [auth.ts:103-106](auth.ts#L103-L106)
- **Risk Level:** 🟠 High | **Confidence:** 80%
- **Why it matters:** `auth.ts:35-38` documents that this app runs behind a self-managed VPS reverse proxy, "not a platform like Vercel that sets trusted forwarded headers by default." If that reverse proxy simply forwards (rather than overwrites) the client's `X-Forwarded-For`, an attacker can set an arbitrary value per request, making every IP-keyed rate limit in the app trivially bypassable: OTP SMS request flooding (cost abuse against Melipayamak), OTP verify brute force, email/password login brute force, and the general per-IP API backstop.
- **Practical impact:** If the deployment's proxy is misconfigured (a common default state, especially on a hand-rolled VPS setup vs. a managed platform), all rate limiting in the app is defeated with a single spoofed header per request — undermining OTP cost controls and brute-force protections simultaneously.
- **Recommended fix:** Take the **last** `X-Forwarded-For` entry appended by your own trusted proxy (or better, have the proxy set a dedicated, proxy-only header like `X-Real-IP` that the app trusts exclusively), and verify the reverse proxy strips/overwrites any client-supplied `X-Forwarded-For` before appending its own.
- **Estimated implementation effort:** Small (<1hr code change; verifying/fixing the reverse proxy config is separate infra work)

**Positive:** No CORS headers are opened up anywhere, keeping the default same-origin restriction on all API responses. Streaming responses (chat SSE-to-text bridge) correctly set `Content-Type: text/plain; charset=utf-8` and don't leak internal SSE framing to the client ([app/api/chat/route.ts:83-85](app/api/chat/route.ts#L83-L85)).

## 6. Secrets Management

**Finding SEC-7 — OTP fallback logs plaintext codes to console**
- **Status:** Confirmed Issue (by design for dev; risk is if it silently persists into production)
- **Evidence:** `sendOtpSms()` checks `isMelipayamakConfigured()` and, if any of `MELIPAYAMAK_USERNAME`/`PASSWORD`/`BODY_ID` is unset, logs `[mock SMS] OTP for ${phone}: ${code}` to the server console and reports success.
- **File(s):** [lib/auth/otp.ts:48-61](lib/auth/otp.ts#L48-L61), [README.md:33-38](README.md#L33-L38)
- **Risk Level:** 🟡 Medium | **Confidence:** 75%
- **Why it matters:** This is intentional and documented for local dev, but the fail-open behavior means a production deployment that forgets to set (or loses) one of the three Melipayamak env vars silently degrades to writing real users' login codes in cleartext to server logs, with no error/alert — a serious issue if those logs are shipped to a third-party log aggregator or are otherwise accessible.
- **Practical impact:** Full OTP-based account takeover for any user who logs in during the misconfiguration window, discoverable only by someone with log access — the failure is silent to the app's own operators (returns `{ success: true }` to the caller).
- **Recommended fix:** Make the mock-SMS fallback explicitly gated on `NODE_ENV !== "production"` (or a dedicated `ALLOW_MOCK_SMS` flag) rather than solely on env-var absence, so a production misconfiguration fails loudly instead of silently degrading to console logging.
- **Estimated implementation effort:** Small (<1hr)

**Positive:** `.env`, `.env.local`, and `.env.save` are all correctly gitignored (`.gitignore:33-35`) and `git log`/`git ls-files` confirm none were ever committed — only `.env.example` (with placeholder values) is tracked. `dev.db` is also gitignored and untracked. `lib/prisma.ts`, `lib/nvidia-ai.ts`, and `lib/auth/otp.ts` all fail closed (`throw`) when required secrets are missing rather than falling back to an insecure default.

## 7. Dependency Security

**Finding SEC-4 — `next-auth` beta in production**
- **Status:** Confirmed Issue
- **Evidence:** `"next-auth": "^5.0.0-beta.32"` in `package.json`.
- **File(s):** [package.json:15](package.json#L15)
- **Risk Level:** 🟡 Medium | **Confidence:** 90%
- **Why it matters:** Auth.js v5 has been in beta for an extended period and is the sole gatekeeper for session issuance/validation across all three sign-in methods. Beta software can ship breaking changes or behavior regressions between patch releases without a major-version signal, and the security-review/hardening bar for a beta is inherently lower than a 1.0 release.
- **Practical impact:** Low immediate risk (the library is widely used in beta form and this audit found no NextAuth-specific vulnerability), but it's an ongoing supply-chain/stability risk for the single most security-critical dependency in the app.
- **Recommended fix:** Track Auth.js's v5 stable release and upgrade promptly when available; in the meantime pin the exact beta version (remove the `^`) so `npm install` can't silently pull in a new beta with behavioral changes.
- **Estimated implementation effort:** Small (<1hr to pin; migration effort if/when v5 stable ships)

**Reviewed, no concerns:** `bcryptjs@^3.0.3` (maintained, pure-JS bcrypt — acceptable for this workload), `jose@^6.2.4` (actively maintained JWT library, Edge/Node compatible), `jalaali-js@^2.0.0` (small, stable calendar-conversion utility), `@prisma/adapter-libsql@^7.9.1` / `prisma@^7.9.1` / `@libsql/client@^0.17.4` (current major versions), `react@19.2.4`/`react-dom@19.2.4` (matches the Next.js 16 App Router's required React 19.2 baseline). No direct dependency was found to be a known-abandoned or unmaintained package. A full transitive-tree CVE sweep (`npm audit`/OSV) was not performed per the read-only, no-external-lookups constraint of this audit — recommend running `npm audit` separately as a follow-up.

## 8. Database Security

**Status:** ✅ OK — no confirmed findings.
- All queries go through Prisma's query builder (`prisma.<model>.findFirst/findMany/create/update/delete/groupBy/aggregate/$transaction`); no `$queryRaw`/`$executeRaw` usage exists anywhere in `app/`, `components/`, `lib/`, or `prisma/`.
- Ownership-scoped indexes exist where they matter for both correctness and query performance: `Transaction` is indexed on `[userId, date]`, `type`, `categoryId`, `accountId`; `Category` and `FinanceAccount` are indexed/unique-constrained per user ([prisma/schema.prisma:83,105-107,128-131](prisma/schema.prisma#L128-L131)).
- Cascade/restrict rules are deliberate and documented: `Account`, `FinanceAccount`, `Category`, `ChatMessage`, `MerchantMapping` cascade on `User` delete; `Transaction.account`/`Transaction.category` use `onDelete: Restrict` to prevent orphaned financial records; `ErrorLog.user` uses `SetNull` so deleting a user doesn't erase unrelated operational history ([prisma/schema.prisma:119-181](prisma/schema.prisma#L119-L181)).
- Multi-statement writes that must be atomic use `prisma.$transaction` (e.g. `updateTransaction`'s paired update + merchant-mapping upsert: [lib/data/transactions.ts:80-104](lib/data/transactions.ts#L80-L104); onboarding seed: [lib/data/onboarding.ts:4-9,21-48](lib/data/onboarding.ts#L4-L9)).
- A single shared Prisma client instance is reused via the `globalThis` cache pattern, avoiding connection-pool exhaustion from repeated instantiation in dev/hot-reload ([lib/prisma.ts:17-25](lib/prisma.ts#L17-L25)).

## 9. Transactions & Concurrency

**Finding SEC-10 — No server-side idempotency on transaction creation**
- **Status:** Possible Issue
- **Evidence:** `POST /api/transactions` creates a new `Transaction` row unconditionally on every call with no client-supplied idempotency key or server-side dedup window; the only guard against a duplicate submit is the client disabling the confirm button while `stage === "saving"` ([components/transactions/add-transaction-form.tsx:135-165,581-585](components/transactions/add-transaction-form.tsx#L135-L165)).
- **File(s):** [app/api/transactions/route.ts:28-77](app/api/transactions/route.ts#L28-L77), [lib/data/transactions.ts:109-135](lib/data/transactions.ts#L109-L135)
- **Risk Level:** 🟡 Medium | **Confidence:** 75%
- **Why it matters:** For a finance app, a duplicated transaction directly corrupts the user's recorded balance/spending history. A slow network causing a client retry, a double-tap that races past the disabled-button window, or a multi-tab scenario can all produce two identical `Transaction` rows server-side with nothing to catch it.
- **Practical impact:** Silent data-integrity error (inflated spending/income totals) rather than a security compromise — but directly undermines user trust in a finance-tracking product.
- **Recommended fix:** Accept an optional client-generated idempotency key (e.g. UUID from `crypto.randomUUID()` generated once per submit attempt) and dedupe on `(userId, idempotencyKey)` server-side, or apply a short server-side debounce keyed on `(userId, amount, rawInput)` within a few seconds.
- **Estimated implementation effort:** Medium (a few hours — needs a schema/unique-index change)

**Positive:** Read-then-write ownership checks (`findFirst` then `update`/`delete` by primary key) are scoped to `userId` throughout, so even though there's a small TOCTOU window between the check and the write, it cannot be exploited cross-user — at worst a user races against their own concurrent requests, which is a low-severity, self-contained scenario.

## 10. Encryption

**Finding SEC-2 — Financial data persists in browser Cache Storage after logout**
- **Status:** Confirmed Issue
- **Evidence:** The service worker's `fetch` handler caches every same-origin `navigate`-mode response (i.e. full authenticated page loads, including `/app`, `/app/transactions`, `/app/reports`, etc.) into `PAGES_CACHE`, network-first with cache fallback. `LogoutButton` only calls `POST /api/auth/logout` and clears the auth cookie — nothing in the codebase calls `caches.delete()`/`caches.keys()` or unregisters the service worker.
- **File(s):** [public/sw.js:41-58](public/sw.js#L41-L58), [components/layout/logout-button.tsx:11-16](components/layout/logout-button.tsx#L11-L16)
- **Risk Level:** 🟠 High | **Confidence:** 85%
- **Why it matters:** After a user logs out on a shared/family device (a realistic scenario for this product), the previous session's dashboard, transaction list, and reports pages — containing real account balances and spending history — remain retrievable from the browser's Cache Storage (inspectable via DevTools, or servable offline) until the cache is evicted or overwritten by the next `CACHE_VERSION` bump.
- **Practical impact:** Local/physical access to the device after logout can expose the previous user's financial data without needing to re-authenticate, defeating the purpose of logging out.
- **Recommended fix:** On logout, explicitly clear the `PAGES_CACHE` (postMessage to the SW, or `caches.delete()` from the client) before/alongside the redirect, or scope cached pages to be revalidated/discarded on auth-state change.
- **Estimated implementation effort:** Small (<1hr)

**Positive:** Passwords are bcrypt-hashed (never stored/logged in plaintext); OTP codes are never stored in the database at all (only inside a short-lived signed JWT cookie); JWTs are signed (HS256) via `jose`, a well-regarded library. `NEXT_PUBLIC_`-prefixed env vars are not used anywhere, so no server secret is inadvertently exposed to the client bundle (verified no `NEXT_PUBLIC_` occurrences reference API keys).

## 11. LLM Security

**Status:** ✅ OK, no confirmed findings.
- The system prompt is fully server-constructed from the requesting user's own category data ([lib/ai/parse-transaction.ts:129-177](lib/ai/parse-transaction.ts#L129-L177), [app/api/chat/route.ts:8-13](app/api/chat/route.ts#L8-L13)); raw user text is passed as a separate `user`-role message rather than being concatenated into the system prompt, limiting (though not eliminating, as with any LLM) prompt-injection blast radius — and since the only data in scope is the requesting user's own account, a successful injection could at most affect that same user's own data, not other users'.
- The model's JSON output is never trusted blindly: `category`/`subcategory` are validated against the real, user-scoped category hierarchy (`findValidatedLeafCategory`, [lib/ai/parse-transaction.ts:217-231](lib/ai/parse-transaction.ts#L217-L231)) before being used, confidence is clamped and re-derived server-side ([lib/ai/parse-transaction.ts:243-258](lib/ai/parse-transaction.ts#L243-L258)), and a strict allow-list (`sanitizeNewCategorySuggestion`, [lib/ai/parse-transaction.ts:104-114](lib/ai/parse-transaction.ts#L104-L114)) drops any hallucinated or extra keys (e.g. an injected `icon`) from `newCategorySuggestion` before it can reach the client or the database. Icons for AI-suggested categories are resolved from a server-side lookup table, never taken from the model's response ([lib/categories.ts:63-84](lib/categories.ts#L63-L84)).
- Chat responses are rendered as plain React text content (`{m.content}`), never `dangerouslySetInnerHTML`, so a prompt-injected/malicious model response cannot execute as HTML/script in the browser ([components/chat/chat-interface.tsx:78-88](components/chat/chat-interface.tsx#L78-L88)).

## 12. LLM Cost & Abuse Control

**Finding SEC-6 — No token/output cap on LLM calls**
- **Status:** Confirmed Issue
- **Evidence:** `callNvidiaAI()`'s request body only ever includes `model`, `messages`, and optionally `response_format`/`stream` — no `max_tokens` (or equivalent) is set on either the transaction-parse or chat call paths.
- **File(s):** [lib/nvidia-ai.ts:32-48](lib/nvidia-ai.ts#L32-L48), callers at [lib/ai/parse-transaction.ts:337-343](lib/ai/parse-transaction.ts#L337-L343) and [app/api/chat/route.ts:53](app/api/chat/route.ts#L53)
- **Risk Level:** 🟡 Medium | **Confidence:** 85%
- **Why it matters:** Per-user request-count rate limits exist (`CHAT_USER_RULE`, `TRANSACTION_PARSE_USER_RULE`), which is good, but nothing bounds the size/cost of any single response. A pathological or adversarial prompt that induces a very long completion is billed in full and there is no server-side cap to fail fast.
- **Practical impact:** Bounded but non-trivial cost exposure per abusive session — request-count limits reduce frequency, not per-call cost.
- **Recommended fix:** Add an explicit `max_tokens` to both call sites sized to the actual UI needs (a transaction-parse JSON object and a chat reply are both naturally short).
- **Estimated implementation effort:** Small (<1hr)

**Positive:** Both LLM-calling endpoints enforce authenticated, per-user rate limits before making any model call (`TRANSACTION_PARSE_USER_RULE`: 60/5min, `CHAT_USER_RULE`: 15/5min — [lib/rate-limit.ts:104-105](lib/rate-limit.ts#L104-L105)), and the transaction-parse path skips the LLM entirely whenever a deterministic bank-SMS or merchant-lookup match is found, meaningfully reducing real-world call volume/cost ([lib/ai/parse-transaction.ts:283-336](lib/ai/parse-transaction.ts#L283-L336)).

## 13. Error Handling

**Status:** ✅ OK, no confirmed findings.
- All Route Handlers return curated, user-facing Persian error strings rather than raw exception details; raw `error.message`/`error.stack` are only ever written server-side to the `ErrorLog` table, never included in the JSON response body beyond the already-curated message (e.g. [app/api/transactions/parse/route.ts:45-54](app/api/transactions/parse/route.ts#L45-L54)).
- `logError()` truncates all fields (`route` ≤200, `message` ≤2000, `stack` ≤8000 chars) and deliberately swallows its own failures so a logging error can never mask or crash the original handler ([lib/error-log.ts:3-30](lib/error-log.ts#L3-L30)).
- The unauthenticated `POST /api/log-error` endpoint (needed so client error boundaries can report before/without a session) is bounded by the same general per-IP rate limit as every other API route plus the length caps above, and its stored `stack`/`message` are rendered as plain React text in the admin logs view — not `dangerouslySetInnerHTML` — so stored-XSS via a forged error report is not possible ([app/app/admin/logs/page.tsx:55-61](app/app/admin/logs/page.tsx#L55-L61)).

## 14. Observability

**Finding OBS-1 — No instrumentation/APM hook**
- **Status:** Confirmed Issue (absence)
- **Evidence:** No `instrumentation.ts`/`instrumentation.js` file exists at the project root or in `app/`.
- **File(s):** N/A (absence confirmed via `find`)
- **Risk Level:** 🟢 Low | **Confidence:** 85%
- **Why it matters:** Next.js's `instrumentation.ts` hook is the standard place to wire up OpenTelemetry/APM for request tracing, DB latency, and LLM call latency. Without it, the only operational visibility is the custom `ErrorLog` table (which only captures explicit `logError()` calls, not general latency/throughput).
- **Practical impact:** Slower incident diagnosis (e.g. LLM latency spikes, DB slow queries) since there's no tracing to fall back on beyond manual log reading.
- **Recommended fix:** Add `instrumentation.ts` wiring `@vercel/otel` or a comparable OpenTelemetry setup once a hosting/observability backend is chosen.
- **Estimated implementation effort:** Medium (a few hours, depends on chosen backend)

## 15. Caching Strategy

**Status:** N/A / ✅ OK — the app is a fully authenticated, per-user dashboard with no public cacheable content beyond the marketing landing page and static assets, so Next.js Data/Fetch Cache, ISR, and `revalidateTag`/`cacheTag` are correctly not used for the finance data itself (all `lib/data/*` reads go straight to Prisma per-request, which is the right call for personalized financial data that must never be stale or shared between users). See Encryption finding SEC-2 above for the one caching-related issue found (service-worker page cache surviving logout).

## 16. Rendering Performance

**Status:** ✅ OK, no confirmed findings.
- The app consistently follows the Next.js-recommended Data Access Layer pattern: pages are Server Components that call `lib/data/*` functions directly (e.g. dashboard, transactions, reports), rather than client components round-tripping through API routes for their own initial data — reducing waterfalls and client bundle size for read paths.
- `export const dynamic = "force-dynamic"` is explicitly set where session-dependent, always-fresh data is required (e.g. [app/app/admin/logs/page.tsx:8](app/app/admin/logs/page.tsx#L8)).

## 17. Bundle Optimization

**Finding (informational, not scored)**
- No `next/dynamic` usage was found anywhere in `app/`/`components/` (`grep` returned no matches). For a PWA that includes chart/report components (`components/reports/*`, `components/dashboard/category-donut.tsx`) and an admin section not used by most users, this is a missed opportunity to code-split rarely-used or heavier UI out of the initial bundle.
- **Risk Level:** 🟢 Low (performance, not security) | **Confidence:** 60%
- **Recommended fix:** Consider `next/dynamic` for the admin section and chart components.
- **Estimated implementation effort:** Small (<1hr) per component.

## 18. Assets Optimization

**Status:** ✅ OK, minor note.
- The Vazirmatn font is self-hosted via `@fontsource-variable/vazirmatn` rather than loaded from a third-party CDN/Google Fonts, which is both a privacy win (no third-party font request leaking user IPs) and CSP-friendly ([app/layout.tsx:2](app/layout.tsx#L2)).
- `next/image` is not used anywhere in the app (only a plain `<img>` in `components/logo.tsx`); given the app is financial data/text-heavy with only a handful of static PWA icons, the impact is low, but any future user-avatar/receipt-photo feature should use `next/image` from the start.

## 19. React Quality

**Status:** ✅ OK, no confirmed findings from the components reviewed (`login-form.tsx`, `verify-form.tsx`, `chat-interface.tsx`, `add-transaction-form.tsx`, `user-danger-zone.tsx`). Effects are cleaned up correctly (e.g. OTP resend timer interval, in-flight `AbortController` cleanup in `AddTransactionForm`'s `useEffect` — [components/transactions/add-transaction-form.tsx:77-81](components/transactions/add-transaction-form.tsx#L77-L81)); async state updates after `await` correctly use functional `setState` updates to avoid stale-closure races ([components/transactions/add-transaction-form.tsx:234-238](components/transactions/add-transaction-form.tsx#L234-L238), documented inline).

## 20. Server / Client Component Boundaries

**Status:** ✅ OK, one minor note.
- `"use client"` components consistently receive narrow, purpose-built props rather than raw Prisma rows (e.g. `AddTransactionForm`'s `CategoryOption`/`AccountOption` shapes are hand-picked subsets, not full DB rows).
- The `server-only` npm package is not installed/imported anywhere in `lib/data/*` or `lib/auth/*`. This isn't a demonstrated leak (nothing in those modules is imported from a `"use client"` file in this codebase), but adding it would give a build-time guarantee against a future accidental import from client code, per Next.js's own recommended pattern.
- **Risk Level:** 🟢 Low | **Confidence:** 65% | **Estimated implementation effort:** Small (<1hr)

## 21. Code Quality

**Finding CQ-1 — README documents a stale/incorrect stack**
- **Status:** Confirmed Issue
- **Evidence:** `README.md` states "SQLite via Prisma ORM 7 (`@prisma/adapter-better-sqlite3`)" and "OpenRouter for all AI calls," neither of which matches the current implementation (`@prisma/adapter-libsql` against Turso in `lib/prisma.ts`; NVIDIA NIM in `lib/nvidia-ai.ts`). Recent commit history (`switch LLM provider to NVIDIA NIM API`, `redeploy with nvidia env vars`) confirms this is a real migration the README wasn't updated for.
- **File(s):** [README.md:10-13](README.md#L10-L13) vs. [lib/prisma.ts:1-15](lib/prisma.ts#L1-L15), [lib/nvidia-ai.ts:1-23](lib/nvidia-ai.ts#L1-L23)
- **Risk Level:** 🟢 Low | **Confidence:** 90%
- **Why it matters:** Not a security issue directly, but stale onboarding docs cause real setup friction/misconfiguration risk (e.g. a new contributor following the README's `OPENROUTER_API_KEY` instructions instead of the actually-required `NVIDIA_*` vars, or trying to point Prisma at plain SQLite).
- **Practical impact:** Onboarding friction and potential misconfiguration, which indirectly feeds into other findings like SEC-7 (silent fallback behavior).
- **Recommended fix:** Update the README's tech-stack and getting-started sections to match the current NVIDIA NIM / Turso implementation.
- **Estimated implementation effort:** Small (<1hr)

**Positive:** Code throughout `lib/` is unusually well-commented with rationale ("why", not just "what") for non-obvious decisions (rate-limit tuning, confidence thresholds, cascade rules, legacy-cookie migration path), which materially eased this audit and will ease future maintenance.

## 22. Testing

**Finding T-1 — Tests run against the live configured database**
- **Status:** Confirmed Issue (observed directly)
- **Evidence:** `vitest.config.ts` loads `.env` via `dotenv/config` with no override/separate test-database configuration; test files import `prisma` from `lib/prisma.ts` directly and perform real `create`/`update`/`delete` calls (e.g. `prisma.user.create({ data: { phoneNumber: \`TEST-MONTHLY-COMPARISON-${Date.now()}\` } })`). Running `npx vitest run` in this audit produced **1 failed test** (`updateTransaction ... creates a MerchantMapping ...` timed out after 5000ms) and **1 failed suite** (`getMonthlyComparison`'s `beforeAll` hook timed out after 10000ms), with the remaining 247 tests passing.
- **File(s):** [vitest.config.ts:1-11](vitest.config.ts#L1-L11), [lib/data/transactions.test.ts:45](lib/data/transactions.test.ts#L45), [lib/reports/monthly-comparison.test.ts:18-21](lib/reports/monthly-comparison.test.ts#L18-L21)
- **Risk Level:** 🟡 Medium | **Confidence:** 95%
- **Why it matters:** Tests that mutate whatever database is configured in the developer's `.env` (rather than an isolated/ephemeral test database) risk polluting real data if `.env` ever points at a shared or production-adjacent Turso database, and make test runs slow/flaky due to real network round-trips to a remote libSQL host — consistent with the timeouts observed.
- **Practical impact:** Currently observable test instability at HEAD (not a hypothetical); any CI eventually added on top of this setup would need a dedicated ephemeral database to be reliable.
- **Recommended fix:** Point `vitest.config.ts` at a separate, disposable SQLite/libSQL test database (local file DB is simplest given the schema is SQLite-compatible), and clean up/rollback test-created rows.
- **Estimated implementation effort:** Medium (a few hours)

**Finding T-2 — No CI pipeline**
- **Status:** Confirmed Issue (absence)
- **Evidence:** No `.github/workflows/` directory exists in the repository.
- **File(s):** N/A (absence confirmed via `find`)
- **Risk Level:** 🟡 Medium | **Confidence:** 95%
- **Why it matters:** `npm run lint`, `npm run test`, and TypeScript type-checking are all defined in `package.json` but nothing enforces them before merge — regressions (including security-relevant ones, like an authorization check being dropped) can land without being caught automatically.
- **Practical impact:** Relies entirely on manual discipline; the T-1 test failures above are a concrete example of drift that CI would have surfaced immediately.
- **Recommended fix:** Add a GitHub Actions workflow running `npm run lint`, `npx tsc --noEmit`, and `npm run test` on every PR (once T-1's isolated test DB is in place).
- **Estimated implementation effort:** Small (<1hr for the workflow itself)

**Positive:** Test coverage breadth is genuinely strong for the deterministic parsing/matching logic that most needs it — bank SMS detection/amount/type extraction, merchant lookup tiering, category-alias/similarity matching, amount/date extraction, and rate-limiting all have dedicated unit test files (19 test files, 254 total test cases, 247 passing).

## 23. Deployment Readiness

**Finding DR-1 — No containerization/process-manager config for the described deployment target**
- **Status:** Possible Issue
- **Evidence:** `auth.ts:35-38`'s comment describes deployment "behind a reverse proxy on a self-managed VPS," but no `Dockerfile`, `docker-compose.yml`, or process-manager config (e.g. `ecosystem.config.js` for PM2) exists in the repository.
- **File(s):** N/A (absence confirmed via `find`)
- **Risk Level:** 🟢 Low | **Confidence:** 60%
- **Why it matters:** Without a reproducible build/run artifact checked into the repo, deployment steps for a self-managed VPS likely live outside version control, which is a reproducibility/disaster-recovery gap (though this may be intentionally managed elsewhere, e.g. a deploy script or runbook not in this repo).
- **Practical impact:** Cannot be fully assessed from this repository alone.
- **Recommended fix:** If not already tracked elsewhere, add a `Dockerfile` (Next.js standalone output) or a documented deploy runbook to the repo.
- **Estimated implementation effort:** Medium (a few hours)

**Other notes:** `next.config.ts` sets no `output` mode (defaults to a standard Next.js server build, consistent with a VPS/Node.js deployment rather than static export). A stray `dev.db` (SQLite artifact, gitignored, likely a leftover from before the Turso migration — consistent with the README staleness finding CQ-1) and a stray `.env.save` backup file exist in the working tree; both are correctly gitignored and pose no repository-level risk, but are worth local cleanup.

## 24. Security Headers

Covered under **API & HTTP Security** above (SEC-1, SEC-11) — no separate findings beyond those.

## 25. Financial Application Risks

**Finding SEC-2** (service-worker cache persisting financial data post-logout) and **SEC-10** (no transaction-creation idempotency) above are the two findings specific to this category; see their full write-ups in sections 10 and 9 respectively.

**Positive:**
- Duplicate-category prevention exists both at the DB level (`@@unique([userId, name, type])` — [prisma/schema.prisma:105](prisma/schema.prisma#L105)) and the AI-suggestion path additionally rate-limits new-category creation to 10/24h and runs a three-stage similarity check (`findSimilarCategory`) before creating a new one, preventing category sprawl from repeated AI acceptances ([app/api/categories/route.ts:20-26,109-147](app/api/categories/route.ts#L20-L26)).
- Accounts/categories in active use cannot be deleted (`AccountInUseError`/`CategoryInUseError` guard on transaction-count checks — [lib/data/accounts.ts:58-61](lib/data/accounts.ts#L58-L61), [lib/data/categories.ts:68-71](lib/data/categories.ts#L68-L71)), preventing orphaned financial records via the API layer (also enforced at the DB level via `onDelete: Restrict`).
- Admin cannot block/delete their own account, preventing accidental admin lockout ([lib/data/admin-users.ts:120-126,141-144](lib/data/admin-users.ts#L120-L126)).
- All monetary amounts are stored/handled as integers (Toman, no floating-point currency arithmetic), avoiding classic floating-point rounding bugs in financial calculations.

---

# Confirmed Issues

(Findings with confidence ≥ 80%, consolidated from above)

| ID | Title | Risk | Confidence |
|----|-------|------|------------|
| SEC-1 | No security headers configured (CSP/HSTS/X-Frame-Options/etc.) | 🟠 High | 95% |
| SEC-2 | Financial data persists in Cache Storage after logout | 🟠 High | 85% |
| SEC-3 | IP-based rate limits keyed off spoofable `X-Forwarded-For` | 🟠 High | 80% |
| SEC-4 | `next-auth` beta dependency in production | 🟡 Medium | 90% |
| SEC-5 | In-memory rate limiter not distributed-safe | 🟡 Medium | 95% |
| SEC-6 | No token/output cap on LLM calls | 🟡 Medium | 85% |
| SEC-11 | `X-Powered-By` header not disabled | 🟢 Low | 80% |
| T-1 | Tests run against live configured database; observed failures | 🟡 Medium | 95% |
| T-2 | No CI pipeline | 🟡 Medium | 95% |
| CQ-1 | README documents a stale stack | 🟢 Low | 90% |
| OBS-1 | No instrumentation/APM hook | 🟢 Low | 85% |

# Possible Issues

(Confidence < 80%)

| ID | Title | Risk | Confidence |
|----|-------|------|------------|
| SEC-7 | OTP fallback logs plaintext codes to console if misconfigured | 🟡 Medium | 75% |
| SEC-8 | Single `AUTH_SECRET` reused across OTP/legacy/NextAuth signing | 🟡 Medium | 70% |
| SEC-9 | `trustHost: true` — reverse-proxy Host-header hardening unverifiable from repo | 🟡 Medium | 60% |
| SEC-10 | No server-side idempotency on transaction creation | 🟡 Medium | 75% |
| SEC-12 | 90-day sessions with no step-up re-auth | 🟢 Low | 70% |
| IV-1 | No schema-validation library (Zod) | 🟢 Low | 70% |
| DR-1 | No Dockerfile/process-manager config for described VPS deployment | 🟢 Low | 60% |
| (perf) | No `next/dynamic` code-splitting for admin/chart components | 🟢 Low | 60% |
| (quality) | `server-only` package not used in `lib/data`/`lib/auth` | 🟢 Low | 65% |

# Positive Findings

- Consistent, thorough ownership scoping (`{ id, userId }`) across the entire data layer — no IDOR found in transactions, accounts, categories, or merchant mappings.
- Defense-in-depth admin authorization: edge-level gate in `proxy.ts` **and** independent `requireAdminSession()` checks inside every admin data function.
- No SQL injection surface: 100% Prisma query builder, zero raw SQL anywhere in the codebase.
- No XSS surface found: zero `dangerouslySetInnerHTML`, zero `eval`/`Function`/`child_process` usage anywhere in the codebase.
- Solid OTP design: short TTL, attempt cap enforced server-side inside a signed token (not a client-trusted counter), layered per-phone/per-IP rate limits.
- Passwords bcrypt-hashed (cost 12); OTP codes never persisted to the database.
- Secrets and local DB files properly gitignored and never committed to git history.
- Fail-closed secret handling (`lib/prisma.ts`, `lib/nvidia-ai.ts`, `lib/auth/otp.ts` all throw rather than default when required env vars are missing).
- LLM outputs are never trusted blindly — category/subcategory pairs, confidence, and new-category suggestions are all re-validated server-side against the real per-user data before use.
- Good adherence to the Next.js Data Access Layer pattern — Server Components call `lib/data/*` directly; client components receive narrow, purpose-built props rather than raw DB rows.
- Self-hosted font (no third-party font-loading privacy leak).
- Strong, rationale-rich code comments throughout `lib/` that materially aid security review and future maintenance.
- Solid unit-test coverage (254 test cases) for the deterministic parsing/matching logic that most needs it.
- Sound financial-integrity guards: unique constraints + in-use checks prevent orphaned/duplicate categories and accounts; integer (not float) currency arithmetic throughout.

# Risk Distribution

| Level | Count |
|-------|-------|
| 🔴 Critical | 0 |
| 🟠 High | 3 |
| 🟡 Medium | 9 |
| 🟢 Low | 8 |
| ✅ OK (category-level, no issues) | 9 |
| N/A | 1 |

# Top 10 Priorities

1. **SEC-3 — Fix `getClientIp()` to trust only your own reverse proxy's header hop.** Every rate limit in the app (OTP cost control, brute-force protection, general abuse backstop) depends on this one function; if it's spoofable in production, all of them are simultaneously defeated — this is the single highest-leverage fix in the report.
2. **SEC-1 — Add baseline security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).** Zero headers are currently set anywhere; this is a cheap, well-understood defense-in-depth layer missing entirely from a financial app.
3. **SEC-2 — Clear the service-worker page cache on logout.** Directly exposes a previous user's real financial data (balances, transactions) on shared devices after logout, which is a realistic usage pattern for this product.
4. **T-2 — Stand up CI (lint + typecheck + test) on every PR.** Costs under an hour to wire up and would have caught the currently-failing test (T-1) automatically; every other fix in this list benefits from having a safety net.
5. **T-1 — Give tests an isolated database.** Tests currently mutate whatever database `.env` points at and are observably flaky (1 failure, 1 timeout at HEAD) — this blocks T-2 from being reliable and risks polluting real data.
6. **SEC-6 — Cap LLM response size (`max_tokens`).** Small, fast fix that closes an open-ended cost exposure on the two AI-calling endpoints.
7. **SEC-10 — Add idempotency protection to transaction creation.** Directly protects the core financial-integrity guarantee of the product (accurate transaction history) against a plausible double-submit/retry scenario.
8. **SEC-7 — Gate the mock-SMS console fallback on `NODE_ENV`, not just credential presence.** A silent production misconfiguration here means real OTP codes end up in server logs with no alert — cheap to fix, high severity if it ever triggers.
9. **SEC-4 — Pin the exact `next-auth` beta version (remove the `^`).** The single most security-critical dependency in the app should not be able to silently shift to a new beta release on a routine `npm install`.
10. **SEC-8 — Separate the OTP-signing secret from the session-signing secret.** Reduces blast radius of a leaked `AUTH_SECRET` from "every session, forever" to a smaller, purpose-scoped exposure.
