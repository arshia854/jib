import * as Sentry from "@sentry/nextjs";
import { redact } from "@/lib/observability/redact";

Sentry.init({
  // NEXT_PUBLIC_ prefix is required for this to be readable in the browser
  // bundle at all - a plain SENTRY_DSN (used server-side, see
  // sentry.server.config.ts) is stripped from client bundles by Next.js by
  // design, so the client needs its own, separately-named env var. See
  // .env.example. A missing/empty dsn already makes the SDK no-op cleanly
  // on its own (see sentry.server.config.ts's comment) - no extra
  // enabled/guard flag needed for local dev.
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Same NODE_ENV-based convention as sentry.server.config.ts - see that
  // file's comment. NODE_ENV is statically inlined into the client bundle
  // by Next.js's build (same mechanism next.config.ts's own `isDev` relies
  // on), so this doesn't need a NEXT_PUBLIC_ prefix.
  environment: process.env.NODE_ENV,

  // Tracing/performance monitoring and router-navigation instrumentation
  // (this file's optional `onRouterTransitionStart` export - see
  // node_modules/next/dist/docs/.../instrumentation-client.md) deliberately
  // left out - Phase 12's own scope is error/log observability only ("No
  // OpenTelemetry / full distributed tracing").

  // Reuses the one shared redaction implementation (lib/observability/
  // redact.ts, Phase 12.1) rather than a second, Sentry-specific one -
  // safe to import into the client bundle too, since redact.ts has no
  // Node-only dependencies (see its own file).
  beforeSend(event) {
    return redact(event);
  },
  beforeSendTransaction(event) {
    return redact(event);
  },
});
