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
import { esc, num, haversine, ageMinutes, nowLocStr, locDateStr } from "./utils.js";
import { panelError } from "./emptystate.js";

// Čtvrtá položka je RODINA, ne provozovatel. Vážený průměr totiž předpokládá
// nezávislé názory, a ty tu nejsou: ICON-D2 a ICON jsou obě DWD nad stejným
// modelem, KNMI a DMI jedou obě HARMONIE-AROME. Průměr z deseti členů je proto
// míň nezávislý, než vypadá — bez korekce by dvojčata přehlasovala samotáře.
// Váha se dělí velikostí rodiny (viz blendTemperature), takže rodina má dohromady
// jeden hlas.
export const MODELS = [
  ["icon_d2",              "ICON-D2", "DWD · 2 km, ČR",  "ICON"],   // nejvyšší rozlišení pro Česko
  ["icon_seamless",        "ICON",    "DWD · Německo",   "ICON"],
  ["ecmwf_ifs025",         "ECMWF",   "Evropa (IFS)",    "IFS"],
  ["gfs_seamless",         "GFS",     "NOAA · USA",      "GFS"],
  ["meteofrance_seamless", "ARPEGE",  "Météo-France",    "ARPEGE"],
  ["ukmo_seamless",        "UKMO",    "Met Office · UK", "UM"],
  ["gem_seamless",         "GEM",     "ECCC · Kanada",   "GEM"],
  ["jma_seamless",         "JMA",     "Japonsko",        "GSM"],
  ["knmi_seamless",        "KNMI",    "Harmonie · NL",   "HARMONIE"],
  ["dmi_seamless",         "DMI",     "Harmonie · Dánsko", "HARMONIE"],
];

// Model, ze kterého appka bere ČÍSLA, která ukazuje.
//
// Hodinová i sedmidenní předpověď jede z Open-Meteo bez parametru models=,
// tedy z jejich "best_match" — ten sám vybírá nejvhodnější model podle
// lokality. Dřív stál mimo tenhle systém: appka pečlivě měřila přesnost
// deseti modelů a hlavní číslo mezi nimi nebylo. Teď se stahuje a hodnotí
// jako každý jiný, takže víme, jak se trefuje TO, co je vidět.
//
// Do konsenzu ale nepatří — je to duplikát některého z modelů výš, ne
// jedenáctý názor. Vlastní rodinu proto nedostává.
export const MAIN_MODEL = ["best_match", "Zobrazená předpověď", "Open-Meteo best_match", null];

// ALADIN/ČHMÚ není v Open-Meteo — stahuje se zvlášť z data/aladin.json
// (pipeline/aladin.py z opendata GRIB). Meta drží stejný tvar jako MODELS.
const ALADIN = ["aladin_chmi", "ALADIN", "ČHMÚ · 1 km", "ALADIN"];
function metaFor(id) {
  return MODELS.find(m => m[0] === id)
    || (id === ALADIN[0] ? ALADIN : id === MAIN_MODEL[0] ? MAIN_MODEL : [id, id, "", id]);
}
function familyOf(id) { return metaFor(id)[3]; }

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
    + `&hourly=temperature_2m,precipitation&models=${[...MODELS.map(m => m[0]), MAIN_MODEL[0]].join(",")}`
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
  for (const [id] of [...MODELS, MAIN_MODEL]) {
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
  // Nejdřív zjisti, kdo se vůbec kvalifikuje — až podle toho se dají spočítat
  // velikosti rodin. Kdyby se rodiny počítaly ze VŠECH modelů, dělilo by se
  // i za členy, kteří do průměru stejně nevstupují.
  const zpusobili = [];
  let rawSum = 0, raw = 0;
  for (const [id, v] of Object.entries(values || {})) {
    if (v == null || !Number.isFinite(v)) continue;
    // Zobrazená předpověď je duplikát některého z modelů, ne další názor —
    // do konsenzu by se započítala dvakrát.
    if (id === MAIN_MODEL[0]) continue;
    raw++; rawSum += v;
    const sc = scores?.[id];
    const n = (sc?.n || 0) + (sc?.nShared || 0);
    if (!sc || sc.mae == null || n < 2) continue;
    zpusobili.push({ id, v, sc, fam: familyOf(id) || id });
  }

  const velikost = {};
  for (const m of zpusobili) velikost[m.fam] = (velikost[m.fam] || 0) + 1;

  let wsum = 0, vsum = 0;
  for (const m of zpusobili) {
    const corrected = m.v - (m.sc.bias || 0);
    // Váha 1/(MAE+0.5)² je klasické inverse-error vážení; dělení velikostí
    // rodiny drží dvojčatům dohromady jeden hlas.
    const w = (1 / Math.pow((m.sc.mae || 0) + 0.5, 2)) / velikost[m.fam];
    wsum += w; vsum += corrected * w;
  }

  const used = zpusobili.length;
  const rodin = Object.keys(velikost).length;
  if (used < MIN_BLEND_MODELS) {
    return raw ? { value: null, plain: Math.round(rawSum / raw * 10) / 10, used: 0, rodin: 0 } : null;
  }
  return {
    value: Math.round((vsum / wsum) * 10) / 10,
    plain: Math.round(rawSum / raw * 10) / 10,
    used, rodin,
  };
}

