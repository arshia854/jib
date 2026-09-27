import { AsyncLocalStorage } from "node:async_hooks";

// The header name used both to accept a client/upstream-supplied request ID
// and to echo the (possibly freshly-generated) one back on every response -
// shared here, not duplicated as a local string literal in proxy.ts and
// again in every route handler that later reads it, so it can't drift.
export const REQUEST_ID_HEADER = "x-request-id";

export interface RequestContext {
  requestId: string;
}

// Confirmed via the Phase 12 audit (docs/roadmap-status.md, "Phase 12
// Audit - Observability") that this entire codebase - proxy.ts and every
// app/api/** route.ts - runs on the Node.js runtime (this Next.js
// version's Proxy defaults to Node.js and can't even be switched to Edge;
// no route anywhere declares `runtime = "edge"`). AsyncLocalStorage is
// therefore safe to use unconditionally here, with no Edge-runtime
// fallback branch needed anywhere in this phase.
//
// IMPORTANT scope of what this actually shares: an AsyncLocalStorage
// instance only carries context within one continuous call stack. Per
// Next.js's own Proxy docs (node_modules/next/dist/docs/.../proxy.md -
// "Proxy is meant to be invoked separately of your render code... you
// should not attempt relying on shared modules or globals"), Proxy
// (proxy.ts) and a route handler are NOT one continuous execution - a
// `.run()` scope entered inside proxy.ts does not extend into the route
// handler Next.js later dispatches to. The requestId crosses that boundary
// via the `X-Request-Id` *request header* instead (which proxy.ts
// forwards - see proxy.ts), not via this store: a route handler that wants
// getRequestId() to work for its own nested calls (lib/data/*, lib/ai/*,
// ...) needs to open its own runWithRequestContext() scope, seeded from
// that forwarded header, at the top of its own handler body - not assume
// proxy.ts's scope already covers it.
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` available to any code inside it via getRequestId(). */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Reads the current request's ID, if any. Safe to call from anywhere -
 * returns undefined (never throws) when called outside a
 * runWithRequestContext() scope.
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
