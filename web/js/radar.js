import { state, PLAY } from "./state.js";
import { setRadarFrameUrl, setRadarOpacityBoth } from "./map.js";
import { haversine, bearing, num, esc } from "./utils.js";
import { uiIcon } from "./uiicons.js";
import { isDarkTheme } from "./theme.js";
import { showToast } from "./toast.js";
import { gc } from "./palette.js";

const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";

export function preloadFrames() {
  const v = `?v=${encodeURIComponent(state.MANIFEST.generated_at_utc)}`;
  state.preloadedImgs = state.MANIFEST.frames.map(f => {
    const img = new Image();
    img.src = `data/radar_frames/${f.file}${v}`;
    return img;
  });
}

// ── Legenda (z manifest.palette — přesně zrcadlí to, co render.py vykreslil) ─
export function renderLegend() {
  const el = document.getElementById("radar-legend");
  if (!el || !state.MANIFEST?.palette?.length) return;
  const stops = state.MANIFEST.palette;
  const { min, max } = state.MANIFEST.scale_dbz || { min: stops[0][0], max: stops[stops.length - 1][0] };
  const gradParts = stops.map(([dbz, hex]) => {
    const pct = ((dbz - min) / (max - min)) * 100;
    return `${hex} ${pct.toFixed(0)}%`;
  });
  const bar = el.querySelector(".legend-bar");
  if (bar) bar.style.background = `linear-gradient(to right, ${gradParts.join(", ")})`;
  const labels = el.querySelector(".legend-labels");
  if (labels) {
    labels.innerHTML = `<span>slabé</span><span>intenzivní</span>`;
  }
  el.classList.add("show");
}

// ── CZ radar (vlastní nowcast) ────────────────────────────────────────────────
export function showFrame(idx) {
  if (state.globalMode && state.rvFrames.length) _showFrameRV(idx);
  else _showFrameCZ(idx);
}

function _showFrameCZ(idx) {
  const frames = state.MANIFEST.frames;
  state.currentFrame = Math.max(0, Math.min(idx, frames.length - 1));
  const f = frames[state.currentFrame];

  const url = state.preloadedImgs[state.currentFrame]?.src
    || `data/radar_frames/${f.file}`;
  setRadarFrameUrl(url, state.radarOpacity);
  document.getElementById("timeline").value = state.currentFrame;

  let label = "";
  if (f.type === "t0") label = `<span class='t0-label'>● teď</span>`;
  else if (f.type === "nowcast")
    label = `<span class='nowcast-label'>+${(state.currentFrame - state.MANIFEST.t0_index) * 10} min</span>`;
  document.getElementById("frame-time").innerHTML = `<strong>${f.time_local}</strong> ${label}`;

  const pct = (state.MANIFEST.t0_index / (frames.length - 1)) * 100;
  document.getElementById("t0-tick").style.left = pct + "%";
  document.getElementById("t0-marker").style.left = pct + "%";
}

function _showFrameRV(idx) {
  state.currentFrame = Math.max(0, Math.min(idx, state.rvFrames.length - 1));
  if (state.rvLayer) {
    state.rvLayer.setUrl(state.rvFrames[state.currentFrame].url);
    state.rvLayer.setOpacity(state.radarOpacity);
  }
  document.getElementById("timeline").value = state.currentFrame;

  const f = state.rvFrames[state.currentFrame];
  const dt = new Date(f.time * 1000);
  // světový radar → časy v zóně vybraného místa (state.tz), ne natvrdo Praha
  const tStr = dt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: state.tz });
  const isNow = state.currentFrame === state.rvT0idx;
  const isFuture = state.currentFrame > state.rvT0idx;
  const minDiff = Math.round((state.currentFrame - state.rvT0idx) * 10);
  const label = isNow
    ? `<span class='t0-label'>● teď</span>`
    : isFuture
      ? `<span class='nowcast-label'>+${minDiff} min</span>`
      : `<span style='color:var(--muted)'>-${Math.abs(minDiff)} min</span>`;
  document.getElementById("frame-time").innerHTML = `<strong>${tStr}</strong> ${label}`;
}

export function stepFrame(delta) { showFrame(state.currentFrame + delta); }

