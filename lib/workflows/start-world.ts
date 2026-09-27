import { getWorld, healthCheck } from "workflow/runtime";
import { logger } from "@/lib/observability/logger";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";

// Only bounds how long warmUpWorkflowRoutes waits before logging a result -
// the compile it triggers carries on regardless. Sized above the ~46s (flow)
// and ~31s (step) first-compile times observed under `next dev` on the dev
// machine.
const WARM_UP_TIMEOUT_MS = 180_000;

// Called once from instrumentation.ts's register().
//
// world.start() is what makes world-local (the world this app runs on, in
// dev and in the Docker deploy - see docs/deploy-runbook.md §4) re-enqueue
// every run still "pending"/"running" in its data dir. Its queue is
// in-memory, so without this a server restart mid-run orphans the run for
// good and its transaction sits on enrichmentStatus "pending" forever. The
// SDK doesn't call it on its own; its docs have the app do it from
// register() (node_modules/workflow/docs/deploying/world/postgres-world.mdx).
// Safe to await here: start() only enqueues, and Next.js already has the
// port bound and holds incoming requests until register() returns.
//
// Never throws - a broken workflow data dir must not stop the app booting.
export async function startWorkflowWorld(): Promise<void> {
  try {
    await getWorld().start?.();
  } catch (error) {
    reportError({
      errorType: ERROR_TYPES.API_ERROR,
      route: "workflows/start-world",
      message: error instanceof Error ? error.message : "Failed to start workflow world",
      error,
    });
    return;
  }

  // Dev-only: `next dev` compiles the generated /.well-known/workflow/v1/flow
  // and /step routes lazily, on the first quick-submit that reaches them -
  // observed at ~77s combined before enrichment even began. Sending each
  // endpoint a health-check message right away moves that compile to server
  // startup instead. Not awaited: the check needs a response from this same
  // server, which can't serve anything until register() returns.
  if (process.env.NODE_ENV === "development") {
    void warmUpWorkflowRoutes();
  }
}

async function warmUpWorkflowRoutes(): Promise<void> {
  const world = getWorld();
  // One at a time, so both compiles don't compete with whatever page is
  // compiling first.
  for (const endpoint of ["workflow", "step"] as const) {
    // healthCheck() never throws - failures come back as healthy: false.
    const result = await healthCheck(world, endpoint, { timeout: WARM_UP_TIMEOUT_MS });
    if (result.healthy) {
      logger.info({ route: "workflows/start-world", endpoint, duration: result.latencyMs }, "Workflow route warmed up");
    } else {
      logger.warn({ route: "workflows/start-world", endpoint, error: result.error }, "Workflow route warm-up failed");
    }
  }
}
