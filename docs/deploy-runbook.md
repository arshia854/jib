# Deploy runbook

DR-1 (`docs/roadmap-status.md`). Covers what's needed to run Jib's
[`Dockerfile`](../Dockerfile) in production: required env vars, the
reverse-proxy requirement rate limiting already depends on, and how to
apply a schema migration against the live DB (this is **not**
`prisma migrate deploy` — see [`AGENTS.md`](../AGENTS.md)).

Not covered here: CI (`.github/workflows/ci.yml`, already exists), or how
to provision the Turso database itself (assumed to already exist, per
`AGENTS.md`'s migration workflow).

## 1. Build and run the image

```bash
docker build -t jib .
docker run -d --name jib -p 3000:3000 --env-file .env jib
```

`--env-file .env` is the simplest way to pass every runtime var in §2 at
once (same file local dev already uses, per `.env.example`) — swap for
whatever your host actually uses (`docker run -e VAR=...` per var,
Kubernetes `Secret`/`ConfigMap`, systemd `EnvironmentFile=`, etc.). No
secret is baked into the image itself — see the [`Dockerfile`](../Dockerfile)'s
own header comment; the `ARG`s it defines are non-secret build-time
placeholders only (§3 below covers the one exception, `NEXT_PUBLIC_SENTRY_DSN`).

Verified working end-to-end in this session: `docker build` succeeded,
the container booted (`✓ Ready in 0ms`), and `curl` against `/`, `/login`,
`/manifest.webmanifest`, `/sw.js`, and `/api/transactions` (401,
unauthenticated) all returned the expected status/headers, running as the
unprivileged `nextjs` user (uid 1001), not root.

## 2. Required runtime environment variables

Same list as [`.env.example`](../.env.example) (source of truth — this
section is a deploy-focused summary of it, not a second copy to keep in
sync by hand):

| Variable | Required? | Notes |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | **Yes** | `lib/prisma.ts` throws on first use if either is missing. |
| `AUTH_SECRET` | **Yes** | NextAuth session JWTs. `openssl rand -base64 48`. |
| `OTP_SECRET` | **Yes** | Phone-OTP challenge JWTs. Independent secret from `AUTH_SECRET` — don't reuse. |
| `LEGACY_SESSION_SECRET` | **Yes** | Pre-NextAuth session cookie, still read for users who haven't re-authenticated since that migration. |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODEL` | **Yes** | Transaction parsing + chat assistant. No fallback provider is wired up live (OpenRouter/ArvanCloud vars in `.env.example` are inert - "kept around in case we switch back"). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional | Only Google sign-in ("ورود با گوگل") needs these — confirmed the app still boots and serves requests without them set (this session's smoke test ran without them). Redirect URI: `https://<your-domain>/api/auth/callback/google`. |
| `MELIPAYAMAK_USERNAME`, `MELIPAYAMAK_PASSWORD`, `MELIPAYAMAK_BODY_ID` | Recommended | Real OTP SMS delivery. If any is unset, `sendOtpSms()` fails closed in production (`lib/auth/otp.ts` - SEC-7) rather than sending a code, so phone sign-in would be unusable without these, not silently insecure. |
| `SENTRY_DSN` | Optional | Server-side error reporting. SDK no-ops cleanly if unset. |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional, **build-time** | See §3 — a runtime-only `-e`/`--env-file` value here does nothing; it must be set when the image is built. |

## 3. `NEXT_PUBLIC_SENTRY_DSN` needs a build arg, not just a run-time var

Every other variable in §2 is read from `process.env` live, at request
time, inside the running Node process — so passing it to `docker run` (or
any equivalent at deploy time) is enough, exactly like local dev's `.env`.
`NEXT_PUBLIC_*`-prefixed variables are different: Next.js inlines them into
the client-side JS bundle **during `next build`**, so a value only set at
`docker run` time never reaches the browser — the client bundle was
already finalized when the image was built.

If you want Sentry's client-side error capture (`instrumentation-client.ts`)
working, pass it as a build arg instead:

```bash
docker build --build-arg NEXT_PUBLIC_SENTRY_DSN="https://...@sentry.io/..." -t jib .
```

Server-side Sentry (`SENTRY_DSN`, `sentry.server.config.ts`) doesn't have
this restriction — it's a normal runtime var, set it in `.env`/`docker run`
like everything else in §2.

## 4. Reverse proxy requirement (SEC-3 follow-through)

Jib expects to run **behind a reverse proxy** (nginx, Caddy, a cloud load
balancer, …), not exposed directly to the internet — this is also Next.js's
own standard self-hosting recommendation (request validation, TLS
termination, etc. belong in front of the app, not in it).

**One piece of proxy config is required for correctness, not just best
practice:** `lib/rate-limit.ts`'s `getClientIp()` (SEC-3) trusts `X-Real-IP`
first, then the *last* hop of `X-Forwarded-For` — deliberately not the
first, since the first is fully attacker-controlled (any client can send
an arbitrary `X-Forwarded-For` header). This is only spoof-proof once the
proxy actually sets `X-Real-IP` to the true peer address itself, overwriting
anything the client sent — **confirmed still an open dependency as of this
writing** (`docs/roadmap-status.md`'s Phase 4 log: 4.2.8, the "reverse-proxy
hardening runbook" item, is not yet marked done — this section is that
runbook's first concrete draft, not confirmation the proxy is already
configured this way anywhere).

