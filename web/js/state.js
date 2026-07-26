// Jediný sdílený stav appky — ES moduly jsou singletony, takže tenhle objekt
// je efektivně globální, ale explicitně importovaný (žádné window.* věci).

export const state = {
  MANIFEST: null, GRID: null, ACCURACY: null,
  currentFrame: 0, playing: false, playTimer: null,
  radarOpacity: 0.70,

  map: null, radarOverlayA: null, radarOverlayB: null, radarActiveIsA: true,
  locationMarker: null,
  preloadedImgs: [],

  WU: null, WU_HISTORY: null, wuMarkers: [],
  CHMI: null, chmiMarkers: [], chmiLayer: "temp", CHMI_STATS: null,
  METAR: null,          // letištní stanice doma (doplněk řídké sítě ČHMÚ)
  METAR_WORLD: null,    // dlaždice 10° pro aktuální místo mimo ČR (lazy)
  CHMI_RAIN: null,      // srážkoměrná síť ČHMÚ (436 stanic, jen srážky)
  COTREC: null,         // publikovaná extrapolace ČHMÚ (COTREC) — druhý názor
  ECHOTOP: null,        // výška horní hranice radarového odrazu (hloubka konvekce)
  CHMI_AIR: null,       // měřená kvalita ovzduší (státní síť imisního monitoringu)
  CHMI_AERO: null,      // aerologie — CAPE/CIN z radiosondáží Praha a Prostějov
  CHMI_NORMALS: null,   // klimatické normály 1991–2020 po stanicích
  CHMI_TEXT: null,      // oficiální textová předpověď ČHMÚ
  CHMI_REGIONAL: null,  // areálové průměry po krajích 1961→dnes + normály
  worldTempMarkers: [], // popisky teplot na mapě (worldtemp.js)
  // Vypínač popisků stanic (tlačítko Teploty). Vlastníkem logiky je
  // worldtemp.js; tady je jen výchozí hodnota, protože renderChmiMarkers()
  // běží dřív než initWorldTemps() a musí už vědět, jestli kreslit.
  tempsOn: (() => {
    try { const v = localStorage.getItem("nowcast_temps_on"); return v === null ? true : v === "1"; }
    catch { return true; }
  })(),

  warningsLayerGroup: null,
  stormLayer: null,      // dráhy bouřkových buněk (stormtrack.js)
  accumMode: false, accumLayer: null,   // úhrnová mapa 24 h (accum.js)

  globalMode: false, rvFrames: [], rvT0idx: 0, rvLayer: null,

  currentLat: null, currentLon: null, currentLabel: null,
  fc24Ctrl: null, verdictCtrl: null,

  // Světový režim: místo mimo pokrytí českého radaru → RainViewer + model.
  // tz = časová zóna vybraného místa (z Open-Meteo timezone=auto) — všechny
  // zobrazované časy jedou v místním čase daného místa, ne natvrdo v Praze.
  inCZ: true, tz: "Europe/Prague",
  elevation: null,      // nadm. výška vybraného místa (Open-Meteo) — výšková korekce stanic
  _globalRadar: null,   // navzorkované RainViewer dlaždice (globalrain.js)
  _autoGlobal: false,   // globální radar zapnutý automaticky (ne uživatelem)

  pushSubscribed: false,
};

export const PLAY = {
  intervalMs: 500,
  t0PauseMs: 1200,
  endPauseMs: 1800,
};

export const AUTO_REFRESH_MS = 5 * 60 * 1000;

// Cloudflare Worker base URL. Subdoména *.workers.dev je specifická pro daný
// CF účet a nedá se odvodit ze jména workeru samotného — pokud se liší,over
// oprav (nebo přepiš přes <meta name="worker-base" content="...">, viz níže).
const metaWorkerBase = document.querySelector('meta[name="worker-base"]')?.content;
export const WORKER_BASE = metaWorkerBase || "https://nowcast-narrate.kubajzek.workers.dev";
