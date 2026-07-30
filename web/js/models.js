// Předpověď z 9 modelů + hodnocení přesnosti PRO KONKRÉTNÍ MÍSTO.
//
// Inspirace: Počasí Meteo staví na "9 modelech s hodnocením kvality" — my to
// děláme osobněji a poctivěji: při každé návštěvě si uložíme, co jednotlivé
// modely slibovaly na příští hodiny (localStorage), a při dalších návštěvách
// ty sliby porovnáme se SKUTEČNÝM měřením nejbližší meteostanice (ČHMÚ, WU
// i letištní METAR do 40 km, čerstvé ≤ 2 h). Z toho roste klouzavá MAE per model per místo
// — žebříček modelů přesně pro tvůj kopec, ne krajský průměr. Bez stanice
// poblíž se hodnocení neučí (žádná náhradní "pravda" se nevymýšlí).

import { state, WORKER_BASE } from "./state.js";
import { esc, haversine, ageMinutes, nowLocStr, locDateStr } from "./utils.js";

export const MODELS = [
  ["icon_d2",              "ICON-D2", "DWD · 2 km, ČR"],   // nejvyšší rozlišení pro Česko
  ["icon_seamless",        "ICON",    "DWD · Německo"],
  ["ecmwf_ifs025",         "ECMWF",   "Evropa (IFS)"],
  ["gfs_seamless",         "GFS",     "NOAA · USA"],
  ["meteofrance_seamless", "ARPEGE",  "Météo-France"],
  ["ukmo_seamless",        "UKMO",    "Met Office · UK"],
  ["gem_seamless",         "GEM",     "ECCC · Kanada"],
  ["jma_seamless",         "JMA",     "Japonsko"],
  ["knmi_seamless",        "KNMI",    "Harmonie · NL"],
  ["dmi_seamless",         "DMI",     "Harmonie · Dánsko"],
];

// ALADIN/ČHMÚ není v Open-Meteo — stahuje se zvlášť z data/aladin.json
// (pipeline/aladin.py z opendata GRIB). Meta drží stejný tvar jako MODELS.
const ALADIN = ["aladin_chmi", "ALADIN", "ČHMÚ · 1 km"];
function metaFor(id) {
  return MODELS.find(m => m[0] === id) || (id === ALADIN[0] ? ALADIN : [id, id, ""]);
}

const STORE_KEY = "nowcast_model_scores_v1";
const SNAP_MIN_AGE_H = 3;    // predikci hodnotíme až po ≥ 3 h (jinak je to opis)
const SNAP_MAX_AGE_H = 30;   // starší sliby už nemá s čím poctivě srovnat
const SCORE_WINDOW = 40;     // klouzavé okno vzorků per model
const MIN_SAMPLES = 3;       // od kolika vzorků ukazovat žebříček

function locKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}
function saveStore(s) {
  try {
    const keys = Object.keys(s);
    if (keys.length > 8) { // drž jen posledních 8 míst
      keys.sort((a, b) => (s[a].t || 0) - (s[b].t || 0));
      for (const k of keys.slice(0, keys.length - 8)) delete s[k];
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* plné úložiště nevadí — hodnocení je bonus */ }
}

// Nejbližší stanice s čerstvou teplotou — "pravda" pro verifikaci.
//
// Dosah 40 km, ne 15: ČHMÚ publikuje jen ~40 profesionálních stanic na celou
// ČR (rozestup ~50 km), takže s 15km limitem se žebříček přesnosti NIKDY
// nerozjel skoro nikde — třeba v Rychvaldu u Ostravy je nejbližší stanice
// ~20 km daleko a panel navždy hlásil "0/3".
//
// Cenou za větší dosah je výškový rozdíl (stanice na kopci měří jinak než
// obec v údolí), proto teplotu přepočítáme standardním gradientem 0,65 °C
// na 100 m na nadmořskou výšku vybraného místa (state.elevation z Open-Meteo).
//
// POZOR, ten přepočet je aproximace, ne fyzikální jistota. Gradient 0,65 °C/100 m
// platí pro promíchanou atmosféru (běžný slunečný den). Při TEPLOTNÍ INVERZI —
// jasná noc, mlha v kotlině, zimní situace — je gradient obrácený: nahoře je
// tepleji než dole. Tehdy přepočet výsledek ZHORŠÍ. Proto:
//   * pod 50 m rozdílu nepřepočítáváme vůbec (je to v šumu měření),
//   * nad 800 m rozdílu stanici radši nepoužijeme — extrapolovat přes takový
//     převýšení je hádání, ne měření.
// Se 296 teplotními stanicemi ČHMÚ (dřív 40) je navíc nejbližší stanice
// obvykle tak blízko, že korekce vyjde skoro nulová a celý problém mizí.
const STATION_MAX_KM = 40;
const LAPSE_C_PER_M = 0.0065;
const LAPSE_MIN_DZ = 50;    // menší rozdíl nemá cenu přepočítávat
const LAPSE_MAX_DZ = 800;   // větší převýšení = stanice není reprezentativní

export function nearestFreshStation(lat, lon) {
  const all = [...(state.CHMI?.stations || []), ...(state.WU?.stations || []),
    ...(state.METAR?.stations || []), ...(state.METAR_WORLD?.stations || []),
    ...(state.EURO?.stations || [])];
  // Nevybíráme čistě nejbližší, ale nejbližší ROZUMNOU. Stanice na hřebeni
  // 6 km daleko a o 550 m výš je pro teplotu v údolí horší referencí než
  // stanice 12 km daleko ve stejné výšce — a čím míň se musí přepočítávat,
  // tím míň se dá zkazit. 50 m převýšení ≈ 1 km vzdálenosti.
  const ELEV_PENALTY_PER_M = 1 / 50;
  const here = state.elevation;
  let best = null, bd = Infinity, bestScore = Infinity;
  for (const s of all) {
    if (s.temp == null || s.lat == null) continue;
    // Bóje měří nad vodou. Jako tečka na mapě je to poctivé měření, ale jako
    // reference pro souš by lhala — moře je v létě chladnější a v zimě teplejší
    // než pevnina pár kilometrů odtud, a tenhle rozdíl by se propsal do
    // hodnocení modelů i do kontroly biasu jako jejich chyba.
    if (s.source === "ndbc") continue;
    const age = ageMinutes(s.time_utc);
    if (age == null || age > 120) continue;  // ČHMÚ jede po hodinách — 90 min bylo těsné
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d > STATION_MAX_KM) continue;
    const dzAbs = (here != null && s.elev != null) ? Math.abs(here - s.elev) : 0;
    const score = d + dzAbs * ELEV_PENALTY_PER_M;
    if (score < bestScore) { bestScore = score; bd = d; best = s; }
  }
  if (!best) return null;

  const elevHere = state.elevation;
  const dz = (elevHere != null && best.elev != null) ? elevHere - best.elev : 0;
  if (Math.abs(dz) > LAPSE_MAX_DZ) return null;   // radši nic než hádání
  // Malý rozdíl neopravujeme — přepočet o 0,2 °C jen předstírá přesnost.
  const tempAdj = Math.abs(dz) < LAPSE_MIN_DZ
    ? best.temp
    : Math.round((best.temp - dz * LAPSE_C_PER_M) * 10) / 10;
  return { ...best, distKm: bd, tempAdj, elevDiff: dz,
           lapseApplied: Math.abs(dz) >= LAPSE_MIN_DZ };
}