/**
 * Konsenzus SRÁŽEK — shoda, ne průměr.
 *
 * Srážky se nesmí průměrovat jako teplota: průměr dvou modelů, kde jeden
 * říká 0 mm a druhý 10, dá 5 mm — scénář, který nenastane ani u jednoho.
 * Užitečná odpověď u srážek proto není lepší číslo, ale míra shody a rozsah
 * scénářů. Rodiny se počítají stejně jako u teploty, aby dvojčata neurčovala
 * většinu.
 */
export const WET_MM = 0.2;

export function precipConsensus(rows) {
  const platne = (rows || []).filter(r => r.rain != null && r.id !== MAIN_MODEL[0]);
  if (platne.length < 3) return null;
  // Hlas rodiny = má aspoň jeden její člen srážky? (a kolik nejvíc)
  const rodiny = {};
  for (const r of platne) {
    const f = familyOf(r.id) || r.id;
    const p = rodiny[f] || (rodiny[f] = { wet: false, max: 0 });
    if (r.rain >= WET_MM) p.wet = true;
    if (r.rain > p.max) p.max = r.rain;
  }
  const jmena = Object.keys(rodiny);
  const mokre = jmena.filter(f => rodiny[f].wet).length;
  const uhrny = platne.map(r => r.rain).sort((a, b) => a - b);
  const median = uhrny.length % 2
    ? uhrny[(uhrny.length - 1) / 2]
    : (uhrny[uhrny.length / 2 - 1] + uhrny[uhrny.length / 2]) / 2;
  return {
    rodin: jmena.length, mokrych: mokre,
    podil: Math.round(mokre / jmena.length * 100),
    lo: uhrny[0], hi: uhrny[uhrny.length - 1], median: Math.round(median * 10) / 10,
    modelu: platne.length,
  };
}

/**
 * Který model je právě "best_match"?
 *
 * Open-Meteo neřekne, kterou volbu pod best_match udělal — a přitom je to
 * číslo, které appka ukazuje jako předpověď. Zjistí se porovnáním řad: ta
 * shodná (do setiny stupně) je ta pravá.
 */
export function identifyBestMatch(series) {
  const hlavni = series?.[MAIN_MODEL[0]];
  if (!hlavni) return null;
  const casy = Object.keys(hlavni);
  if (casy.length < 6) return null;
  let nej = null, nejD = Infinity;
  for (const [id] of MODELS) {
    const s = series[id];
    if (!s) continue;
    let sum = 0, n = 0;
    for (const iso of casy) {
      if (s[iso] == null) continue;
      sum += Math.abs(s[iso] - hlavni[iso]); n++;
    }
    if (n < casy.length * 0.6) continue;      // málo překryvu, neporovnávej
    const d = sum / n;
    if (d < nejD) { nejD = d; nej = id; }
  }
  // 0,05 °C je "totéž zaokrouhlené jinak"; větší rozdíl už znamená, že
  // best_match míchá víc modelů nebo běží nad jiným během.
  return nej && nejD <= 0.05 ? { id: nej, label: metaFor(nej)[1] } : null;
}

