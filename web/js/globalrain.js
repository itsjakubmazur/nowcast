// Světový režim vyhodnocení srážek — pro místa mimo pokrytí českého radaru.
//
// Stejná filozofie jako assessRain (verdict.js): radar má pravdu o TEĎ,
// model doplňuje budoucnost. Zdrojem radaru je RainViewer globální kompozit:
// barevné schéma 0 kóduje dBZ přímo v jasu pixelu (dBZ = hodnota/2 − 32),
// takže z dlaždice jde číst skutečná odrazivost — bod i okolí do 12 km,
// úplně stejně jako u českého gridu. Snímky: poslední měřený (t0) + jejich
// nowcast (+10/+20/+30 min); dál než 30 min přebírá model minutely_15.
//
// Vzorkování je async (fetch dlaždic) → výsledek se cachuje ve
// state._globalRadar a synchronní assessRainGlobal() z něj pak čte stejně,
// jako assessRain čte z GRIDu. Když RainViewer selže (CORS, výpadek, místo
// bez radarového pokrytí), spadne se tiše na čistě modelové vyhodnocení.

import { state } from "./state.js";

const RV_API = "https://api.rainviewer.com/public/weather-maps.json";
const ZOOM = 7;              // ~1.2 km/px na rovníku — odpovídá rozlišení radaru
const RAIN_DBZ = 10;         // práh detekce (~0.15 mm/h) — jako DBZ škála CZ
const NEIGH_KM = 12;         // stejné okolí jako assessRain
const MODEL_RAIN_MM_H = 0.2; // stejný práh modelu jako assessRain
const FRESH_MS = 15 * 60000; // jak dlouho vzorkům věřit

// Nad ~70 dBZ už nejde o déšť (kroupy/artefakt) a Z–R vztah přestává platit.
const DBZ_PHYS_MAX = 70;
const MMH_CAP = 150; // víc než přívalová průtrž radar stejně neumí kvantifikovat

// Dekódování pixelu BW schématu (color 0) podle oficiální RainViewer spec:
//   dBZ = (R & 127) − 32;  bit 128 v R = příznak SNĚHU (ne vyšší intenzita!)
// Dřívější lineární čtení R/2−32 zdvojnásobovalo hodnoty a sněhový bit
// interpretovalo jako extrémní odrazivost — každý mrak pak "lil" 150 mm/h.
export function decodeDbz(r, alpha) {
  if (alpha === 0) return { dbz: -32, snow: false };  // průhledné = bez ozvěny
  const dbz = (r & 127) - 32;
  if (dbz > DBZ_PHYS_MAX) return { dbz: -32, snow: false }; // servisní/artefakt
  return { dbz, snow: (r & 128) === 128 };
}

// Marshall–Palmer Z=200·R^1.6 — stejný převod, jakým ČHMÚ škále rozumí web
// (export kvůli smoke testu stropu — regrese "34 000 mm/h u Bratislavy")
export function dbzToMmh(dbz) {
  const d = Math.min(dbz, DBZ_PHYS_MAX);
  const r = Math.pow(Math.pow(10, d / 10) / 200, 1 / 1.6);
  return Math.round(Math.min(r, MMH_CAP) * 10) / 10;
}