function scheduleNext(delayMs) {
  state.playTimer = setTimeout(() => {
    if (!state.playing) return;
    const n = state.globalMode ? state.rvFrames.length : (state.MANIFEST?.frames?.length || 1);
    const t0 = state.globalMode ? state.rvT0idx : (state.MANIFEST?.t0_index ?? 0);
    if (state.currentFrame >= n - 1) {
      showFrame(0);
      scheduleNext(PLAY.endPauseMs);
    } else {
      showFrame(state.currentFrame + 1);
      const isT0 = state.currentFrame === t0;
      scheduleNext(isT0 ? PLAY.t0PauseMs : PLAY.intervalMs);
    }
  }, delayMs);
}

// Tlačítko světového režimu: ikona zůstává ikonou, mění se jen popisek vedle
// ní. Dřív se přepisovalo přes textContent, což SVG glóbus smazalo a nahradilo
// emoji 🌍 — stejná chyba, jakou tu už udělalo tlačítko polohy i obnovy.
function setGlobalBtn(btn, label) {
  if (!btn) return;
  let lbl = btn.querySelector(".lbl");
  if (!lbl) {
    btn.textContent = "";
    btn.insertAdjacentHTML("afterbegin", uiIcon("globe"));
    lbl = document.createElement("span");
    lbl.className = "lbl";
    btn.appendChild(lbl);
  }
  lbl.textContent = label;
}

export function togglePlay(forcePlay) {
  state.playing = forcePlay !== undefined ? forcePlay : !state.playing;
  const btn = document.getElementById("btn-play");
  if (state.playing) {
    btn.innerHTML = uiIcon("pause");
    btn.title = "Pozastavit";
    btn.classList.add("active");
    scheduleNext(PLAY.intervalMs);
  } else {
    clearTimeout(state.playTimer);
    btn.textContent = "▶";
    btn.title = "Přehrát";
    btn.classList.remove("active");
  }
}

export function setOpacity(pct) {
  state.radarOpacity = pct / 100;
  document.getElementById("opacity-val").textContent = pct + " %";
  if (state.globalMode) {
    if (state.rvLayer) state.rvLayer.setOpacity(state.radarOpacity);
  } else {
    setRadarOpacityBoth(state.radarOpacity);
  }
}

// ── Globální radar (RainViewer — reálné radarové dlaždice, korektně
//    označené; NEJEDNÁ SE o blesky) ───────────────────────────────────────────
export async function toggleGlobalMode() {
  state.globalMode = !state.globalMode;
  const btn = document.getElementById("btn-global");

  if (state.globalMode) {
    if (state.playing) togglePlay(false);
    await loadRainViewerFrames();
  } else {
    btn.classList.remove("active");
    setGlobalBtn(btn, "Svět");
    destroyRainViewerFrames();
    if (state.MANIFEST) {
      setRadarOpacityBoth(state.radarOpacity);
      applyManifestUI();
    }
  }
}

