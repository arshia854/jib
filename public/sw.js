// Bumped to v2: app/icon.svg and public/icons/*.png changed (amber ->
// yellow, and the PWA icons now actually use the jib mark instead of the
// old unrelated wallet-card art). /icons/* is cached cache-first below with
// no revalidation, so already-installed users would otherwise keep seeing
// the stale icon forever - bumping this version forces activate() to drop
// the old STATIC_CACHE and refetch.
const CACHE_VERSION = "jeeb-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Sent by the logout flow (see components/layout/logout-button.tsx) so a
// signed-out session doesn't leave the previous user's cached authenticated
// pages (dashboard, transactions, reports, ...) readable on a shared device.
// Only clears PAGES_CACHE - STATIC_CACHE (content-hashed build assets/icons)
// is unrelated to any user's data and is left untouched. Replies on the
// provided MessagePort so the caller can await completion before navigating
// away, instead of racing the cache clear against the redirect.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CLEAR_AUTH_CACHE") return;
  event.waitUntil(
    caches.delete(PAGES_CACHE).then(() => {
      event.ports[0]?.postMessage({ ok: true });
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Build assets and icons are content-hashed/static: cache-first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Full page loads: network-first so data is fresh online, falling back to the
  // last cached copy of that page (or the dashboard) when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(PAGES_CACHE);
          cache.put(request, response.clone());
          return response;
        } catch {
          const cache = await caches.open(PAGES_CACHE);
          const cached = await cache.match(request);
          return cached || (await cache.match("/")) || Response.error();
        }
      })()
    );
  }
});
