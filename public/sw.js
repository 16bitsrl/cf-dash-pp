// Dash++ as an installed app. Only the app itself is kept on the device (its code, fonts and
// icons), never the data: domains, records and everything under /api are always read live from
// Cloudflare. Without a connection, pages show an "offline" screen instead of a browser error.

const VERSION = "v1";
const STATIC = `dpp-static-${VERSION}`;
const OFFLINE = "/offline";
const PRECACHE = [OFFLINE, "/icons/icon-192.png", "/logo.svg"];

// Never handled here: data, sign-in and the assistants' endpoint.
const LIVE = [/^\/api\//, /^\/auth\//, /^\/oauth\//, /^\/mcp$/, /^\/\.well-known\//, /^\/connect/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("dpp-") && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || LIVE.some((r) => r.test(url.pathname))) return;

  // Pages: always the latest from the network; the offline screen only when there is no network.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }

  // Built files have their content hash in the name: once stored they never change.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Icons and other images: the stored copy right away, refreshed in the background.
  if (/\.(png|svg|webp|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC).then((c) =>
        c.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res.ok) c.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        }),
      ),
    );
  }
});
