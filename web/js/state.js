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

  warningsLayerGroup: null,

  globalMode: false, rvFrames: [], rvT0idx: 0, rvLayer: null,

  currentLat: null, currentLon: null, currentLabel: null,
  fc24Ctrl: null, verdictCtrl: null,

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
export const WORKER_BASE = metaWorkerBase || "https://nowcast-narrate.itsjakubmazur.workers.dev";
