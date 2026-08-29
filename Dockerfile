# DR-1 (docs/roadmap-status.md). Multi-stage build producing a minimal
# runtime image from Next.js's standalone output (next.config.ts's
# `output: "standalone"`, added alongside this file). Node 22 to match
# .github/workflows/ci.yml's pinned version, for consistency between what
# CI lints/type-checks/tests against and what actually ships.
#
# No secret is ever baked into this image - every credential the app needs
# (AUTH_SECRET, TURSO_AUTH_TOKEN, NVIDIA_API_KEY, ...) is read from
# process.env at container start, supplied by whatever runs the container
# (see docs/deploy-runbook.md). The ARGs below are placeholder, non-secret
# strings that exist only so `next build`'s static pre-rendering pass (which
# actually executes each static page's Server Component code, unlike the
# dynamic API routes) doesn't fail against modules that read a required
# env var at import time (e.g. lib/prisma.ts's requireEnv()) - the same
# reason .github/workflows/ci.yml sets dummy values for its own lint/test
# run. They're discarded once the build stage finishes; the runtime stage
# below never inherits build-stage ARGs/ENV, only what's copied into it.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: this project's own postinstall (prisma generate) needs
# prisma/schema.prisma, which isn't copied into this stage - it runs for
# real in the builder stage below instead, right before `next build`.
RUN npm ci --ignore-scripts

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time-only placeholders - see file header. Real values are supplied
# at container run time (docs/deploy-runbook.md), never at build time.
ARG AUTH_SECRET=docker-build-placeholder
ARG OTP_SECRET=docker-build-placeholder
ARG LEGACY_SESSION_SECRET=docker-build-placeholder
ARG TURSO_DATABASE_URL=libsql://docker-build-placeholder
ARG TURSO_AUTH_TOKEN=docker-build-placeholder
ARG NVIDIA_API_KEY=docker-build-placeholder
ARG NVIDIA_BASE_URL=https://docker-build-placeholder.invalid/v1
ARG NVIDIA_MODEL=docker-build-placeholder
# Not a secret (see sentry.server.config.ts's own comment: designed to ship
# in the client bundle) but genuinely build-time, unlike every other var
# here - NEXT_PUBLIC_-prefixed vars are inlined into the client JS at
# `next build`, so this is the one ARG worth actually setting for real if
# you want Sentry client-side error capture (docs/deploy-runbook.md); every
# other ARG above only needs to be non-empty, not correct, for the build to
# succeed.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV AUTH_SECRET=$AUTH_SECRET \
    OTP_SECRET=$OTP_SECRET \
    LEGACY_SESSION_SECRET=$LEGACY_SESSION_SECRET \
    TURSO_DATABASE_URL=$TURSO_DATABASE_URL \
    TURSO_AUTH_TOKEN=$TURSO_AUTH_TOKEN \
    NVIDIA_API_KEY=$NVIDIA_API_KEY \
    NVIDIA_BASE_URL=$NVIDIA_BASE_URL \
    NVIDIA_MODEL=$NVIDIA_MODEL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Unprivileged runtime user - standard Next.js standalone-output convention.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone output's server.js does not include public/ or .next/static by
# default (see next.config.ts's output.md guide) - copied in explicitly.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
