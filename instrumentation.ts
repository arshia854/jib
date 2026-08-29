import * as Sentry from "@sentry/nextjs";

// Confirmed via the Phase 12 audit (docs/roadmap-status.md, "Phase 12
// Audit - Observability"): every route and this project's Proxy
// (proxy.ts) run on the Node.js runtime - this Next.js version's Proxy
// defaults to Node.js and can't be switched to Edge, and no route
// anywhere declares `runtime = "edge"`. Sentry's own manual-setup
// instructions for Next.js (and this exact Next.js version's own
// instrumentation.md, node_modules/next/dist/docs/.../instrumentation.md)
// show a `NEXT_RUNTIME === "edge"` branch importing a
// `sentry.edge.config.ts` alongside this one - deliberately not added
// here, since that branch would never fire in this codebase today and an
// untested sentry.edge.config.ts would be dead code. If an Edge route is
// ever added, that's the point to add both the branch and the file.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

// Next.js's own request-error instrumentation hook (see this project's own
// node_modules/next/dist/docs/.../instrumentation.md - "onRequestError").
// Sentry.captureRequestError is the SDK's documented wiring for it - not a
// hand-rolled handler, per the Phase 12 spec ("Do not hand-roll error
// boundaries beyond what the SDK provides").
export const onRequestError = Sentry.captureRequestError;
