const CACHE_VERSION = "v4";
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
  "./js/extras.js",
  "./js/skeleton.js",
  "./js/climate.js",
  "./js/lightning.js",
  "./icon.svg",
  "./icons/icon-192.png",
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

  // VŠECHNO same-origin je network-first s fallbackem na cache.
  // Dřív byly statické soubory cache-first — to appku "zamrazilo" na verzi
  // z prvního načtení a deploye se k uživatelům nedostaly, dokud neumřela
  // cache. Offline režim funguje dál (fallback), jen za cenu, že online
  // se vždy sáhne na síť (GitHub Pages má stejně krátké HTTP cache).
  const cacheName = url.pathname.includes("/data/") ? DATA_CACHE : STATIC_CACHE;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(cacheName).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Web Push ──────────────────────────────────────────────────────────────────
// Worker posílá šifrovaný JSON payload (RFC 8291): {title, body, tag}.
// Fallback na generické oznámení, kdyby payload chyběl nebo se nešel přečíst.
self.addEventListener("push", e => {
  let payload = null;
  try { payload = e.data?.json(); } catch { /* prázdný/nečitelný payload */ }
  const title = payload?.title || "🌧️ nowcast";
  const options = {
    body: payload?.body || "Kontrola oblíbených míst — možná se blíží déšť nebo platí výstraha.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: payload?.tag || "nowcast-rain-check",
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