async function loadRainViewerFrames() {
  const btn = document.getElementById("btn-global");
  setGlobalBtn(btn, "Načítám…");

  try {
    const res = await fetch(RAINVIEWER_API, { cache: "no-store" });
    const data = await res.json();
    const host = data.host;
    const past = data.radar?.past || [];
    const nowcast = data.radar?.nowcast || [];
    const all = [...past, ...nowcast];
    if (!all.length) throw new Error("Žádná data");
    // Uživatel mezitím mohl kliknout zpátky na "Svět" OFF — bez tohohle by
    // pozdě doražená odpověď vrstvu na mapě "vzkřísila" i po vypnutí a UI by
    // zůstalo neshodné se state.globalMode (viz stejná třída bugů opravená
    // u toggleWindLayer/toggleHydro).
    if (!state.globalMode) return;

    setRadarOpacityBoth(0);
    destroyRainViewerFrames();
    state.rvT0idx = past.length - 1;

    state.rvFrames = all.map(f => ({
      time: f.time,
      url: `${host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
      isNowcast: !past.includes(f),
    }));

    state.rvLayer = L.tileLayer(state.rvFrames[state.rvT0idx].url, {
      opacity: state.radarOpacity, zIndex: 201,
      attribution: "RainViewer",
      maxNativeZoom: 8, maxZoom: 19,
    }).addTo(state.map);

    const slider = document.getElementById("timeline");
    slider.max = state.rvFrames.length - 1;
    slider.value = state.rvT0idx;

    const t0pct = (state.rvT0idx / (state.rvFrames.length - 1)) * 100;
    document.getElementById("t0-tick").style.left = t0pct + "%";
    document.getElementById("t0-marker").style.left = t0pct + "%";

    showFrame(state.rvT0idx);
    setGlobalBtn(btn, "ČR");
    btn.classList.add("active");
  } catch (e) {
    state.globalMode = false;
    setGlobalBtn(btn, "Svět");
    btn.classList.remove("active");
    setRadarOpacityBoth(state.radarOpacity);
    console.error("RainViewer:", e);
  }
}

function destroyRainViewerFrames() {
  if (state.rvLayer) { state.map.removeLayer(state.rvLayer); state.rvLayer = null; }
  state.rvFrames = [];
}

// ── Satelitní IR vrstva (RainViewer infrared kompozit) ───────────────────────
// Nezávislá na radarové animaci — poslední dostupný IR snímek pod radarem
// (zIndex 150 < 199/200 radaru), obnovovaný co 10 minut dokud je zapnutá.
// Ukazuje oblačnost i tam, kde neprší — kontext, který radar nemá.
const SAT_REFRESH_MS = 10 * 60 * 1000;

export async function toggleSatellite() {
  const btn = document.getElementById("btn-satellite");
  state.satMode = !state.satMode;

  if (!state.satMode) {
    clearInterval(state.satTimer);
    state.satTimer = null;
    if (state.satLayer) { state.map.removeLayer(state.satLayer); state.satLayer = null; }
    btn?.classList.remove("active");
    return;
  }

  btn?.classList.add("active");
  await loadSatelliteFrame();
  if (state.satMode && !state.satTimer) {
    state.satTimer = setInterval(loadSatelliteFrame, SAT_REFRESH_MS);
  }
}

async function loadSatelliteFrame() {
  try {
    const res = await fetch(RAINVIEWER_API, { cache: "no-store" });
    const data = await res.json();
    const frames = data.satellite?.infrared || [];
    if (!frames.length) throw new Error("IR snímky nedostupné");
    const last = frames[frames.length - 1];
    const url = `${data.host}${last.path}/256/{z}/{x}/{y}/0/0_0.png`;
    if (!state.satMode) return; // uživatel mezitím vypnul
    if (state.satLayer) {
      state.satLayer.setUrl(url);
    } else {
      state.satLayer = L.tileLayer(url, {
        opacity: 0.5, zIndex: 150, attribution: "Družice IR: RainViewer",
        maxNativeZoom: 6, maxZoom: 19,
      }).addTo(state.map);
    }
  } catch (e) {
    console.warn("Satelit:", e);
    if (!state.satLayer) {
      // první načtení selhalo — vrať tlačítko do vypnutého stavu
      state.satMode = false;
      clearInterval(state.satTimer);
      state.satTimer = null;
      document.getElementById("btn-satellite")?.classList.remove("active");
    }
  }
}

// ── Animované částice větru (leaflet-velocity, self-hosted) ─────────────────
// Knihovna se načítá líně až při prvním zapnutí — šetří start a smoke testy
// se stubem Leafletu ji vůbec nepotřebují. Data generuje pipeline/windgrid.py.
let _velocityLoading = null;

function loadVelocityLib() {
  if (window.L?.velocityLayer) return Promise.resolve();
  if (_velocityLoading) return _velocityLoading;
  _velocityLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/leaflet-velocity.min.js";
    s.onload = resolve;
    s.onerror = () => { _velocityLoading = null; reject(new Error("leaflet-velocity se nenačetl")); };
    document.head.appendChild(s);
  });
  return _velocityLoading;
}

// Token per zapnutí — bez něj by rychlé zap/vyp/zap nechalo na mapě
// duplicitní vrstvu (stejný problém jako u hydro.js toggleHydro).
let _windToken = 0;

// Vítr se generuje z Open-Meteo a z CI se to občas nepovede celé (viz
// pipeline/windgrid.py). Ať je z tooltipu poznat, jak je pole čerstvé a jestli
// se část bodů dopočítala — mlčet o tom by znamenalo tvářit se jistěji, než jsme.
export function windFreshnessLabel(header) {
  if (!header) return "Vítr 10 m";
  const parts = ["Vítr 10 m"];
  const ref = header.refTime ? new Date(header.refTime) : null;
  if (ref && !Number.isNaN(ref.getTime())) {
    const ageMin = Math.round((Date.now() - ref.getTime()) / 60000);
    if (ageMin < 90) parts.push(`data ${ageMin} min stará`);
    else parts.push(`data ${Math.round(ageMin / 60)} h stará`);
  }
  const { freshPoints: f, totalPoints: t } = header;
  if (Number.isFinite(f) && Number.isFinite(t) && t > 0 && f < t) {
    parts.push(`${Math.round(100 * f / t)} % bodů měřeno, zbytek dopočten`);
  }
  return parts.join(" · ");
}

const WIND_STALE_MIN = 120;   // pipeline běží po 5 min, 2 h = něco je špatně
const WIND_PATCHY_PCT = 0.8;  // pod 80 % měřených bodů už je pole znatelně dopočítané

// Vrátí větu do toastu, JEN když má vrstva vadu, kterou by uživatel měl znát.
// Když je všechno v pořádku, vrací null a nic se nezobrazí.
export function windCaveat(header) {
  if (!header) return null;
  const ref = header.refTime ? new Date(header.refTime) : null;
  const ageMin = ref && !Number.isNaN(ref.getTime())
    ? Math.round((Date.now() - ref.getTime()) / 60000) : null;
  const { freshPoints: f, totalPoints: t } = header;
  const patchy = Number.isFinite(f) && Number.isFinite(t) && t > 0 && f / t < WIND_PATCHY_PCT;

  if (ageMin != null && ageMin > WIND_STALE_MIN) {
    const h = Math.round(ageMin / 60);
    return `Vítr: poslední data jsou ${h} h stará, aktuální situace může být jiná.`;
  }
  if (patchy) {
    return `Vítr: měřeno ${Math.round(100 * f / t)} % mřížky, zbytek je dopočítaný.`;
  }
  return null;
}

export async function toggleWindLayer() {
  const btn = document.getElementById("btn-wind");
  state.windMode = !state.windMode;

  if (!state.windMode) {
    _windToken++;
    if (state.windLayer) { state.map.removeLayer(state.windLayer); state.windLayer = null; }
    btn?.classList.remove("active");
    return;
  }
  const myToken = ++_windToken;
  btn?.classList.add("active");
  try {
    await loadVelocityLib();
    const r = await fetch(`data/wind_grid.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2 || !data[0]?.data?.length) {
      throw new Error("wind_grid.json má neočekávaný tvar");
    }
    if (myToken !== _windToken) return; // mezitím uživatel znovu přepnul
    if (state.windLayer) { state.map.removeLayer(state.windLayer); state.windLayer = null; } // pojistka
    state.windLayer = L.velocityLayer({
      data,
      // 14 m/s ≈ 50 km/h. Dřív tu bylo 20 m/s (72 km/h), jenže běžný vítr v ČR
      // má 2–6 m/s — celá mřížka pak spadla do nejsvětlejšího pásma a vypadala
      // jednolitě. Nižší strop rozprostře barevnou škálu po reálném rozsahu.
      maxVelocity: 14,
      velocityScale: 0.012,      // délka "ocásku" částice
      particleAge: 64,
      lineWidth: 1.4,
      colorScale: ["#9fc7ff", "#5AC8FA", "#0A84FF", "#BF5AF2", "#FF375F"],
      displayValues: false,
    }).addTo(state.map);
    const h = data[0].header;
    if (btn) btn.title = windFreshnessLabel(h);
    // Toast jen když je co přiznat — na dotyku se tooltip nikdy neukáže, ale
    // hlásit se při každém zapnutí by byl otravný šum.
    const caveat = windCaveat(h);
    if (caveat) showToast(caveat, { timeoutMs: 5000 });
  } catch (e) {
    if (myToken !== _windToken) return; // mezitím uživatel znovu přepnul
    console.warn("Vítr:", e);
    state.windMode = false;
    btn?.classList.remove("active");
    // Nenechávej uživatele hádat — dřív se tlačítko jen tiše vyplo a vypadalo
    // to jako "nefunguje". wind_grid.json může chybět, když windgrid.py v CI
    // vypršel (proto se teď cachuje mezi běhy).
    if (btn) btn.title = "Větrná data zatím nejsou k dispozici — zkus to za chvíli";
  }
}

// ── Aktivní srážkové/konvekční jádro — poctivě odvozené z VLASTNÍHO nowcastu,
//    ne z cizích "lightning" dlaždic, které ve skutečnosti nejsou blesky. ────
const STORM_PEAK_THRESHOLD_MM_H = 15; // "silný déšť" práh z rainIntensity()

export function findNearestStormCore() {
  if (!state.GRID || state.currentLat === null) return null;
  let nearest = null, nearestDist = Infinity;
  state.GRID.pts.forEach((pt, i) => {
    const a = state.GRID.act[String(i)];
    if (!a || a[2] < STORM_PEAK_THRESHOLD_MM_H) return;
    const d = haversine(state.currentLat, state.currentLon, pt[0], pt[1]);
    if (d < nearestDist) { nearestDist = d; nearest = pt; }
  });
  if (!nearest) return null;
  const dir = bearing(state.currentLat, state.currentLon, nearest[0], nearest[1]);
  return { dist: nearestDist, dir };
}

let _prevStormDist = null;
export function updateStormBar() {
  const bar = document.getElementById("storm-bar");
  if (!bar) return;
  const info = findNearestStormCore();
  const el = document.getElementById("storm-dist");
  const dirEl = document.getElementById("storm-dir");
  const trendEl = document.getElementById("storm-trend");

  if (!info || info.dist > 150) {
    bar.classList.remove("show");
    _prevStormDist = null;
    return;
  }
  el.textContent = `${Math.round(info.dist)} km`;
  dirEl.textContent = `na ${info.dir}`;
  el.className = info.dist < 15 ? "near" : info.dist < 40 ? "medium" : "far";
  if (trendEl) {
    if (_prevStormDist !== null) {
      const diff = info.dist - _prevStormDist;
      if (diff < -2) { trendEl.textContent = "↘ přibližuje se"; trendEl.className = "approaching"; }
      else if (diff > 2) { trendEl.textContent = "↗ vzdaluje se"; trendEl.className = "receding"; }
      else { trendEl.textContent = "→ stacionární"; trendEl.className = ""; }
    }
    _prevStormDist = info.dist;
  }
  bar.classList.add("show");
}

// ── Srážkový sparkline — teď z celé série (grid.series), ne jen obálky ──────
export function drawRainSpark(ptId) {
  const wrap = document.getElementById("rain-spark-wrap");
  const canvas = document.getElementById("rain-spark");
  // ptId null = světový režim — sparkline jede z českého gridu, skryj ho
  if (ptId == null || !state.MANIFEST || !state.GRID) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  requestAnimationFrame(() => _drawRainSparkCanvas(ptId, wrap, canvas));
}

function _drawRainSparkCanvas(ptId, wrap, canvas) {
  const a = state.GRID.act[String(ptId)];
  const series = state.GRID.series?.[String(ptId)];
  const n = state.MANIFEST.frames.length;
  const t0idx = state.MANIFEST.t0_index;
  const stepMin = state.MANIFEST.step_min || 10;
  const t0ms = new Date(state.MANIFEST.t0_utc).getTime();

  const vals = state.MANIFEST.frames.map(f => {
    if (!a || f.type === "past") return 0;
    const frameMs = new Date(f.time_utc).getTime();
    const stepIdx = Math.round((frameMs - t0ms) / (stepMin * 60000)) - 1;
    if (stepIdx < 0) return 0;
    if (series && stepIdx < series.length) return series[stepIdx];
    if (stepIdx < a[0] || stepIdx >= a[1]) return 0;
    return a[2];
  });

  const hasRain = vals.some(v => v > 0);
  const maxVal = Math.max(...vals, 1);

  canvas.width = wrap.clientWidth || canvas.offsetWidth || 400;
  canvas.height = 44;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const bw = W / n;
  ctx.fillStyle = isDarkTheme() ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)";
  ctx.fillRect(0, 0, (t0idx + 1) * bw, H);

  ctx.strokeStyle = isDarkTheme() ? "#374151" : "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(0, H - 1); ctx.lineTo(W, H - 1); ctx.stroke();

  vals.forEach((v, i) => {
    if (v <= 0) return;
    const barH = Math.max(3, (v / maxVal) * (H - 6));
    const t = Math.min(v / 15, 1);
    const r = Math.round(59 + t * (239 - 59));
    const g = Math.round(130 + t * (68 - 130));
    const b = Math.round(246 + t * (68 - 246));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i * bw + 1, H - barH - 1, Math.max(bw - 2, 1), barH);
  });

  const t0x = (t0idx + 0.5) * bw;
  ctx.strokeStyle = "rgba(245,158,11,0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(t0x, 0); ctx.lineTo(t0x, H); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = gc("neutral");
  ctx.font = "11px system-ui";
  ctx.textAlign = "right";
  ctx.fillText(hasRain ? `max ${num(Math.max(...vals))} mm/h` : "žádné srážky", W - 4, 12);
  ctx.textAlign = "left";
  ctx.fillText("hist", 3, 12);
  ctx.fillText("nowcast →", t0x + 4, 12);
}