async function fetchModels(lat, lon, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&hourly=temperature_2m,precipitation&models=${MODELS.map(m => m[0]).join(",")}`
    + `&forecast_days=2&timezone=auto`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// per-model řada { isoHour: temp } z multi-model odpovědi
function modelSeries(data) {
  const h = data.hourly || {};
  const times = h.time || [];
  const out = {};
  for (const [id] of MODELS) {
    // multi-model odpověď suffixuje klíče (temperature_2m_icon_seamless…);
    // model bez pokrytí místa suffixovaný klíč nemá / má samé nully
    const arr = h[`temperature_2m_${id}`];
    if (!arr || !arr.some(v => v != null)) continue;
    const m = {};
    for (let i = 0; i < times.length; i++) if (arr[i] != null) m[times[i]] = arr[i];
    out[id] = m;
  }
  return out;
}

// ── Verifikace: srovnej staré sliby s aktuálním měřením stanice ─────────────
function verifyAndSnapshot(lat, lon, series) {
  const key = locKey(lat, lon);
  const store = loadStore();
  const rec = store[key] || { t: 0, scores: {}, snaps: [] };
  const now = Date.now();
  const nowHour = nowLocStr(); // "YYYY-MM-DDTHH:00" v zóně místa

  const fresh = [];          // nová pozorování → posílají se i na server
  const st = nearestFreshStation(lat, lon);
  if (st) {
    for (const snap of rec.snaps) {
      const ageH = (now - snap.t) / 3600000;
      if (ageH < SNAP_MIN_AGE_H || ageH > SNAP_MAX_AGE_H) continue;
      const preds = snap.h?.[nowHour];
      if (!preds || snap.done?.includes(nowHour)) continue;
      for (const [id, temp] of Object.entries(preds)) {
        const sc = rec.scores[id] || { errs: [] };
        // tempAdj = měření stanice přepočtené na nadmořskou výšku místa.
        // Ukládá se chyba SE ZNAMÉNKEM: absolutní hodnota řekne "jak moc",
        // ale ne "na kterou stranu" — a právě to druhé jde odečíst.
        const err = Math.round((temp - (st.tempAdj ?? st.temp)) * 10) / 10;
        sc.errs.push(err);
        if (sc.errs.length > SCORE_WINDOW) sc.errs = sc.errs.slice(-SCORE_WINDOW);
        rec.scores[id] = sc;
        fresh.push({ model: id, err });
      }
      (snap.done = snap.done || []).push(nowHour);
    }
  }

  // Nový snapshot: sliby všech modelů na příštích 24 h (zaokrouhleně, ať je malý).
  //
  // Iteruje se přes series, NE přes MODELS: ALADIN je definovaný zvlášť (není
  // z Open-Meteo), takže procházení MODELS ho tiše vynechalo — do snapshotu se
  // nikdy nedostal, nikdy nenasbíral jedinou chybu a v žebříčku proto věčně
  // svítil "0/3" a padal na konec, protože se řadí podle (mae ?? 99).
  const snapH = {};
  for (const id of Object.keys(series)) {
    const s = series[id];
    if (!s) continue;
    for (const [iso, t] of Object.entries(s)) {
      if (iso <= nowHour) continue;
      (snapH[iso] = snapH[iso] || {})[id] = Math.round(t * 10) / 10;
    }
  }
  rec.snaps.push({ t: now, h: snapH, done: [] });
  rec.snaps = rec.snaps.filter(sn => (now - sn.t) / 3600000 <= SNAP_MAX_AGE_H).slice(-10);
  rec.t = now;
  store[key] = rec;
  saveStore(store);
  // Sdílení je best-effort a nesmí zdržet vykreslení — proto bez await.
  if (fresh.length) void pushObservations(lat, lon, fresh);
  return rec.scores;
}

// ── Sdílené učení: pozorování ven, agregovaná skóre zpět ────────────────────
//
// Lokální localStorage je rychlý a funguje offline, ale učí jen tenhle
// prohlížeč. Server drží běžící součty po buňkách ~20 km, takže se učí
// aplikace jako celek a nový uživatel nezačíná od nuly.

async function pushObservations(lat, lon, obs) {
  try {
    await fetch(`${WORKER_BASE}/model-obs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, obs }),
    });
  } catch { /* učení je bonus, ne podmínka funkčnosti */ }
}

