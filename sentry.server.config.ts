import * as Sentry from "@sentry/nextjs";
import { redact } from "@/lib/observability/redact";

// Loaded from instrumentation.ts's register() only when NEXT_RUNTIME is
// "nodejs" - see that file's comment on why this codebase has no
// sentry.edge.config.ts counterpart today (confirmed via the Phase 12
// audit: no Edge runtime is used anywhere in this app).
Sentry.init({
  // Server-side DSN - see .env.example. A missing/empty dsn already makes
  // the SDK no-op cleanly on its own (confirmed against @sentry/core's
  // Client: it just never attaches a DSN to send through - no throw, no
  // blocked requests), so no extra enabled/guard flag is needed here for
  // local dev or any environment where this isn't configured yet.
  dsn: process.env.SENTRY_DSN,

  // Reuses this app's existing NODE_ENV-based environment convention
  // (next.config.ts's `isDev`, lib/auth/otp.ts's/lib/auth/session.ts's
  // `NODE_ENV === "production"` checks) rather than introducing a new env
  // var (e.g. VERCEL_ENV) just for Sentry.
  environment: process.env.NODE_ENV,

  // Tracing/performance monitoring deliberately left disabled (no
  // tracesSampleRate set) - Phase 12's own scope is error/log
  // observability only ("No OpenTelemetry / full distributed tracing").
  // beforeSendTransaction below is still wired for when/if tracing is
  // turned on later, so that decision doesn't also require touching this
  // file's redaction wiring again.

  // Reuses the one shared redaction implementation (lib/observability/
  // redact.ts, Phase 12.1) - the same function this codebase's own
  // logger.ts wires in - rather than a second, Sentry-specific one.
  beforeSend(event) {
    return redact(event);
  },
  beforeSendTransaction(event) {
    return redact(event);
  },
});