// Přečte dBZ z jedné RainViewer dlaždice: bod + maximum v okolí ≤ 12 km.
// Okolí za hranou dlaždice se zanedbává (clamp) — chyba max. pár km na kraji.
async function sampleTile(host, path, lat, lon) {
  const n = 2 ** ZOOM;
  const latR = lat * Math.PI / 180;
  const xf = (lon + 180) / 360 * n;
  const yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(xf), ty = Math.floor(yf);
  const px = Math.floor((xf - tx) * 256), py = Math.floor((yf - ty) * 256);

  // schéma 0 (dBZ v jasu), options 0_0 = bez vyhlazení, bez sněhové masky
  const r = await fetch(`${host}${path}/256/${ZOOM}/${tx}/${ty}/0/0_0.png`, { mode: "cors" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // colorSpaceConversion: "none" — datová dlaždice nesmí projít color
  // managementem prohlížeče (gamma by posunula hodnoty a rozbila dekódování)
  const bmp = await createImageBitmap(await r.blob(),
    { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, 256, 256).data;

  const kmPerPx = 40075 * Math.cos(latR) / n / 256;
  const rad = Math.min(24, Math.max(2, Math.round(NEIGH_KM / kmPerPx)));
  const at = (x, y) => {
    const xi = Math.max(0, Math.min(255, x)), yi = Math.max(0, Math.min(255, y));
    const o = (yi * 256 + xi) * 4;
    return decodeDbz(img[o], img[o + 3]);
  };
  const center = at(px, py);
  let best = { dbz: -32, snow: false }, bestKm = null;
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const dKm = Math.hypot(dx, dy) * kmPerPx;
      if (dKm > NEIGH_KM) continue;
      const v = at(px + dx, py + dy);
      if (v.dbz > best.dbz) { best = v; bestKm = dKm; }
    }
  }
  return { dbz: center.dbz, dbzNear: best.dbz, nearKm: bestKm, snow: best.snow };
}

let _token = 0;

// Navzorkuje RainViewer pro dané místo a uloží do state._globalRadar.
// Vrací výsledek (nebo null při selhání) — volající pak přerenderuje karty.
export async function prefetchGlobalRadar(lat, lon) {
  const myToken = ++_token;
  try {
    const r = await fetch(RV_API, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const host = data.host;
    const past = data.radar?.past || [];
    const nowc = data.radar?.nowcast || [];
    if (!past.length) throw new Error("bez radarových snímků");

    const frames = [past[past.length - 1], ...nowc];
    const samples = await Promise.all(frames.map(f =>
      sampleTile(host, f.path, lat, lon).then(s => ({ tMs: f.time * 1000, ...s }))));
    if (myToken !== _token) return null; // mezitím se vybralo jiné místo

    state._globalRadar = { lat, lon, fetchedAt: Date.now(), frames: samples };
    return state._globalRadar;
  } catch (e) {
    if (myToken === _token) {
      console.warn("Světový radar (RainViewer):", e);
      state._globalRadar = null;
    }
    return null;
  }
}

// Synchronní vyhodnocení pro světový režim — STEJNÝ tvar výsledku jako
// assessRain: { status, startMs, endMs, peak, total, nearKm, prob,
// radarAgeMin, source }. Ensemble pravděpodobnost mimo ČR nemáme → prob null.
export function assessRainGlobal(minutely) {
  minutely = minutely ?? state._lastMinutely ?? null;
  const now = Date.now();

  const g = state._globalRadar;
  const fresh = g && now - g.fetchedAt < FRESH_MS
    && Math.abs(g.lat - (state.currentLat ?? 99)) < 0.05
    && Math.abs(g.lon - (state.currentLon ?? 999)) < 0.05;

  let radarAgeMin = null;
  if (fresh && g.frames.length) {
    radarAgeMin = Math.max(0, Math.round((now - g.frames[0].tMs) / 60000));
    const idx = g.frames.findIndex(f => f.dbzNear >= RAIN_DBZ);
    if (idx >= 0) {
      let end = idx;
      while (end + 1 < g.frames.length && g.frames[end + 1].dbzNear >= RAIN_DBZ) end++;
      const peak = Math.max(...g.frames.slice(idx, end + 1).map(f => dbzToMmh(f.dbzNear)));
      const centerWet = g.frames[idx].dbz >= RAIN_DBZ;
      const nearKm = centerWet ? 0 : Math.round(g.frames[idx].nearKm ?? 0);
      const startMs = Math.max(g.frames[idx].tMs, idx === 0 ? now : 0);
      const status = startMs <= now ? "raining" : "soon";
      // radar t0 bývá pár minut starý — "prší (ještě ~1 min)" by jen blikalo;
      // když prší teď, drž konec aspoň 10 min před námi
      const endMs = Math.max(g.frames[end].tMs + 10 * 60000,
        status === "raining" ? now + 10 * 60000 : 0);
      // shoda s modelem — stejná argumentace jako v CZ assessRain
      let modelAgrees = null;
      if (minutely?.length) {
        const mi = Math.max(0, Math.floor(((status === "raining" ? now : startMs) - now) / (15 * 60000)));
        const mv = mi < minutely.length ? (minutely[mi]?.precip ?? null) : null;
        modelAgrees = mv == null ? null : mv >= 0.1;
      }
      return { status, startMs: status === "raining" ? now : startMs, endMs,
        peak, total: null, nearKm, prob: null, radarAgeMin, modelAgrees,
        source: nearKm > 0 ? "radar-okolí" : "radar" };
    }
  }

  // Model minutely_15 — bez radaru jediný, s radarem doplněk za horizont
  // +30 min. Prahy a jednotky přesně jako v assessRain (verdict.js), ať se
  // CZ a světový režim chovají na stejném vstupu stejně.
  if (minutely?.length) {
    const idx = minutely.findIndex(m => (m.precip ?? 0) >= MODEL_RAIN_MM_H);
    const peak = Math.max(...minutely.map(m => m.precip ?? 0));
    if (idx === 0) {
      return { status: "raining", startMs: now, endMs: now + 30 * 60000,
        peak, total: null, nearKm: null, prob: null, radarAgeMin, source: "model" };
    }
    if (idx > 0) {
      const startMs = now + idx * 15 * 60000;
      // s čerstvým radarem, který nic nevidí, je model jen "možná";
      // bez radaru je model náš nejlepší zdroj → plnohodnotné "soon"
      return { status: fresh ? "possible" : "soon", startMs, endMs: null,
        peak, total: null, nearKm: null, prob: null, radarAgeMin, source: "model" };
    }
  }

  return { status: "dry", startMs: null, endMs: null, peak: null, total: null,
    nearKm: null, prob: null, radarAgeMin, source: fresh ? "radar+model" : "model" };
}
