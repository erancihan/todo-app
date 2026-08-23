/**
 * Daybook's service worker — the shell, offline.
 *
 * The data was never the problem: it lives in OPFS and the engine is wasm in the
 * page, so the app is already offline-first once loaded. What a cold start needs
 * is the *shell* — HTML, JS, CSS, the wasm binary, the sqlite worker — and that
 * is all this does.
 *
 * ## Why cache-on-fetch rather than a precache manifest
 *
 * Vite content-hashes every asset, so a hand-written precache list goes stale on
 * the next build and a generated one means a build plugin. Caching same-origin
 * GETs as they are fetched needs neither, and it cannot list a file that no
 * longer exists. The cost is that the very first visit must be online — which it
 * has to be anyway, to download the app at all.
 */

const CACHE = "daybook-shell-v1";

self.addEventListener("install", (event) => {
  // The document itself is worth having before anything else asks for it: a
  // navigation is the one request that cannot fall back to "try again online".
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/", "/index.html", "/manifest.webmanifest"]))
      .catch(() => {
        // A failed precache must not fail the install, or the worker never
        // activates and the app loses offline support entirely over one 404.
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      // Hashed filenames mean old entries are never requested again but still
      // occupy quota, so a version bump drops the whole previous cache.
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A navigation always tries the network first, so a deploy is picked up on the
  // next load rather than being pinned until the cache is cleared; offline it
  // falls back to the cached document.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(() => caches.match("/index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Everything else is content-hashed or immutable enough to serve from cache
  // first, revalidating in the background so a change lands on the visit after.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
