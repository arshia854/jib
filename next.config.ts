import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const isDev = process.env.NODE_ENV === "development";

// No nonce here on purpose: nonces (see the CSP guide under
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md)
// require forcing every page to render dynamically and add real complexity
// (proxy.ts changes, threading the nonce through every <script>). Jib has
// no third-party scripts and a self-hosted font, so a static policy from
// next.config.ts is enough for a "fairly tight" CSP without that cost.
// `unsafe-eval` is only added in dev - React needs it there to reconstruct
// server-side error stacks in the browser; neither React nor Next.js use
// `eval` in production.
//
// script-src needs 'unsafe-inline' too (same doc's "Without Nonces" example)
// - without a nonce or SRI, this is the only sanctioned way to allow the
// App Router's own inline `self.__next_f.push(...)` hydration-payload
// <script> tags. Omitting it doesn't just block third-party scripts: the
// browser blocks Next.js's own inline scripts, hydration throws
// (`InvariantError: Expected a request ID to be defined for the document
// via self.__next_r`) partway through, and every client component on the
// page - every button, every onClick/onSubmit - silently never gets its
// event listeners attached. Confirmed with Playwright: with this missing,
// even a plain useState toggle button (no network, no third-party script)
// did nothing on click.
//
// `upgrade-insecure-requests` is dev-excluded too, and for a much sharper
// reason than the "browsers ignore it over plain HTTP" reasoning that used
// to justify sending Strict-Transport-Security unconditionally below: CSP
// directives take effect purely from the header content itself, with no
// gate on the transport that delivered them. Once a page has loaded with
// this directive present, the browser silently rewrites every subsequent
// http:// request *issued from that page* - client-side router
// navigations, RSC data fetches, any fetch()/XHR - to https://, before
// ever sending it. `next dev` only speaks plain HTTP on localhost, so that
// rewritten request hits a TLS handshake against a server that isn't
// listening for one and fails outright (ERR_SSL_PROTOCOL_ERROR), taking
// down every navigation *after* the first page load with it. Confirmed
// with Playwright: a single page staying on-site across a login -> app
// redirect reproduced this exactly (the RSC fetch for the post-login route
// silently upgraded to https and failed); a fresh top-level navigation per
// route did not, since there was no prior same-origin page already
// carrying this CSP to do the rewriting. Real HTTPS deploys want this
// directive (it's what upgrades stray http:// references so they don't
// silently downgrade); dev on plain HTTP actively cannot survive it.
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  ${isDev ? "" : "upgrade-insecure-requests;"}
`
  .replace(/\s{2,}/g, " ")
  .trim();

// style-src needs 'unsafe-inline': the app sets inline `style={{...}}` (e.g.
// per-category colors in components/dashboard/category-breakdown.tsx,
// components/reports/CategoryComparisonBar.tsx) rather than only class
// names, and those render as inline `style` attributes on the element -
// which CSP's style-src also governs, not just <style>/<link> tags. Without
// this, those colors would silently stop applying in browsers that enforce
// the header.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Superseded by the CSP `frame-ancestors` directive above in modern
  // browsers, but kept for older ones that don't support it.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // 2 years, subdomains included, eligible for browser preload lists - only
  // meaningful once the app is actually served over HTTPS in production.
  // Dev-excluded (see the `upgrade-insecure-requests` comment above for why
  // "browsers ignore it over plain HTTP anyway" isn't a safe assumption to
  // lean on for a header in this same block) - a `next dev` server has no
  // TLS listener at all, so there's nothing to gain and, per that same
  // comment, a real cost if any part of this reasoning turns out wrong on
  // some browser/version.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
  { key: "Content-Security-Policy", value: cspHeader },
];

const nextConfig: NextConfig = {
  // DR-1 (docs/roadmap-status.md): required for the Dockerfile's standalone
  // runtime image - `next build` emits a self-contained `.next/standalone`
  // (server.js + only the node_modules files actually traced as needed)
  // instead of assuming a full `node_modules` install exists at runtime.
  // No other build output changes - `next start` (npm run start, used by
  // local dev/the existing test workflow) is unaffected by this flag; only
  // the Dockerfile's runtime stage relies on the standalone folder existing.
  output: "standalone",
  // SEC-11: stop advertising "X-Powered-By: Next.js" on every response.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

// withWorkflow() enables the "use workflow"/"use step" directives (Workflow
// DevKit - lib/workflows/enrich-transaction.ts) and registers its internal
// /.well-known/workflow/* route. proxy.ts's matcher is an explicit allowlist
// that doesn't include that path, so - unlike the catch-all-regex matcher
// the docs warn about - it's not at risk of intercepting it; verified with
// `npx workflow health`, no proxy.ts change needed.
export default withWorkflow(nextConfig);