let _sharedCache = new Map();   // locKey → { t, models }
const SHARED_TTL_MS = 10 * 60 * 1000;

export async function fetchSharedScores(lat, lon) {
  const key = locKey(lat, lon);
  const hit = _sharedCache.get(key);
  if (hit && Date.now() - hit.t < SHARED_TTL_MS) return hit.models;
  try {
    const r = await fetch(`${WORKER_BASE}/model-scores?lat=${lat}&lon=${lon}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const models = j?.models || {};
    _sharedCache.set(key, { t: Date.now(), models });
    return models;
  } catch {
    return hit?.models || {};
  }
}

/**
 * Sloučí lokální a sdílená skóre.
 *
 * Lokální vzorky mají vyšší váhu — jsou z TOHOHLE místa a téhle stanice,
 * kdežto sdílená jsou z celé buňky ~20 km. Sdílená ale přebírají, dokud
 * lokálních není dost, takže žebříček dává smysl hned při první návštěvě.
 */
export function mergeScores(localScores, shared) {
  const out = {};
  const ids = new Set([...Object.keys(localScores || {}), ...Object.keys(shared || {})]);
  for (const id of ids) {
    const errs = localScores?.[id]?.errs || [];
    const nL = errs.length;
    const sh = shared?.[id];
    const nS = sh?.n || 0;
    if (!nL && !nS) continue;

    const maeL = nL ? errs.reduce((a, b) => a + Math.abs(b), 0) / nL : null;
    const biasL = nL ? errs.reduce((a, b) => a + b, 0) / nL : null;

    // Váha lokálních vzorků je trojnásobná — jsou z přesně toho místa.
    const wL = nL * 3, wS = nS;
    const wTot = wL + wS;
    out[id] = {
      n: nL, nShared: nS,
      mae: wTot ? Math.round(((maeL ?? 0) * wL + (sh?.mae ?? 0) * wS) / wTot * 10) / 10 : null,
      bias: wTot ? Math.round(((biasL ?? 0) * wL + (sh?.bias ?? 0) * wS) / wTot * 10) / 10 : null,
      local: nL, shared: nS,
    };
  }
  return out;
}

/**
 * Konsenzus modelů vážený naměřenou přesností.
 *
 * Místo "tady máš deset čísel, vyber si" spočítá jedno, kde má lepší model
 * větší slovo. Váha 1/(MAE+0.5)² je klasické inverse-error vážení; +0,5
 * brání tomu, aby model s jedním šťastným vzorkem dostal nekonečnou váhu.
 *
 * Zároveň se odečítá bias — systematickou odchylku známe a nechat ji
 * v čísle by byla škoda.
 *
 * Vrací null, dokud není aspoň MIN_BLEND_MODELS modelů s hodnocením;
 * bez měření by to byl jen převlečený průměr.
 */
export const MIN_BLEND_MODELS = 3;

export function blendTemperature(values, scores) {
  let wsum = 0, vsum = 0, used = 0, rawSum = 0, raw = 0;
  for (const [id, v] of Object.entries(values || {})) {
    if (v == null || !Number.isFinite(v)) continue;
    raw++; rawSum += v;
    const sc = scores?.[id];
    const n = (sc?.n || 0) + (sc?.nShared || 0);
    if (!sc || sc.mae == null || n < 2) continue;
    const corrected = v - (sc.bias || 0);
    const w = 1 / Math.pow((sc.mae || 0) + 0.5, 2);
    wsum += w; vsum += corrected * w; used++;
  }
  if (used < MIN_BLEND_MODELS) {
    return raw ? { value: null, plain: Math.round(rawSum / raw * 10) / 10, used: 0 } : null;
  }
  return {
    value: Math.round((vsum / wsum) * 10) / 10,
    plain: Math.round(rawSum / raw * 10) / 10,
    used,
  };
}

function mae(errs) {
  return Math.round(errs.reduce((a, b) => a + b, 0) / errs.length * 10) / 10;
}

// ── Konsenzus: jedno číslo místo deseti ────────────────────────────────────
function renderBlend(blend, rows) {
  const el = document.getElementById("blend-card");
  if (!el) return;
  el.classList.remove("show");
  el.innerHTML = "";
  if (!blend) return;

  if (blend.value == null) {
    // Ještě se učíme — ukaž prostý průměr a řekni, že to zatím není vážené.
    if (blend.plain == null) return;
    el.innerHTML =
      `<b>Konsenzus modelů:</b> ${Math.round(blend.plain)} °C ` +
      `<span class="muted">prostý průměr ${rows.length} modelů — vážený podle ` +
      `naměřené přesnosti bude, až se nasbírá dost porovnání se stanicí.</span>`;
    el.classList.add("show");
    return;
  }

  const diff = blend.plain != null ? blend.value - blend.plain : 0;
  const shift = Math.abs(diff) >= 0.3
    ? ` <span class="muted">(prostý průměr by řekl ${Math.round(blend.plain)} °C — ` +
      `rozdíl dělá váha přesnějších modelů a odečtená systematická chyba)</span>`
    : "";
  el.innerHTML =
    `<b>Konsenzus modelů:</b> ${Math.round(blend.value)} °C ` +
    `<span class="muted">vážený přesností ${blend.used} ` +
    `${blend.used < 5 ? "modelů" : "modelů"} pro tohle místo</span>${shift}`;
  el.classList.add("show");
}

// ── ALADIN/ČHMÚ z data/aladin.json — nejbližší bod → hodinová řada ──────────
// Klíče (lokální hodina "YYYY-MM-DDTHH:00") ladí s Open-Meteo časy, takže
// ALADIN zapadne do stejného prostoru jako ostatní modely.
let _aladinCache = undefined; // undefined = nenačteno, null = nedostupné

async function loadAladin() {
  if (_aladinCache !== undefined) return _aladinCache;
  try {
    const r = await fetch(`data/aladin.json?v=${Math.floor(Date.now() / 3.6e6)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const a = await r.json();
    // starší než 18 h = běh vypadl, nepoužívej
    if (Date.now() - new Date(a.run_utc).getTime() > 18 * 3.6e6) throw new Error("starý běh");
    _aladinCache = a;
  } catch { _aladinCache = null; }
  return _aladinCache;
}

function localHourKey(ms) {
  const s = new Date(ms).toLocaleString("sv-SE", { timeZone: state.tz });
  return s.slice(0, 10) + "T" + s.slice(11, 13) + ":00"; // "2026-07-20T14:00"
}

// { temp: {iso: °C}, precip: {iso: mm} } pro nejbližší ALADIN bod, nebo null
async function aladinSeries(lat, lon) {
  const a = await loadAladin();
  if (!a?.pts?.length) return null;
  let best = 0, bd = Infinity;
  for (let i = 0; i < a.pts.length; i++) {
    const d = (a.pts[i][0] - lat) ** 2 + (a.pts[i][1] - lon) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  if (bd > 0.3 * 0.3) return null; // > ~30 km od mřížky ČR → mimo ALADIN
  const t = a.temp?.[String(best)];
  if (!t) return null;
  const p = a.precip?.[String(best)] || null;
  const start = new Date(a.start_utc).getTime();
  const temp = {}, precip = {};
  for (let i = 0; i < t.length; i++) {
    const iso = localHourKey(start + i * 3.6e6);
    if (t[i] != null) temp[iso] = t[i];
    if (p && p[i] != null) precip[iso] = p[i];
  }
  return { temp, precip };
}

// ── Shoda modelů → chip důvěry v hlavní kartě ───────────────────────────────
function renderConfidence(rows) {
  const el = document.getElementById("confidence-chip");
  if (!el) return;
  const temps = rows.map(r => r.tmax).filter(v => v != null);
  if (temps.length < 3) { el.classList.remove("show"); return; }
  const spread = Math.max(...temps) - Math.min(...temps);       // °C rozptyl maxim
  const wetFrac = rows.filter(r => r.rain >= 0.2).length / rows.length; // podíl "prší"
  const rainSplit = wetFrac > 0.2 && wetFrac < 0.8;             // neshoda na dešti?

  let level, cls, txt;
  if (spread <= 2 && !rainSplit) { level = "vysoká"; cls = "high"; txt = "modely se shodují"; }
  else if (spread <= 4 && !rainSplit) { level = "střední"; cls = "mid"; txt = `teploty ±${Math.round(spread)} °C`; }
  else { level = "nižší"; cls = "low"; txt = rainSplit ? "modely se neshodují na srážkách" : `rozptyl teplot ±${Math.round(spread)} °C`; }

  el.className = `confidence-chip show ${cls}`;
  el.title = `Rozptyl denních maxim mezi ${rows.length} modely: ${spread.toFixed(1)} °C; `
    + `srážky předpovídá ${Math.round(wetFrac * 100)} % modelů.`;
  el.innerHTML = `<span class="cf-dot"></span>Jistota výhledu: <b>${level}</b> · ${esc(txt)}`;
}

// ── Panel "Modely pro tohle místo" ──────────────────────────────────────────
export async function renderModelsPanel(lat, lon, signal) {
  const panel = document.getElementById("models-panel");
  if (!panel) return;
  try {
    const data = await fetchModels(lat, lon, signal);
    const series = modelSeries(data);
    const h = data.hourly || {};
    const times = h.time || [];

    // srážková řada per Open-Meteo model (zarovnaná na times → {iso: mm})
    const precipSeries = {};
    for (const id of Object.keys(series)) {
      const arr = h[`precipitation_${id}`];
      if (!arr) continue;
      const m = {};
      for (let i = 0; i < times.length; i++) if (arr[i] != null) m[times[i]] = arr[i];
      precipSeries[id] = m;
    }

    // ALADIN/ČHMÚ (mimo Open-Meteo) — přidej jako plnohodnotný model
    const ala = state.inCZ ? await aladinSeries(lat, lon) : null;
    if (ala) { series[ALADIN[0]] = ala.temp; precipSeries[ALADIN[0]] = ala.precip; }

    const ids = Object.keys(series);
    if (ids.length < 3) { panel.classList.remove("show"); return; }
    // mezitím se mohlo přepnout místo
    if (state.currentLat?.toFixed(4) !== lat.toFixed(4)) return;

    const localScores = verifyAndSnapshot(lat, lon, series);
    // Sdílená skóre ze serveru — bez nich by nový uživatel viděl prázdný
    // žebříček, i když se aplikace pro jeho okolí už dávno naučila.
    const shared = await fetchSharedScores(lat, lon);
    const scores = mergeScores(localScores, shared);

    // dnešek per model: max teplota + úhrn srážek — obojí z {iso: hodnota} řad,
    // takže ALADIN (jiný zdroj) se počítá úplně stejně jako Open-Meteo modely
    const today = locDateStr();
    const rows = ids.map(id => {
      const meta = metaFor(id);
      let tmax = null, rain = 0;
      for (const iso of Object.keys(series[id])) {
        if (!iso.startsWith(today)) continue;
        const t = series[id][iso];
        if (t != null && (tmax == null || t > tmax)) tmax = t;
        rain += precipSeries[id]?.[iso] ?? 0;
      }
      const sc = scores[id];
      const nTot = (sc?.n || 0) + (sc?.nShared || 0);
      return { id, label: meta[1], src: meta[2], tmax, rain,
        mae: sc && nTot >= MIN_SAMPLES ? sc.mae : null,
        bias: sc && nTot >= MIN_SAMPLES ? sc.bias : null,
        n: nTot, nLocal: sc?.n || 0, nShared: sc?.nShared || 0 };
    }).filter(r => r.tmax != null);
    if (rows.length < 3) { panel.classList.remove("show"); return; }

    // Shoda modelů = důvěra ve výhled. Když se 9 modelů shodne na teplotě i
    // na tom, jestli prší, je jistota vysoká; když se rozcházejí, řekni to.
    renderConfidence(rows);

    // Konsenzus vážený naměřenou přesností + odečtený bias. Tohle je to
    // jediné číslo, které z celého žebříčku uživatele opravdu zajímá.
    const blend = blendTemperature(
      Object.fromEntries(rows.map(r => [r.id, r.tmax])), scores);
    renderBlend(blend, rows);

    const ranked = rows.some(r => r.mae != null);
    rows.sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99) || a.label.localeCompare(b.label));

    const body = rows.map((r, i) => `
      <div class="mdl-row${i === 0 && ranked && r.mae != null ? " best" : ""}">
        <span class="mdl-medal">${ranked && r.mae != null && i < 3 ? `<span class="mdl-rank r${i + 1}">${i + 1}</span>` : ""}</span>
        <span class="mdl-name" title="${esc(r.src)}">${esc(r.label)}</span>
        <span class="mdl-tmax">${Math.round(r.tmax)}°</span>
        <span class="mdl-rain">${r.rain >= 0.2 ? `${Math.round(r.rain * 10) / 10} mm` : "—"}</span>
        <span class="mdl-mae" title="${r.bias != null
          ? `systematická odchylka ${r.bias > 0 ? "+" : ""}${String(r.bias).replace(".", ",")} °C`
          : ""}">${r.mae != null
            ? `±${String(r.mae).replace(".", ",")}°${Math.abs(r.bias ?? 0) >= 0.5
              ? `<i class="mdl-bias">${r.bias > 0 ? "▲" : "▼"}</i>` : ""}`
            : `<i title="učí se z měření stanice">${r.n}/${MIN_SAMPLES}</i>`}</span>
      </div>`).join("");

    const st = nearestFreshStation(lat, lon);
    const stStr = st ? `${esc(st.name)} (${st.distKm.toFixed(0)} km${
      Math.abs(st.elevDiff || 0) >= 100 ? `, přepočet na výšku ${Math.round(st.elevDiff > 0 ? st.elevDiff : -st.elevDiff)} m` : ""})` : "";
    const sharedN = rows.reduce((a, r) => a + (r.nShared || 0), 0);
    const note = ranked
      ? `Přesnost = průměrná chyba slibované teploty proti měření stanice ${stStr}.` +
        (sharedN ? ` Učí se i ze zkušeností ostatních v okolí (${sharedN} vzorků).` : "") +
        ` ▲/▼ značí, že model systematicky přestřeluje / podstřeluje.`
      : st
        ? `Žebříček se učí: při každé návštěvě porovnám starší sliby modelů s měřením stanice ${stStr}. Potřebuje pár návštěv v odstupu aspoň 3 h.`
        : `V okruhu ${STATION_MAX_KM} km není čerstvě hlásící meteostanice, takže přesnost modelů tu nejde poctivě ověřit — ukazuji jen dnešní předpovědi.`;

    panel.innerHTML = `
      <div class="mdl-title">Modely pro tohle místo <span class="mdl-sub">${rows.length} modelů · dnes max / srážky / přesnost</span></div>
      <div class="mdl-head"><span></span><span>model</span><span>max</span><span>déšť</span><span>chyba</span></div>
      ${body}
      <div class="mdl-note">${note}</div>`;
    panel.classList.add("show");
  } catch (e) {
    if (e.name !== "AbortError") panel.classList.remove("show");
  }
}