/**
 * Systematická odchylka ZOBRAZENÉ předpovědi (best_match) pro tohle místo.
 *
 * Čte se synchronně z localStorage plus z posledních stažených sdílených
 * skóre — musí být k dispozici hned při parsování předpovědi, aby se korekce
 * promítla do všech pohledů naráz. Kdyby dorazila později a čísla se změnila
 * pod rukama, bylo by to horší než ji neaplikovat vůbec.
 *
 * Váhy se tu ZÁMĚRNĚ nepoužívají, jen bias. Vážený průměr modelů by
 * v hlavním čísle ukazoval teplotu, kterou netvrdí žádný model, a při málo
 * vzorcích by skákal. Odečíst změřenou systematickou odchylku je oprava
 * téhož čísla, ne jeho nahrazení.
 */
export const MIN_BIAS_SAMPLES = 5;   // pod tím je "bias" jen šum
export const MIN_BIAS_C = 0.5;       // menší korekce jen předstírá přesnost

export function displayCorrection(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = locKey(lat, lon);
  const rec = loadStore()[key];
  const shared = _sharedCache.get(key)?.models;
  const sc = mergeScores(rec?.scores || {}, shared || {})[MAIN_MODEL[0]];
  if (!sc || sc.bias == null) return null;
  const n = (sc.n || 0) + (sc.nShared || 0);
  if (n < MIN_BIAS_SAMPLES || Math.abs(sc.bias) < MIN_BIAS_C) return null;
  return { bias: sc.bias, n, local: sc.n || 0, shared: sc.nShared || 0 };
}

function mae(errs) {
  return Math.round(errs.reduce((a, b) => a + b, 0) / errs.length * 10) / 10;
}

