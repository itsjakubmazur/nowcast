// Předpověď z 9 modelů + hodnocení přesnosti PRO KONKRÉTNÍ MÍSTO.
//
// Inspirace: Počasí Meteo staví na "9 modelech s hodnocením kvality" — my to
// děláme osobněji a poctivěji: při každé návštěvě si uložíme, co jednotlivé
// modely slibovaly na příští hodiny (localStorage), a při dalších návštěvách
// ty sliby porovnáme se SKUTEČNÝM měřením nejbližší meteostanice (ČHMÚ/WU
// do 15 km, čerstvé ≤ 90 min). Z toho roste klouzavá MAE per model per místo
// — žebříček modelů přesně pro tvůj kopec, ne krajský průměr. Bez stanice
// poblíž se hodnocení neučí (žádná náhradní "pravda" se nevymýšlí).

import { state } from "./state.js";
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

// Nejbližší stanice s čerstvou teplotou — "pravda" pro verifikaci
function nearestFreshStation(lat, lon) {
  const all = [...(state.CHMI?.stations || []), ...(state.WU?.stations || [])];
  let best = null, bd = Infinity;
  for (const s of all) {
    if (s.temp == null || s.lat == null) continue;
    const age = ageMinutes(s.time_utc);
    if (age == null || age > 90) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= 15 ? { ...best, distKm: bd } : null;
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

  const st = nearestFreshStation(lat, lon);
  if (st) {
    for (const snap of rec.snaps) {
      const ageH = (now - snap.t) / 3600000;
      if (ageH < SNAP_MIN_AGE_H || ageH > SNAP_MAX_AGE_H) continue;
      const preds = snap.h?.[nowHour];
      if (!preds || snap.done?.includes(nowHour)) continue;
      for (const [id, temp] of Object.entries(preds)) {
        const sc = rec.scores[id] || { errs: [] };
        sc.errs.push(Math.round(Math.abs(temp - st.temp) * 10) / 10);
        if (sc.errs.length > SCORE_WINDOW) sc.errs = sc.errs.slice(-SCORE_WINDOW);
        rec.scores[id] = sc;
      }
      (snap.done = snap.done || []).push(nowHour);
    }
  }

  // nový snapshot: sliby všech modelů na příštích 24 h (zaokrouhleně, ať je malý)
  const snapH = {};
  for (const [id] of MODELS) {
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
  return rec.scores;
}

function mae(errs) {
  return Math.round(errs.reduce((a, b) => a + b, 0) / errs.length * 10) / 10;
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
    const ids = Object.keys(series);
    if (ids.length < 3) { panel.classList.remove("show"); return; }
    // mezitím se mohlo přepnout místo
    if (state.currentLat?.toFixed(4) !== lat.toFixed(4)) return;

    const scores = verifyAndSnapshot(lat, lon, series);

    // dnešek per model: max teplota + srážky (z precipitation_<model>)
    const h = data.hourly || {};
    const times = h.time || [];
    const today = locDateStr();
    const rows = ids.map(id => {
      const meta = MODELS.find(m => m[0] === id);
      let tmax = null, rain = 0;
      const pArr = h[`precipitation_${id}`] || null;
      for (let i = 0; i < times.length; i++) {
        if (!times[i].startsWith(today)) continue;
        const t = series[id][times[i]];
        if (t != null && (tmax == null || t > tmax)) tmax = t;
        rain += pArr?.[i] ?? 0;
      }
      const sc = scores[id];
      return { id, label: meta[1], src: meta[2], tmax, rain,
        mae: sc && sc.errs.length >= MIN_SAMPLES ? mae(sc.errs) : null,
        n: sc?.errs.length || 0 };
    }).filter(r => r.tmax != null);
    if (rows.length < 3) { panel.classList.remove("show"); return; }

    // Shoda modelů = důvěra ve výhled. Když se 9 modelů shodne na teplotě i
    // na tom, jestli prší, je jistota vysoká; když se rozcházejí, řekni to.
    renderConfidence(rows);

    const ranked = rows.some(r => r.mae != null);
    rows.sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99) || a.label.localeCompare(b.label));
    const medals = ["🥇", "🥈", "🥉"];

    const body = rows.map((r, i) => `
      <div class="mdl-row${i === 0 && ranked && r.mae != null ? " best" : ""}">
        <span class="mdl-medal">${ranked && r.mae != null && i < 3 ? medals[i] : ""}</span>
        <span class="mdl-name" title="${esc(r.src)}">${esc(r.label)}</span>
        <span class="mdl-tmax">${Math.round(r.tmax)}°</span>
        <span class="mdl-rain">${r.rain >= 0.2 ? `${Math.round(r.rain * 10) / 10} mm` : "—"}</span>
        <span class="mdl-mae">${r.mae != null ? `±${String(r.mae).replace(".", ",")}°` : `<i title="hodnotí se z tvých návštěv">${r.n}/${MIN_SAMPLES}</i>`}</span>
      </div>`).join("");

    const st = nearestFreshStation(lat, lon);
    const note = ranked
      ? `Přesnost = průměrná chyba slibované teploty proti měření stanice${st ? ` ${esc(st.name)}` : ""} — hodnoceno z tvých návštěv, jen pro tohle místo.`
      : st
        ? `Žebříček se učí: při každé návštěvě porovnám starší sliby modelů s měřením stanice ${esc(st.name)}.`
        : `Bez meteostanice do 15 km se přesnost modelů nehodnotí — ukazuji jen dnešní předpovědi.`;

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