// ── Výška fixed panelů → CSS vars, ať se navzájem nikdy nepřekrývají (viz
//    --radar-bar-h/--layer-selector-h v app.css) — místo hádaných pixelů
//    měříme skutečnou vykreslenou výšku a reagujeme na její změny (wrap
//    řádků na užších oknech, zobrazení sparkline, …). ─────────────────────
function observeHeightVar(elId, cssVar, fallbackPx) {
  const el = document.getElementById(elId);
  if (!el || typeof ResizeObserver === "undefined") return;
  const apply = () => {
    const h = el.offsetHeight || fallbackPx;
    document.documentElement.style.setProperty(cssVar, `${h}px`);
  };
  new ResizeObserver(apply).observe(el);
  apply();
}

export function observeRadarBarHeight() {
  observeHeightVar("radar-bar", "--radar-bar-h", 88);
  observeHeightVar("layer-selector", "--layer-selector-h", 36);
}

// ── Manifest UI ────────────────────────────────────────────────────────────
export function applyManifestUI() {
  const nf = state.MANIFEST.frames.length;
  const t0 = new Date(state.MANIFEST.t0_utc);
  const gen = new Date(state.MANIFEST.generated_at_utc);

  document.getElementById("radar-t0").textContent =
    "Radar " + t0.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" });
  document.getElementById("radar-updated").textContent =
    "generováno " + gen.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });

  const srcEl = document.getElementById("radar-source");
  if (srcEl) {
    srcEl.textContent = (state.MANIFEST.source_label || "Radarová odrazivost (dBZ) — orientační intenzita srážek")
      + " · číselný odhad úhrnů je přesnější";
  }
  if (state.GRID?.generated_at_utc) {
    document.getElementById("updated").textContent =
      "Prognóza: " + new Date(state.GRID.generated_at_utc).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
  }
  updateRefreshTime(gen);
  renderLegend();

  if (!state.globalMode) {
    document.getElementById("timeline").max = nf - 1;
    const t0pct = (state.MANIFEST.t0_index / (nf - 1)) * 100;
    document.getElementById("t0-tick").style.left = t0pct + "%";
    document.getElementById("t0-marker").style.left = t0pct + "%";
    showFrame(state.MANIFEST.t0_index);
  }
}

export function updateRefreshTime(genDate) {
  const el = document.getElementById("refresh-time");
  if (!el) return;
  const ageMin = (Date.now() - genDate.getTime()) / 60000;
  const hm = genDate.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" });
  const rel = ageMin < 1 ? "právě teď" : ageMin < 60 ? `před ${Math.round(ageMin)} min` : `před ${Math.round(ageMin / 60)} h`;
  el.textContent = `${hm} (${rel})`;
  el.className = ageMin <= 15 ? "age-ok" : ageMin <= 45 ? "age-warn" : "age-old";
  // Varovný glyf ze stejné sady jako zbytek UI. Emoji ⚠ se navíc přidávala
  // do textContent, takže se při každém překreslení mohla nasčítat.
  if (ageMin > 45) el.innerHTML = uiIcon("warning") + esc(el.textContent);
}