```
# nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Host $host;

# Caddy - sets X-Real-IP to the immediate peer by default; just don't pass
# through whatever an upstream client already sent under that name.
```

Also required, given `auth.ts` sets `trustHost: true`: the proxy must pin
`Host` (and `X-Forwarded-Host`, if your proxy sets it) to the app's real,
canonical domain — never pass through a client-supplied `Host` header
unchanged, or NextAuth's `trustHost` mode will trust a spoofed one for
callback-URL generation.

**Until the reverse proxy is actually confirmed configured this way, rate
limiting remains spoofable via `X-Forwarded-For`/`X-Real-IP`** (the code
already prefers the right headers - see above - but has no way to verify
from inside the app that whatever sits in front of it is honest about
them). Treat this checklist as a deployment blocker for that specific
protection, not optional hardening.

### Block `/.well-known/workflow/*` at the proxy

`/.well-known/workflow/*` is generated by the Workflow DevKit
(`next.config.ts`'s `withWorkflow()`) and is **not** covered by
`proxy.ts`'s route matcher — deliberately, since the DevKit's own docs
warn that letting `proxy.ts` intercept it breaks the local queue — so it
gets no session check and no app-level rate limit. Under the self-hosted
`world-local` runtime (what this Docker deploy uses — `WORKFLOW_TARGET_WORLD`
isn't set), its `flow`/`step` endpoints accept a run request with
caller-chosen arguments and no authentication at all, including
`enrichTransactionWorkflow(userId, transactionId, rawInput)` for any user
id. It **must** be blocked at the reverse-proxy layer instead.

Nothing legitimate needs to reach this path through the proxy: the
`world-local` queue calls its own `flow`/`step` endpoints at
`http://localhost:${PORT}` inside the container (confirmed in
`@workflow/world-local` 4.3.0's `dist/config.js`), never via the public
domain. So a flat block is safe:

```
# nginx - ^~ so no regex location elsewhere in the config can take
# precedence over this prefix match
location ^~ /.well-known/workflow/ {
    return 404;
}

# Caddy
respond /.well-known/workflow/* 404
```

This only holds if:

- `WORKFLOW_LOCAL_BASE_URL` stays **unset** (or points at a loopback
  address). If it pointed at the public domain, the queue's own calls
  would go through the proxy and hit this block, and enrichment would
  silently stop working.
- The container's port isn't reachable directly from the internet. The
  `-p 3000:3000` in §1 publishes it on every host interface. Bind it to
  loopback instead (`-p 127.0.0.1:3000:3000`) or firewall it, or anyone
  can go around this block the same way they'd go around the `X-Real-IP`
  requirement above.
- The app still doesn't use the DevKit's `createWebhook()`. Its generated
  `/.well-known/workflow/v1/webhook/:token` route is the one part of this
  namespace the DevKit intends to be public (the random URL token is its
  only authorization). Nothing in this repo calls `createWebhook()` today.
  If that changes, this block has to be narrowed deliberately, not just
  removed.

After deploying, verify through the proxy (not against port 3000 directly):
`curl -i -X POST https://<your-domain>/.well-known/workflow/v1/flow` (and
`/v1/step`) should return the proxy's 404, not a response from Next.js.

**Same weight as the `X-Real-IP` requirement above: apply this before the
app is ever exposed publicly.** Until it is, anyone who can reach the app
can start AI-parsing workflow runs for any user id.
`lib/workflows/enrich-transaction.ts` re-checks the per-user AI rate limit
inside the step as defense-in-depth. That caps AI spend per user id, but it
doesn't stop a direct caller from targeting another user's transactions,
so it isn't a substitute for this block.

## 5. Applying a schema migration

**Not** `prisma migrate deploy` — that command (along with `migrate dev`,
`migrate status`, `migrate resolve`, `db push`) does not work against this
project's live Turso database, full stop. See
[`AGENTS.md`](../AGENTS.md)'s "Applying schema changes to the live database
(Turso)" section for why and for the actual process (offline `migrate diff`
→ review → apply via raw `@libsql/client` → `_prisma_migrations`
bookkeeping via `scripts/backfill-migration-history.ts`). That process is
independent of how the app itself is deployed (Docker or otherwise) — it
operates directly against Turso, not through the running container - so
there's nothing Docker-specific to add here beyond: **run it before
deploying a container built from a commit whose `prisma/schema.prisma`
has changed**, the same ordering constraint that would apply to any
deployment method.

Before restoring from a backup or point-in-time recovery, see
[`AGENTS.md`](../AGENTS.md)'s "Backing up the live database (Turso)"
section (Phase 13.1).

## 6. Health check

No dedicated `/healthz`-style endpoint exists in this app today. `GET /` is
a fully static, pre-rendered page (confirmed in this session's `next build`
output: `○ /`) that renders without touching the database or any external
API, making it a reasonable liveness check for a load balancer/orchestrator
— a 200 there confirms the Node process is up and serving, though not that
the DB/NVIDIA NIM/SMS provider are reachable (none of those are exercised
by a static page).
