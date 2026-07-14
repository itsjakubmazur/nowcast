// Klimatický kontext — odchylka dnešní teploty od normálu 1991–2020 (ERA5,
// Open-Meteo archive API). Normál se počítá z okna ±5 dní kolem dnešního
// kalendářního data napříč 30 lety a cachuje se v localStorage na 30 dní
// per zaokrouhlenou polohu (jeden velký request, ~200 kB, jednou za měsíc).

const CACHE_KEY = "nowcast_climate_normals_v1";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const WINDOW_DAYS = 5;

function cacheGet(locKey) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    const e = all[locKey];
    if (e && Date.now() - e.t < CACHE_TTL_MS) return e.normals; // {"MM-DD": meanTemp}
  } catch { /* ignore */ }
  return null;
}
function cacheSet(locKey, normals) {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    // drž jen pár posledních poloh, ať localStorage nebobtná (velká data)
    const keys = Object.keys(all);
    if (keys.length >= 3) {
      keys.sort((a, b) => all[a].t - all[b].t);
      delete all[keys[0]];
    }
    all[locKey] = { t: Date.now(), normals };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota — nevadí, příště se stáhne znovu */ }
}

async function fetchNormals(lat, lon) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`
    + `&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_mean&timezone=Europe%2FPrague`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const times = data.daily?.time || [];
    const temps = data.daily?.temperature_2m_mean || [];
    // agreguj podle "MM-DD"
    const sums = {}, counts = {};
    for (let i = 0; i < times.length; i++) {
      if (temps[i] == null) continue;
      const md = times[i].slice(5);
      sums[md] = (sums[md] || 0) + temps[i];
      counts[md] = (counts[md] || 0) + 1;
    }
    const normals = {};
    for (const md of Object.keys(sums)) normals[md] = Math.round(sums[md] / counts[md] * 10) / 10;
    return normals;
  } finally {
    clearTimeout(timer);
  }
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

  const locKey = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  let normals = cacheGet(locKey);
  if (!normals) {
    try {
      normals = await fetchNormals(lat, lon);
      cacheSet(locKey, normals);
    } catch {
      return; // archiv nedostupný — řádek prostě zůstane bez odchylky
    }
  }

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
