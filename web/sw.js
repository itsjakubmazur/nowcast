const STATIC_CACHE  = "nowcast-static-v1";
const DATA_CACHE    = "nowcast-data-v1";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

// Instalace — předkešuj statiku
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Aktivace — smaž staré cache
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

  // Open-Meteo API — network-only (živá data, nechceme kešovat)
  if (url.hostname.includes("open-meteo.com")) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: "offline" }), {
        headers: { "Content-Type": "application/json" }
      })
    ));
    return;
  }

  // Radar PNG snímky a JSON data — network-first, fallback na cache
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

  // Statické soubory — cache-first
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
