const CACHE_VERSION = "v2";
const STATIC_CACHE = `nowcast-static-${CACHE_VERSION}`;
const DATA_CACHE = `nowcast-data-${CACHE_VERSION}`;

// Relativní cesty — funguje jak v rootu domény, tak na GitHub Pages project
// subpath (např. /nowcast/). Absolutní "/index.html" by se tam netrefilo do
// stejné cesty a instalace by tiše selhala (cache.addAll je all-or-nothing).
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/state.js",
  "./js/utils.js",
  "./js/icons.js",
  "./js/theme.js",
  "./js/toast.js",
  "./js/map.js",
  "./js/radar.js",
  "./js/warnings.js",
  "./js/stations.js",
  "./js/forecast.js",
  "./js/verdict.js",
  "./js/favorites.js",
  "./js/search.js",
  "./js/share.js",
  "./icon.svg",
  "./manifest.json",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn("SW install precache selhal:", err))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== STATIC_CACHE && k !== DATA_CACHE)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Externí API (Open-Meteo, RainViewer, geocoding, worker) — network-only.
  if (url.origin !== self.location.origin) {
    return; // necháváme prohlížeči, žádný respondWith = normální síťový fetch
  }

  // Radar PNG snímky a JSON data — network-first, fallback na cache (offline).
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(DATA_CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Statické soubory appky — cache-first.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

// ── Web Push ──────────────────────────────────────────────────────────────────
// Push přijde BEZ payloadu (viz workers/narrate — VAPID bez ECE šifrace), takže
// zobrazíme obecné oznámení; klik otevře appku, která si sama dotáhne aktuální
// stav pro dané místo.
self.addEventListener("push", e => {
  const title = "🌧️ nowcast";
  const options = {
    body: "Kontrola oblíbených míst — možná se blíží déšť nebo platí výstraha.",
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: "nowcast-rain-check",
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
