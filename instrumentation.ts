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
// Phase 4 nightly reminder (docs/roadmap-status.md) - registered here
// rather than a new startup mechanism, since this is already the project's
// one "runs once when the server starts" hook (confirmed no other
// long-running/startup-hook pattern exists - no custom server file,
// nothing under scripts/ that stays running). Next.js's own docs
// (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md) state
// register() "will be called once when a new Next.js server instance is
// initiated" - so no module-level double-registration guard is added here:
// per that documented guarantee there's nothing for one to actually guard
// against in this project's setup (single Docker container running `node
// server.js`, confirmed against docs/deploy-runbook.md and the Dockerfile -
// no PM2/cluster mode anywhere in this repo), and a guard with nothing to
// guard against is dead code.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Resumes background enrichment runs a restart interrupted (and, in
    // dev, pre-compiles the workflow routes) - see its own comment.
    const { startWorkflowWorld } = await import("./lib/workflows/start-world");
    await startWorkflowWorld();
    // Imported inline in this branch, not from a helper function outside
    // it: Next also compiles this file for the Edge runtime, and when these
    // imports lived in a separate function the Edge build still traced
    // nightly-reminder -> lib/prisma -> the generated Prisma client and
    // warned about its node:path / node:url imports. Next's instrumentation
    // guide puts runtime-specific imports directly under the NEXT_RUNTIME
    // check for this reason.
    const { schedule } = await import("node-cron");
    const { runNightlyReminderJob } = await import("./lib/notifications/nightly-reminder");
    schedule("0 23 * * *", () => runNightlyReminderJob(), { timezone: "Asia/Tehran" });
  }
}

// Next.js's own request-error instrumentation hook (see this project's own
// node_modules/next/dist/docs/.../instrumentation.md - "onRequestError").
// Sentry.captureRequestError is the SDK's documented wiring for it - not a
// hand-rolled handler, per the Phase 12 spec ("Do not hand-roll error
// boundaries beyond what the SDK provides").
export const onRequestError = Sentry.captureRequestError;
