// Klimatický kontext — odchylka dnešní teploty od normálu 1991–2020 (ERA5,
// Open-Meteo archive API) + rekordy pro dnešní kalendářní den ("tento den
// v historii"). Vše z JEDNOHO archivního requestu (daily mean/max/min přes
// 30 let), cachovaného v localStorage na 30 dní per zaokrouhlenou polohu.

const CACHE_KEY = "nowcast_climate_normals_v2"; // v2: + rekordy max/min
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const WINDOW_DAYS = 5;

function cacheGet(locKey) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    const e = all[locKey];
    if (e && Date.now() - e.t < CACHE_TTL_MS) return e.clim; // {normals, recs}
  } catch { /* ignore */ }
  return null;
}
function cacheSet(locKey, clim) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    // drž jen pár posledních poloh, ať localStorage nebobtná (velká data)
    const keys = Object.keys(all);
    if (keys.length >= 3) {
      keys.sort((a, b) => all[a].t - all[b].t);
      delete all[keys[0]];
    }
    all[locKey] = { t: Date.now(), clim };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota — nevadí, příště se stáhne znovu */ }
}

async function fetchClimatology(lat, lon) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`
    + `&start_date=1991-01-01&end_date=2020-12-31`
    + `&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min&timezone=Europe%2FPrague`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const times = data.daily?.time || [];
    const means = data.daily?.temperature_2m_mean || [];
    const maxs = data.daily?.temperature_2m_max || [];
    const mins = data.daily?.temperature_2m_min || [];

    const sums = {}, counts = {};
    const recs = {}; // "MM-DD" → { hi, hiY, lo, loY }
    for (let i = 0; i < times.length; i++) {
      const md = times[i].slice(5);
      const yr = times[i].slice(0, 4);
      if (means[i] != null) {
        sums[md] = (sums[md] || 0) + means[i];
        counts[md] = (counts[md] || 0) + 1;
      }
      const rec = recs[md] || (recs[md] = { hi: -99, hiY: null, lo: 99, loY: null });
      if (maxs[i] != null && maxs[i] > rec.hi) { rec.hi = maxs[i]; rec.hiY = yr; }
      if (mins[i] != null && mins[i] < rec.lo) { rec.lo = mins[i]; rec.loY = yr; }
    }
    const normals = {};
    for (const md of Object.keys(sums)) normals[md] = Math.round(sums[md] / counts[md] * 10) / 10;
    for (const md of Object.keys(recs)) {
      recs[md].hi = Math.round(recs[md].hi * 10) / 10;
      recs[md].lo = Math.round(recs[md].lo * 10) / 10;
    }
    return { normals, recs };
  } finally {
    clearTimeout(timer);
  }
}

// Anomálie i rekordy volají getClimatology souběžně — sdílíme rozpracovaný
// fetch, ať se velký archivní request neposílá dvakrát.
const _inflight = new Map();

async function getClimatology(lat, lon) {
  const locKey = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const cached = cacheGet(locKey);
  if (cached) return cached;
  if (_inflight.has(locKey)) return _inflight.get(locKey);
  const p = fetchClimatology(lat, lon)
    .then(clim => { cacheSet(locKey, clim); return clim; })
    .finally(() => _inflight.delete(locKey));
  _inflight.set(locKey, p);
  return p;
}

function windowMDs(date, span) {
  const out = [];
  for (let d = -span; d <= span; d++) {
    const dt = new Date(date.getTime() + d * 86400000);
    out.push(dt.toISOString().slice(5, 10));
  }
  return out;
}

// data = odpověď Open-Meteo forecastu (kvůli dnešní průměrné teplotě z hourly)
export async function renderClimateAnomaly(lat, lon, data) {
  const slot = () => document.getElementById("delta-anomaly");
  if (!slot()) return;

  let clim;
  try {
    clim = await getClimatology(lat, lon);
  } catch {
    return; // archiv nedostupný — řádek prostě zůstane bez odchylky
  }
  const normals = clim.normals || {};

  const today = new Date();
  const mds = windowMDs(today, WINDOW_DAYS);
  const vals = mds.map(md => normals[md]).filter(v => v != null);
  if (!vals.length) return;
  const normal = vals.reduce((a, b) => a + b, 0) / vals.length;

  // dnešní očekávaný průměr: střed z hodinovky nejbližších 24 h
  const h = data.hourly || {};
  const times = h.time || [];
  const temp = h.temperature_2m || [];
  const nowP = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" }).slice(0, 13) + ":00";
  let i = times.findIndex(t => t >= nowP);
  if (i < 0) i = 0;
  const next24 = temp.slice(i, i + 24).filter(v => v != null);
  if (!next24.length) return;
  const todayMean = next24.reduce((a, b) => a + b, 0) / next24.length;

  const anom = todayMean - normal;
  const el = slot();
  if (!el || Math.abs(anom) < 2) return;
  const warm = anom > 0;
  el.className = "d-anom" + (warm ? "" : " cold");
  el.textContent = `${warm ? "▲" : "▼"} o ${Math.abs(Math.round(anom))}° ${warm ? "nad" : "pod"} normálem 1991–2020`;
  document.getElementById("delta-line")?.classList.add("show");
}

// ── Tento den v historii — rekordy 1991–2020 pro dnešní kalendářní den ──────
// data = odpověď forecastu (kvůli porovnání dnešního maxima s rekordem)
export async function renderDayInHistory(lat, lon, data) {
  const panel = document.getElementById("history-panel");
  const body = document.getElementById("history-body");
  if (!panel || !body) return;

  let clim;
  try {
    clim = await getClimatology(lat, lon);
  } catch {
    panel.classList.remove("show");
    return;
  }
  const md = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" }).slice(5);
  const rec = clim.recs?.[md];
  const normal = clim.normals?.[md];
  if (!rec || rec.hiY == null) { panel.classList.remove("show"); return; }

  const todayMax = data.daily?.temperature_2m_max?.[0];
  const todayMin = data.daily?.temperature_2m_min?.[0];
  const nearHi = todayMax != null && todayMax >= rec.hi - 1.5;
  const nearLo = todayMin != null && todayMin <= rec.lo + 1.5;

  body.innerHTML = `
    <div class="hist-row"><span class="hist-label">Nejtepleji</span>
      <b>${rec.hi.toFixed(1)} °C</b><span class="hist-year">${rec.hiY}</span></div>
    <div class="hist-row"><span class="hist-label">Nejchladněji</span>
      <b>${rec.lo.toFixed(1)} °C</b><span class="hist-year">${rec.loY}</span></div>
    ${normal != null ? `<div class="hist-row"><span class="hist-label">Průměr dne</span>
      <b>${normal.toFixed(1)} °C</b><span class="hist-year">1991–2020</span></div>` : ""}
    ${nearHi ? `<div class="hist-note">🔥 Dnešní maximum ${Math.round(todayMax)}° útočí na rekord!</div>` : ""}
    ${nearLo && !nearHi ? `<div class="hist-note">🧊 Dnešní minimum ${Math.round(todayMin)}° se blíží rekordu chladu.</div>` : ""}`;
  panel.classList.add("show");
}