// ── Konsenzus: jedno číslo místo deseti ────────────────────────────────────
function renderBlend(blend, rows, srazky) {
  const el = document.getElementById("blend-card");
  if (!el) return;
  el.classList.remove("show");
  el.innerHTML = "";
  if (!blend) return;

  // Srážky se NEPRŮMĚRUJÍ (viz precipConsensus) — vedle teploty stojí míra
  // shody a rozsah scénářů. Dřív o srážkách konsenzus mlčel úplně, přestože
  // je to to, kvůli čemu se appka jmenuje nowcast.
  const srazkyRadek = !srazky ? "" : (() => {
    const rozsah = srazky.hi < WET_MM
      ? "žádný model nedává měřitelné srážky"
      : `úhrn ${num(srazky.lo)}–${num(srazky.hi)} mm, medián ${num(srazky.median)}`;
    return `<div class="blend-precip"><b>Srážky dnes:</b> `
      + `${srazky.mokrych} z ${srazky.rodin} nezávislých modelů `
      + `<span class="muted">(${rozsah})</span></div>`;
  })();

  if (blend.value == null) {
    // Ještě se učíme — ukaž prostý průměr a řekni, že to zatím není vážené.
    if (blend.plain == null && !srazkyRadek) return;
    if (blend.plain != null) {
      el.innerHTML = `<div><b>Konsenzus modelů:</b> ${Math.round(blend.plain)} °C `
        + `<span class="muted">prostý průměr — přesnost modelů se pro tohle místo teprve učí</span></div>`
        + srazkyRadek;
    } else {
      el.innerHTML = srazkyRadek;
    }
    el.classList.add("show");
    return;
  }

  const diff = blend.plain != null ? blend.value - blend.plain : 0;
  const shift = Math.abs(diff) >= 0.4
    ? ` <span class="muted">(prostý průměr by řekl ${Math.round(blend.plain)} °C — `
      + `korekce podle měření ${diff > 0 ? "+" : ""}${num(diff)} °C)</span>`
    : "";
  // "Rodin", ne "modelů": ICON-D2 a ICON jsou obě DWD, KNMI a DMI obě
  // HARMONIE. Napsat "z deseti modelů" by slibovalo víc nezávislosti,
  // než tam je.
  el.innerHTML = `<div><b>Konsenzus modelů:</b> ${Math.round(blend.value)} °C `
    + `<span class="muted">vážený přesností ${blend.used} modelů `
    + `v ${blend.rodin} nezávislých rodinách</span>${shift}</div>`
    + srazkyRadek;
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
  el.title = `Rozptyl denních maxim mezi ${rows.length} modely: ${num(spread)} °C; `
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
    renderBlend(blend, rows, precipConsensus(rows));

    const ranked = rows.some(r => r.mae != null);
    rows.sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99) || a.label.localeCompare(b.label));

    const body = rows.map((r, i) => `
      <div class="mdl-row${i === 0 && ranked && r.mae != null ? " best" : ""}${
        r.id === MAIN_MODEL[0] ? " mdl-main" : ""}">
        <span class="mdl-medal">${ranked && r.mae != null && i < 3 ? `<span class="mdl-rank r${i + 1}">${i + 1}</span>` : ""}</span>
        <span class="mdl-name" title="${esc(r.src)}">${esc(r.label)}</span>
        <span class="mdl-tmax">${Math.round(r.tmax)}°</span>
        <span class="mdl-rain">${r.rain >= 0.2 ? `${num(r.rain)} mm` : "—"}</span>
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
    // Čím je zobrazená předpověď právě teď. Open-Meteo to neřekne, tak se to
    // pozná porovnáním řad — a je to poctivější než mlčet o tom, že hlavní
    // číslo appky pochází z modelu, který uživatel nevidí.
    const bm = identifyBestMatch(series);
    const korekce = displayCorrection(lat, lon);
    const bmNote = `<br><b>Zobrazená předpověď</b> jede z Open-Meteo best_match`
      + (bm ? ` — teď shodný s ${esc(bm.label)}.` : ` (mix modelů podle lokality).`)
      + (korekce
        ? ` Podle ${korekce.n} porovnání se stanicí ji appka posouvá o `
          + `${korekce.bias > 0 ? "−" : "+"}${num(Math.abs(korekce.bias))} °C.`
        : ` Systematickou odchylku zatím měří (od ${MIN_BIAS_SAMPLES} porovnání ji začne odečítat).`);
    const note = ranked
      ? `Přesnost = průměrná chyba slibované teploty proti měření stanice ${stStr}.` +
        (sharedN ? ` Učí se i ze zkušeností ostatních v okolí (${sharedN} vzorků).` : "") +
        ` ▲/▼ značí, že model systematicky přestřeluje / podstřeluje.` + bmNote
      : st
        ? `Žebříček se učí: při každé návštěvě porovnám starší sliby modelů s měřením stanice ${stStr}. Potřebuje pár návštěv v odstupu aspoň 3 h.` + bmNote
        : `V okruhu ${STATION_MAX_KM} km není čerstvě hlásící meteostanice, takže přesnost modelů tu nejde poctivě ověřit — ukazuji jen dnešní předpovědi.` + bmNote;

    panel.innerHTML = `
      <div class="mdl-title">Modely pro tohle místo <span class="mdl-sub">${rows.length} modelů · dnes max / srážky / přesnost</span></div>
      <div class="mdl-head"><span></span><span>model</span><span>max</span><span>déšť</span><span>chyba</span></div>
      ${body}
      <div class="mdl-note">${note}</div>`;
    panel.classList.add("show");
  } catch (e) {
    // Přerušení kvůli novému dotazu není chyba — jen se překreslí něco jiného.
    // Selhání sítě ale panel dřív TIŠE SKRYLO: uživatel nepoznal, jestli se
    // něco pokazilo, nebo jestli tuhle funkci nikdy neměl.
    if (e.name === "AbortError") return;
    panelError(panel, "Modely pro tohle místo",
      "Předpovědi modelů se nepodařilo načíst.",
      () => renderModelsPanel(lat, lon));
  }
}
