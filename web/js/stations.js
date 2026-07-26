import { state } from "./state.js";
import { esc, ageMinutes, degToCompass, beaufortLabel } from "./utils.js";
import { thinByZoom } from "./labelthin.js";

// ── WU stanice (Weather Underground PWS) ─────────────────────────────────────

export function renderWuOwnPanel() {
  const panel = document.getElementById("wu-own-panel");
  if (!state.WU || !state.WU.stations) { panel.style.display = "none"; return; }
  const own = state.WU.stations.filter(s => s.own);
  if (!own.length) { panel.style.display = "none"; return; }
  panel.style.display = "block";

  panel.innerHTML = own.map(s => {
    const age = s.time_utc ? ageMinutes(s.time_utc) : null;
    const loc = s.neighborhood || s.city || "";
    const windStr = s.wind_kmh != null
      ? Math.round(s.wind_kmh) + " km/h" + (s.wind_dir != null ? " " + degToCompass(s.wind_dir) : "")
      : "";
    const meta = [loc, windStr].filter(Boolean).map(esc).join(" · ");
    return `<div class="wu-mini-row" data-station-id="${esc(s.id)}">
      <div class="wu-mini-dot"></div>
      <div class="wu-mini-name">${esc(s.name || s.id)}</div>
      <div class="wu-mini-temp">${s.temp != null ? esc(s.temp) + "°" : "—"}</div>
      ${meta ? `<div class="wu-mini-meta">${meta}</div>` : ""}
      <div class="wu-mini-arrow">›</div>
    </div>`;
  }).join("");

  panel.querySelectorAll(".wu-mini-row").forEach(row => {
    row.addEventListener("click", () => openWuDetail(row.dataset.stationId));
  });
}

export async function openWuDetail(stationId) {
  const s = state.WU?.stations?.find(x => x.id === stationId);
  if (!s) return;
  const overlay = document.getElementById("wu-detail-overlay");
  const box = document.getElementById("wu-detail-box");
  const age = s.time_utc ? ageMinutes(s.time_utc) : null;
  const ageStr = age != null ? `před ${age} min` : "";
  const loc = [s.neighborhood, s.city].filter(Boolean).map(esc).join(", ");
  const deg = s.wind_dir ?? 0;
  const gustStr = s.gust_kmh != null ? `·${Math.round(s.gust_kmh)}` : "";
  const windVal = s.wind_kmh != null ? `${Math.round(s.wind_kmh)}${gustStr} km/h` : "—";
  const dirStr = s.wind_dir != null ? degToCompass(s.wind_dir) + " " + s.wind_dir + "°" : "";
  const cells = [
    { label: "Vlhkost", val: s.humidity != null ? s.humidity + " %" : "—" },
    { label: "Tlak", val: s.pressure != null ? Math.round(s.pressure) + " hPa" : "—" },
    { label: "Srážky/hod", val: s.precip_rate != null ? s.precip_rate + " mm" : "0 mm" },
    { label: "Srážky dnes", val: s.precip_total != null ? s.precip_total + " mm" : "0 mm" },
    ...(s.solar_radiation != null ? [{ label: "Záření", val: Math.round(s.solar_radiation) + " W/m²" }] : []),
    ...(s.uv != null ? [{ label: "UV index", val: s.uv.toFixed(1) }] : []),
    ...(s.feels != null ? [{ label: "Pocitová", val: s.feels + " °C" }] : []),
    ...(s.dewpoint != null ? [{ label: "Rosný bod", val: s.dewpoint.toFixed(1) + " °C" }] : []),
  ];
  box.innerHTML = `
    <button id="wu-detail-close">✕</button>
    <h3>★ ${esc(s.name || s.id)}</h3>
    <div class="wu-detail-sub">${[loc, esc(s.id), esc(ageStr)].filter(Boolean).join(" · ")}</div>
    <div class="wu-detail-hero">
      <div class="wu-detail-temp">${s.temp != null ? esc(s.temp) + "°" : "—"}</div>
      ${s.wind_dir != null || s.wind_kmh != null ? `
      <div style="display:flex;flex-direction:column;align-items:center;gap:.2rem">
        <div class="wu-detail-compass">
          <span class="wu-compass-label n">S</span>
          <span class="wu-compass-label s">J</span>
          <span class="wu-compass-label e">V</span>
          <span class="wu-compass-label w">Z</span>
          <div class="wu-detail-arrow">
            <svg width="44" height="44" viewBox="-22 -22 44 44">
              <polygon points="0,-19 3,7 0,3 -3,7" fill="#ef4444" transform="rotate(${deg})"/>
              <polygon points="0,19 3,-7 0,-3 -3,-7" fill="#94a3b8" transform="rotate(${deg})"/>
              <circle cx="0" cy="0" r="2.5" fill="var(--text)"/>
            </svg>
          </div>
        </div>
        <div style="font-size:.72rem;font-weight:600;text-align:center">${esc(windVal)}</div>
        <div style="font-size:.6rem;color:var(--muted);text-align:center">${esc(dirStr)}</div>
      </div>` : ""}
      <div>
        ${s.feels != null ? `<div style="font-size:.72rem;color:var(--muted)">pocitová ${esc(s.feels)}°C</div>` : ""}
        <div style="font-size:.72rem;color:var(--muted)">${esc(beaufortLabel(s.wind_kmh))}</div>
      </div>
    </div>
    <div class="wu-detail-grid">
      ${cells.map(c => `<div class="wu-detail-cell">
        <div class="wu-detail-cell-label">${esc(c.label)}</div>
        <div class="wu-detail-cell-val">${esc(c.val)}</div>
      </div>`).join("")}
    </div>
    <div id="wu-history-charts"><div style="color:var(--muted);font-size:.72rem;margin-top:.75rem">Načítám historii…</div></div>`;
  overlay.classList.add("open");
  box.querySelector("#wu-detail-close").addEventListener("click", closeWuDetail);
  await _loadAndRenderWuHistory(stationId);
}

export function closeWuDetail() {
  document.getElementById("wu-detail-overlay").classList.remove("open");
}

async function _loadAndRenderWuHistory(stationId) {
  if (!state.WU_HISTORY) {
    try {
      const r = await fetch(`data/wu_history.json?v=${encodeURIComponent(state.WU?.generated_at_utc || Date.now())}`, { cache: "no-store" });
      state.WU_HISTORY = await r.json();
    } catch {
      state.WU_HISTORY = { stations: {} };
    }
  }
  _renderWuHistory(stationId);
}

function _renderWuHistory(stationId) {
  const container = document.getElementById("wu-history-charts");
  if (!container) return;
  const hist = state.WU_HISTORY?.stations?.[stationId];
  if (!hist?.series?.length) {
    container.innerHTML = `<div style="color:var(--muted);font-size:.72rem;margin-top:.75rem">Historie stanic není k dispozici.</div>`;
    return;
  }
  const series = hist.series;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const gc = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)";
  const tc = isDark ? "#6b7280" : "#9ca3af";

  const firstDt = new Date(series[0].dt);
  const lastDt = new Date(series[series.length - 1].dt);
  const multiDay = firstDt.toDateString() !== lastDt.toDateString();
  const labels = series.map(r => {
    const d = new Date(r.dt);
    const t = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" });
    if (!multiDay) return t;
    return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", timeZone: "Europe/Prague" }) + " " + t;
  });

  const chartCfgs = [
    { key: "temp", label: "Teplota", color: "#f87171", unit: "°C", bar: false },
    { key: "humidity", label: "Vlhkost", color: "#22c55e", unit: "%", bar: false },
    { key: "pressure", label: "Tlak", color: "#a855f7", unit: "hPa", bar: false },
    { key: "wind_kmh", label: "Vítr", color: "#06b6d4", unit: "km/h", bar: false, key2: "gust_kmh", color2: "#38bdf8", label2: "Nárazy" },
    { key: "precip_rate", label: "Srážky/hod", color: "#3b82f6", unit: "mm", bar: true },
  ];

  container.innerHTML = `<div style="font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:1rem;margin-bottom:.5rem">Historie · ${series.length} záznamů</div>`;

  for (const cfg of chartCfgs) {
    const vals = series.map(r => r[cfg.key] ?? null);
    if (vals.every(v => v === null)) continue;
    const wrap = document.createElement("div");
    wrap.className = "sd-chart";
    const canvasId = "wuh_" + cfg.key;
    wrap.innerHTML = `<div class="sd-chart-head">${esc(cfg.label)} <span class="sd-chart-unit">${esc(cfg.unit)}</span></div>
      <div class="sd-chart-canvas-wrap"><canvas id="${canvasId}"></canvas></div>`;
    container.appendChild(wrap);

    const datasets = [{
      data: vals, borderColor: cfg.color,
      backgroundColor: cfg.bar ? cfg.color + "bb" : cfg.color + "25",
      borderWidth: cfg.bar ? 0 : 1.8, fill: !cfg.bar, tension: cfg.bar ? 0 : 0.35,
      spanGaps: true, pointRadius: 0,
      ...(cfg.bar ? { barPercentage: 1, categoryPercentage: 1 } : {}),
    }];
    if (cfg.key2) {
      const vals2 = series.map(r => r[cfg.key2] ?? null);
      if (vals2.some(v => v != null)) datasets.push({
        label: cfg.label2, data: vals2, borderColor: cfg.color2,
        backgroundColor: "transparent", borderWidth: 1.5, borderDash: [3, 3],
        fill: false, tension: 0.3, spanGaps: true, pointRadius: 0,
      });
    }
    new Chart(document.getElementById(canvasId), {
      type: cfg.bar ? "bar" : "line",
      data: { labels, datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: !!cfg.key2, labels: { color: tc, font: { size: 10 }, boxWidth: 12, padding: 8 } },
          tooltip: { mode: "index", intersect: false },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, color: tc, font: { size: 10 } }, grid: { color: gc } },
          y: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } },
        },
      },
    });
  }
}

export function renderWuMarkers() {
  state.wuMarkers.forEach(m => m.remove());
  state.wuMarkers = [];
  if (!state.WU || !state.WU.stations || !state.map) return;

  state.WU.stations.forEach(s => {
    const icon = L.divIcon({
      className: "",
      html: `<div class="${s.own ? "wu-marker-own" : "wu-marker-other"}"></div>`,
      iconSize: s.own ? [14, 14] : [10, 10],
      iconAnchor: s.own ? [7, 7] : [5, 5],
    });

    const windDir = s.wind_dir != null ? degToCompass(s.wind_dir) : "—";
    const age = s.time_utc ? ageMinutes(s.time_utc) : null;
    const ageStr = age != null ? `<span style="color:var(--muted);font-size:.7rem"> před ${age} min</span>` : "";

    const popup = `
      <div class="wu-popup">
        <strong>${esc(s.name || s.id)}</strong>
        ${s.own ? '<span class="wu-own-badge"> ★ MOJE</span>' : ""}${ageStr}<br>
        🌡️ ${s.temp != null ? esc(s.temp) + " °C" : "—"}
        ${s.feels != null && Math.abs(s.feels - s.temp) >= 2 ? `<small style="color:var(--muted)">(pocit ${esc(s.feels)}°)</small>` : ""}<br>
        💧 ${s.humidity != null ? esc(s.humidity) + " %" : "—"} &nbsp;
        🌬️ ${s.wind_kmh != null ? esc(s.wind_kmh) + " km/h " + esc(windDir) : "—"}
        ${s.gust_kmh > 0 ? `<small>(nárazy ${esc(s.gust_kmh)})</small>` : ""}<br>
        🔵 ${s.pressure != null ? esc(s.pressure) + " hPa" : "—"} &nbsp;
        🌧️ ${s.precip_rate != null ? esc(s.precip_rate) + " mm/h" : "—"}
        <br><small style="color:var(--muted)">${esc(s.id)}</small>
      </div>`;

    const marker = L.marker([s.lat, s.lon], { icon, zIndexOffset: s.own ? 1000 : 100 })
      .bindPopup(popup)
      .addTo(state.map);
    state.wuMarkers.push(marker);
  });
}

// ── ČHMÚ stanice ──────────────────────────────────────────────────────────────

export function chmiMarkerColor(layer, value) {
  if (value == null) return "#94a3b8";
  if (layer === "temp" || layer === "dewpoint") {
    if (value <= -15) return "#bfdbfe";
    if (value <= -5) return "#38bdf8";
    if (value <= 0) return "#67e8f9";
    if (value <= 5) return "#34d399";
    if (value <= 10) return "#86efac";
    if (value <= 15) return "#fde68a";
    if (value <= 20) return "#fbbf24";
    if (value <= 25) return "#f97316";
    if (value <= 30) return "#ef4444";
    return "#b91c1c";
  }
  if (layer === "humidity") {
    if (value < 30) return "#f97316";
    if (value < 50) return "#fbbf24";
    if (value < 70) return "#34d399";
    if (value < 85) return "#38bdf8";
    return "#3b82f6";
  }
  if (layer === "wind_kmh") {
    if (value < 10) return "#34d399";
    if (value < 30) return "#fbbf24";
    if (value < 50) return "#f97316";
    if (value < 75) return "#ef4444";
    return "#b91c1c";
  }
  if (layer === "precip_1h") {
    if (value === 0 || value == null) return "#94a3b8";
    if (value < 0.3) return "#bfdbfe";
    if (value < 1) return "#7dd3fc";
    if (value < 3) return "#3b82f6";
    if (value < 10) return "#1d4ed8";
    return "#1e3a8a";
  }
  if (layer === "snow_cm") {
    if (value <= 0) return "#94a3b8";
    if (value < 2) return "#e0f2fe";
    if (value < 10) return "#bae6fd";
    if (value < 30) return "#7dd3fc";
    if (value < 60) return "#38bdf8";
    return "#0284c7";
  }
  if (layer === "pressure") {
    if (value < 985) return "#f97316";
    if (value < 1000) return "#fbbf24";
    if (value < 1015) return "#34d399";
    if (value < 1025) return "#38bdf8";
    return "#3b82f6";
  }
  if (layer === "solar") {
    if (value < 20) return "#94a3b8";
    if (value < 100) return "#fde68a";
    if (value < 300) return "#fbbf24";
    if (value < 600) return "#f59e0b";
    return "#d97706";
  }
  if (layer === "visibility_m") {
    if (value < 200) return "#7c3aed";
    if (value < 1000) return "#ef4444";
    if (value < 5000) return "#f97316";
    if (value < 10000) return "#fbbf24";
    return "#34d399";
  }
  return "#10b981";
}

function chmiMarkerText(layer, s) {
  const v = s[layer];
  if (v == null) return "—";
  if (layer === "temp" || layer === "dewpoint") return v.toFixed(1) + "°";
  if (layer === "humidity") return Math.round(v) + "%";
  if (layer === "wind_kmh") return Math.round(v) + "km";
  if (layer === "precip_1h") return v.toFixed(1) + "mm";
  if (layer === "snow_cm") return Math.round(v) + "cm";
  if (layer === "pressure") return Math.round(v) + "";
  if (layer === "solar") return Math.round(v) + "W";
  if (layer === "visibility_m") {
    if (v >= 10000) return "≥10km";
    if (v >= 1000) return (v / 1000).toFixed(1) + "km";
    return Math.round(v) + "m";
  }
  return String(v);
}

export function renderChmiMarkers() {
  state.chmiMarkers.forEach(m => m.remove());
  state.chmiMarkers = [];
  // Tlačítko Teploty schovává VŠECHNY popisky stanic, ne jen letištní —
  // jinak by "skrytí kvůli lepšímu výhledu na mapu" nechalo tu hustší
  // českou vrstvu svítit dál a nic by to nevyřešilo.
  if (!state.tempsOn) return;
  if (!state.CHMI || !state.CHMI.stations || !state.map) return;

  // Prořezání podle zoomu: 296 stanic naráz je při oddálení souvislá plocha
  // štítků, pod kterou není vidět mapa ani radar. Při oddálení se ukazují
  // hlavní klimatologické stanice, přiblížení postupně odkrývá místní.
  const zoom = state.map.getZoom?.() ?? 8;
  const candidates = state.CHMI.stations.filter(s => {
    if (s.lat == null || s.lon == null) return false;
    const val = s[state.chmiLayer];
    return state.chmiLayer === "temp" || val != null;
  });
  // Ve výřezu se prořezává jen to, co je vidět — jinak by stanice za okrajem
  // obrazovky "vyhrávaly" buňky a ubíraly místa těm viditelným.
  const bounds = state.map.getBounds?.();
  const inView = typeof bounds?.contains === "function"
    ? candidates.filter(s => bounds.contains([s.lat, s.lon]))
    : candidates;
  const shown = thinByZoom(inView.length ? inView : candidates, zoom);

  shown.forEach(s => {
    const val = s[state.chmiLayer];

    const color = chmiMarkerColor(state.chmiLayer, val);
    const text = chmiMarkerText(state.chmiLayer, s);
    const w = Math.max(36, text.length * 8 + 10);

    const icon = L.divIcon({
      className: "",
      html: `<div class="temp-label-marker" style="background:${color};width:${w}px">${esc(text)}</div>`,
      iconSize: [w, 20],
      iconAnchor: [w / 2, 10],
    });

    const windDir = s.wind_dir != null ? degToCompass(s.wind_dir) : "—";
    const age = s.time_utc ? ageMinutes(s.time_utc) : null;
    const ageStr = age != null ? `<span style="color:var(--muted);font-size:.7rem"> · před ${age} min</span>` : "";
    const stationId = s.id;
    const elev = s.elev != null ? ` · ${Math.round(s.elev)} m` : "";

    const popup = `
      <div class="wu-popup">
        <strong>${esc(s.name || s.id)}</strong>
        <span style="color:#10b981;font-size:.7rem"> ● ČHMÚ</span>${ageStr}${esc(elev)}<br>
        🌡️ ${s.temp != null ? esc(s.temp) + " °C" : "—"} &nbsp;
        💧 ${s.humidity != null ? esc(s.humidity) + " %" : "—"}
        ${s.dewpoint != null ? "<small>ros. bod " + esc(s.dewpoint.toFixed(1)) + " °C</small>" : ""}<br>
        🌬️ ${s.wind_kmh != null ? esc(s.wind_kmh) + " km/h " + esc(windDir) : "—"}
        ${s.gust_kmh != null ? `<small>(nárazy ${esc(s.gust_kmh)})</small>` : ""}<br>
        🔵 ${s.pressure != null ? esc(s.pressure) + " hPa" : "—"} &nbsp;
        🌧️ ${s.precip_1h != null ? esc(s.precip_1h.toFixed(1)) + " mm/hod" : s.precip_10m != null ? esc(s.precip_10m.toFixed(1)) + " mm/10min" : "—"}${s.precip_24h != null ? " &nbsp;<small>(24h: " + esc(s.precip_24h.toFixed(1)) + " mm)</small>" : ""}<br>
        ${s.snow_cm != null && s.snow_cm > 0 ? "❄️ Sníh: " + esc(Math.round(s.snow_cm)) + " cm &nbsp;" : ""}
        ${s.visibility_m != null ? "👁️ " + esc(s.visibility_m >= 1000 ? (s.visibility_m / 1000).toFixed(1) + " km" : Math.round(s.visibility_m) + " m") : ""}
        <br><small style="color:var(--muted)">${esc(s.id)}</small>
        <br><button class="chmi-detail-btn" data-station-id="${esc(stationId)}"
          style="margin-top:.4rem;padding:.35rem .7rem;font-size:.78rem;cursor:pointer;min-height:32px;
                 background:#10b981;color:#fff;border:none;border-radius:6px;">
          Detaily →
        </button>
      </div>`;

    const marker = L.marker([s.lat, s.lon], { icon, zIndexOffset: 50 })
      .bindPopup(popup)
      .addTo(state.map);
    marker.on("popupopen", () => {
      document.querySelector(`.chmi-detail-btn[data-station-id="${CSS.escape(stationId)}"]`)
        ?.addEventListener("click", () => openChmiDetail(stationId));
    });
    state.chmiMarkers.push(marker);
  });
}

// ── Station detail helpers (sparkline + karty) ───────────────────────────────

let _sdSparkId = 0;
function makeSpark(vals, color, h) {
  h = h || 38;
  const v = vals.filter(x => x != null);
  if (v.length < 2) return "";
  const mn = Math.min(...v), mx = Math.max(...v), rng = mx - mn || 1;
  const W = 200, H = h, pad = H * 0.1;
  const toY = val => H - pad - ((val - mn) / rng) * (H - pad * 2);
  const points = vals.map((val, i) => {
    if (val == null) return null;
    return (i / (vals.length - 1) * W).toFixed(1) + "," + toY(val).toFixed(1);
  }).filter(Boolean).join(" ");
  const poly = "0," + H + " " + vals.map((val, i) => {
    const x = (i / (vals.length - 1) * W).toFixed(1);
    const y = val != null ? toY(val).toFixed(1) : H;
    return x + "," + y;
  }).join(" ") + " " + W + "," + H;
  const gid = "sg" + (++_sdSparkId);
  return `<svg class="sd-spark" viewBox="0 0 ${W} ${H}" height="${H}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".4"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${poly}" fill="url(#${gid})"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function sdCard(key, label, icon, color, unit, fmtFn, series) {
  const vals = series.map(r => r[key] ?? null);
  const valid = vals.filter(v => v != null);
  if (!valid.length) return "";
  const cur = valid[valid.length - 1];
  const mn = Math.min(...valid);
  const mx = Math.max(...valid);
  const pct = ((cur - mn) / (mx - mn || 1) * 100).toFixed(1);
  return `<div class="sd-card">
    <div class="sd-card-lbl">${icon} ${esc(label)}</div>
    <div class="sd-val">${esc(fmtFn(cur))}<span class="sd-val-unit">${esc(unit)}</span></div>
    <div class="sd-bar-track"><div class="sd-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="sd-minmax"><span>MIN <b>${esc(fmtFn(mn))}</b></span><span>MAX <b>${esc(fmtFn(mx))}</b></span></div>
    ${makeSpark(vals, color)}
  </div>`;
}

let _chmiSeriesCache = {}; // stationId → payload (lazy, per-station)
let _chmiCharts = [];
let _chmiActiveTab = "dnes";

function _makeChart(canvas, type, labels, vals, color, fill, unit) {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const gridColor = isDark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.07)";
  const textColor = isDark ? "#8b909a" : "#6b7280";
  const isBar = type === "bar";
  const chart = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{
        data: vals, borderColor: color,
        backgroundColor: isBar ? color + "cc" : fill ? color + "22" : "transparent",
        borderWidth: isBar ? 0 : 1.5, pointRadius: 0, fill: fill && !isBar,
        tension: 0.3, spanGaps: true,
      }],
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y} ${unit}` } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
      },
    },
  });
  _chmiCharts.push(chart);
  return chart;
}

function _renderTabDnes(body, stationId) {
  const station = _chmiSeriesCache[stationId];
  if (!station?.series?.length) {
    body.innerHTML = `<div style="color:var(--muted);padding:1rem">Časové řady nejsou k dispozici.</div>`;
    return;
  }
  const series = station.series;
  const obs = state.CHMI?.stations?.find(x => x.id === stationId);
  const firstDt = series.length ? new Date(series[0].dt) : null;
  const lastDt = series.length ? new Date(series[series.length - 1].dt) : null;
  const multiDay = firstDt && lastDt && firstDt.toDateString() !== lastDt.toDateString();
  const labels = series.map(r => {
    const d = new Date(r.dt);
    const t = d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Prague" });
    if (!multiDay) return t;
    const day = d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", timeZone: "Europe/Prague" });
    return `${day} ${t}`;
  });

  body.innerHTML = "";

  if (obs) {
    const tempVals = series.map(r => r.temp ?? null).filter(v => v != null);
    const tMax = tempVals.length ? Math.max(...tempVals).toFixed(1) : null;
    const tMin = tempVals.length ? Math.min(...tempVals).toFixed(1) : null;
    const age = obs.time_utc ? ageMinutes(obs.time_utc) : null;
    const hero = document.createElement("div");
    hero.className = "sd-hero";
    hero.innerHTML = `
      <div class="sd-hero-temp" style="color:#f87171">${obs.temp != null ? esc(obs.temp) + "°C" : "—"}</div>
      <div class="sd-hero-row">
        ${tMax ? `<span>▲ <b>${esc(tMax)}°</b></span>` : ""}
        ${tMin ? `<span>▼ <b>${esc(tMin)}°</b></span>` : ""}
        ${obs.humidity != null ? `<span>💧 <b>${esc(obs.humidity)} %</b></span>` : ""}
        ${obs.wind_kmh != null ? `<span>🌬 <b>${esc(obs.wind_kmh)} km/h</b></span>` : ""}
        ${obs.pressure != null ? `<span>⏱ <b>${esc(obs.pressure)} hPa</b></span>` : ""}
        ${obs.precip_24h != null ? `<span>🌧 <b>${esc(obs.precip_24h)} mm/24h</b></span>` : ""}
        ${age != null ? `<span style="margin-left:auto">před ${age} min</span>` : ""}
      </div>`;
    body.appendChild(hero);
  }

  const fmt1 = v => v != null ? v.toFixed(1) : "—";
  const fmt0 = v => v != null ? Math.round(v) : "—";
  const cards = [
    sdCard("temp", "Teplota", "🌡", "#f87171", "°C", fmt1, series),
    sdCard("humidity", "Vlhkost", "💧", "#22c55e", "%", fmt0, series),
    sdCard("dewpoint", "Rosný bod", "🌫", "#a78bfa", "°C", fmt1, series),
    sdCard("pressure", "Tlak", "⏱", "#a855f7", "hPa", fmt0, series),
    sdCard("wind_kmh", "Vítr", "🌬", "#06b6d4", "km/h", fmt0, series),
    sdCard("gust_kmh", "Nárazy", "💨", "#38bdf8", "km/h", fmt0, series),
    sdCard("precip_1h", "Srážky/hod", "🌧", "#3b82f6", "mm", fmt1, series),
    sdCard("snow_cm", "Sníh", "❄", "#bae6fd", "cm", fmt0, series),
    sdCard("solar", "Záření", "☀", "#f59e0b", "W/m²", fmt0, series),
    sdCard("visibility_m", "Viditelnost", "👁", "#94a3b8", "m", fmt0, series),
  ].filter(Boolean);

  if (cards.length) {
    const sec = document.createElement("div");
    sec.className = "sd-section";
    sec.innerHTML = `<div class="sd-section-label">Aktuální hodnoty · 24h přehled</div><div class="sd-grid2">${cards.join("")}</div>`;
    body.appendChild(sec);
  }

  const chartCfgs = [
    { key: "temp", label: "Teplota", color: "#f87171", fill: true, unit: "°C", bar: false },
    { key: "humidity", label: "Vlhkost vzduchu", color: "#22c55e", fill: true, unit: "%", bar: false },
    { key: "pressure", label: "Tlak", color: "#a855f7", fill: false, unit: "hPa", bar: false },
    { key: "wind_kmh", label: "Vítr", color: "#06b6d4", fill: true, unit: "km/h", bar: false, key2: "gust_kmh", color2: "#38bdf8", label2: "Nárazy" },
    { key: "precip_1h", label: "Srážky / hod", color: "#3b82f6", fill: true, unit: "mm", bar: true },
    { key: "solar", label: "Sluneční záření", color: "#f59e0b", fill: true, unit: "W/m²", bar: false },
  ];

  for (const cfg of chartCfgs) {
    const vals = series.map(r => r[cfg.key] ?? null);
    if (vals.every(v => v === null)) continue;
    const wrap = document.createElement("div");
    wrap.className = "sd-chart";
    const canvasId = "sdc_" + cfg.key;
    wrap.innerHTML = `<div class="sd-chart-head">${esc(cfg.label)} <span class="sd-chart-unit">${esc(cfg.unit)}</span></div>
      <div class="sd-chart-canvas-wrap"><canvas id="${canvasId}"></canvas></div>`;
    body.appendChild(wrap);

    const isDark2 = document.documentElement.getAttribute("data-theme") !== "light";
    const gc = isDark2 ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)";
    const tc = isDark2 ? "#6b7280" : "#9ca3af";
    const valid = vals.filter(v => v != null);
    const vMin = valid.length ? Math.min(...valid) : 0;
    const vMax = valid.length ? Math.max(...valid) : 1;

    const datasets = [{
      data: vals, borderColor: cfg.color,
      backgroundColor: cfg.fill ? cfg.color + "25" : "transparent",
      borderWidth: cfg.bar ? 0 : 1.8, fill: cfg.fill && !cfg.bar, tension: cfg.bar ? 0 : 0.35,
      spanGaps: true, pointRadius: 0,
      ...(cfg.bar ? { backgroundColor: cfg.color + "bb", barPercentage: 1, categoryPercentage: 1 } : {}),
    }];
    if (cfg.key2) {
      const vals2 = series.map(r => r[cfg.key2] ?? null);
      if (vals2.some(v => v != null)) {
        datasets.push({
          label: cfg.label2, data: vals2, borderColor: cfg.color2,
          backgroundColor: "transparent", borderWidth: 1.5, borderDash: [3, 3],
          fill: false, tension: 0.3, spanGaps: true, pointRadius: 0,
        });
      }
    }
    if (valid.length) {
      datasets.push({ data: Array(vals.length).fill(vMax), borderColor: cfg.color + "55", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, tension: 0, spanGaps: true });
      datasets.push({ data: Array(vals.length).fill(vMin), borderColor: cfg.color + "55", borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, tension: 0, spanGaps: true });
    }

    const chart = new Chart(document.getElementById(canvasId), {
      type: cfg.bar ? "bar" : "line",
      data: { labels, datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: !!cfg.key2, labels: { color: tc, font: { size: 10 }, boxWidth: 12, padding: 8 } },
          tooltip: {
            callbacks: {
              afterBody: ctx => {
                const v = ctx[0]?.parsed?.y;
                if (v == null || !valid.length) return "";
                const lines = [];
                if (Math.abs(v - vMax) < 0.01) lines.push("▲ maximum");
                if (Math.abs(v - vMin) < 0.01) lines.push("▼ minimum");
                return lines;
              },
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 6, color: tc, font: { size: 10 } }, grid: { color: gc } },
          y: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } },
        },
      },
    });
    _chmiCharts.push(chart);
  }
}

function _renderTabRekordy(body, stationId) {
  const stats = state.CHMI_STATS?.stations?.[stationId];
  if (!stats?.records || Object.keys(stats.records).length === 0) {
    body.innerHTML = `<div style="color:var(--muted);padding:1rem">Historická data pro tuto stanici nejsou k dispozici.<br><small>Stanice nemusí mít historická data v archivu ČHMÚ.</small></div>`;
    return;
  }
  const LABELS = {
    temp_max: ["Nejvyšší teplota", "°C", "🌡️"], temp_min: ["Nejnižší teplota", "°C", "❄️"],
    temp_avg: ["Průměrná teplota", "°C", "📊"], precip: ["Max. srážky za měsíc", "mm", "🌧️"],
    gust_kmh: ["Max. náraz větru", "km/h", "💨"], snow_cm: ["Max. výška sněhu", "cm", "❄️"],
    sunshine_h: ["Max. svit za měsíc", "h", "☀️"],
  };
  let html = `<div style="display:grid;gap:.6rem;padding:.5rem 0">`;
  for (const [key, rec] of Object.entries(stats.records)) {
    const [label, unit, icon] = LABELS[key] || [key, "", ""];
    const date = rec.date ? `<span style="color:var(--muted);font-size:.7rem">${esc(rec.date.slice(0, 10))}</span>` : "";
    html += `<div style="display:flex;justify-content:space-between;align-items:baseline;
               padding:.4rem .5rem;background:var(--bg);border-radius:6px;border:1px solid var(--border)">
      <span>${icon} ${esc(label)}</span>
      <span style="font-weight:700">${esc(rec.value)} ${esc(unit)} ${date}</span>
    </div>`;
  }
  html += `</div>`;
  body.innerHTML = html;
}

function _renderTabKlima(body, stationId) {
  const stats = state.CHMI_STATS?.stations?.[stationId];
  const normals = stats?.monthly_normals;
  if (!normals || Object.keys(normals).length === 0) {
    body.innerHTML = `<div style="color:var(--muted);padding:1rem">Klimatologické normály zatím nejsou k dispozici.</div>`;
    return;
  }
  const months = ["Led", "Úno", "Bře", "Dub", "Kvě", "Čer", "Čvc", "Srp", "Zář", "Říj", "Lis", "Pro"];
  const avgTemps = months.map((_, i) => normals[String(i + 1)]?.temp_avg ?? null);
  const precips = months.map((_, i) => normals[String(i + 1)]?.precip ?? null);

  body.innerHTML = "";
  if (avgTemps.some(v => v !== null)) {
    const block = document.createElement("div");
    block.className = "chmi-chart-block";
    block.innerHTML = `<h4>Průměrná teplota (°C) — měsíční normál</h4><div class="chmi-chart-block-inner"><canvas></canvas></div>`;
    body.appendChild(block);
    _makeChart(block.querySelector("canvas"), "bar", months, avgTemps, "#f59e0b", false, "°C");
  }
  if (precips.some(v => v !== null)) {
    const block = document.createElement("div");
    block.className = "chmi-chart-block";
    block.innerHTML = `<h4>Průměrné srážky (mm) — měsíční normál</h4><div class="chmi-chart-block-inner"><canvas></canvas></div>`;
    body.appendChild(block);
    _makeChart(block.querySelector("canvas"), "bar", months, precips, "#06b6d4", false, "mm");
  }
}

function _renderTabRocni(body, stationId) {
  const stats = state.CHMI_STATS?.stations?.[stationId];
  const trend = stats?.yearly_trend;
  if (!trend || Object.keys(trend).length === 0) {
    body.innerHTML = `<div style="color:var(--muted);padding:1rem">Roční přehled zatím není k dispozici.</div>`;
    return;
  }
  const years = Object.keys(trend).sort();
  const avgTemps = years.map(y => trend[y].temp_avg ?? null);
  const maxTemps = years.map(y => trend[y].temp_max ?? null);
  const minTemps = years.map(y => trend[y].temp_min ?? null);
  const precipTot = years.map(y => trend[y].precip_total ?? null);

  body.innerHTML = "";
  if (avgTemps.some(v => v !== null)) {
    const block = document.createElement("div");
    block.className = "chmi-chart-block";
    block.innerHTML = `<h4>Průměrná roční teplota (°C)</h4><div class="chmi-chart-block-inner"><canvas></canvas></div>`;
    body.appendChild(block);
    _makeChart(block.querySelector("canvas"), "line", years, avgTemps, "#f59e0b", true, "°C");
  }
  if (precipTot.some(v => v !== null)) {
    const block = document.createElement("div");
    block.className = "chmi-chart-block";
    block.innerHTML = `<h4>Roční úhrn srážek (mm)</h4><div class="chmi-chart-block-inner"><canvas></canvas></div>`;
    body.appendChild(block);
    _makeChart(block.querySelector("canvas"), "bar", years, precipTot, "#06b6d4", false, "mm");
  }
  if (maxTemps.some(v => v !== null) && minTemps.some(v => v !== null)) {
    const block = document.createElement("div");
    block.className = "chmi-chart-block";
    block.innerHTML = `<h4>Roční teplotní extrémy (°C)</h4><div class="chmi-chart-block-inner"><canvas></canvas></div>`;
    body.appendChild(block);
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const gc = isDark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.07)";
    const tc = isDark ? "#8b909a" : "#6b7280";
    const chart = new Chart(block.querySelector("canvas"), {
      type: "line",
      data: {
        labels: years, datasets: [
          { label: "Max", data: maxTemps, borderColor: "#ef4444", backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 2, tension: 0.3, spanGaps: true },
          { label: "Min", data: minTemps, borderColor: "#38bdf8", backgroundColor: "transparent", borderWidth: 1.5, pointRadius: 2, tension: 0.3, spanGaps: true },
        ],
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, labels: { color: tc, font: { size: 10 } } } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: tc, font: { size: 10 } }, grid: { color: gc } },
          y: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } },
        },
      },
    });
    _chmiCharts.push(chart);
  }
}

export async function openChmiDetail(stationId) {
  const panel = document.getElementById("chmi-detail");
  const body = document.getElementById("chmi-detail-body");
  const s = state.CHMI?.stations?.find(x => x.id === stationId);
  document.getElementById("chmi-detail-name").textContent = s?.name || stationId;
  panel.classList.add("open");

  if (!_chmiSeriesCache[stationId]) {
    body.innerHTML = `<div style="color:var(--muted);font-size:.85rem;padding:1rem">Načítám data…</div>`;
    try {
      const r = await fetch(`data/chmi_series/${encodeURIComponent(stationId)}.json?v=${encodeURIComponent(state.CHMI?.generated_at_utc || Date.now())}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      _chmiSeriesCache[stationId] = await r.json();
    } catch (e) {
      body.innerHTML = `<div style="color:var(--muted);padding:1rem">Data nejsou dostupná (${esc(e.message)}).</div>`;
      return;
    }
  }

  // Rekordy/klimatologie/roční trend — jeden společný soubor pro všechny
  // stanice, ale líní: stáhne se jen když uživatel doopravdy otevře detail
  // (ne při každém načtení stránky).
  if (!state.CHMI_STATS) {
    try {
      const r = await fetch(`data/chmi_stats.json?v=${encodeURIComponent(state.CHMI?.generated_at_utc || Date.now())}`, { cache: "no-store" });
      if (r.ok) state.CHMI_STATS = await r.json();
    } catch { /* rekordy/klima taby prostě zůstanou prázdné */ }
  }

  _renderChmiTabs(body, stationId, _chmiActiveTab);
}

function _renderChmiTabs(body, stationId, activeTab) {
  _chmiCharts.forEach(c => c.destroy());
  _chmiCharts = [];
  _chmiActiveTab = activeTab;

  const tabs = [
    { id: "dnes", label: "Dnes (24h)" },
    { id: "rekordy", label: "Rekordy" },
    { id: "klima", label: "Klimatologie" },
    { id: "rocni", label: "Roční trend" },
  ];

  let tabsHtml = `<div style="display:flex;gap:.3rem;padding:.5rem 0 .75rem;border-bottom:1px solid var(--border);flex-wrap:wrap">`;
  for (const t of tabs) {
    const active = t.id === activeTab ? "background:#10b981;color:#fff;border-color:#10b981" : "";
    tabsHtml += `<button class="chmi-tab-btn" data-tab="${t.id}"
      style="padding:.35rem .65rem;border-radius:5px;border:1px solid var(--border);min-height:32px;
             background:transparent;color:var(--text);cursor:pointer;font-size:.75rem;${active}">
      ${esc(t.label)}</button>`;
  }
  tabsHtml += `</div><div id="chmi-tab-content" style="flex:1;overflow-y:auto;padding:.5rem 0"></div>`;
  body.innerHTML = tabsHtml;

  body.querySelectorAll(".chmi-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => _renderChmiTabs(body, stationId, btn.dataset.tab));
  });

  const content = document.getElementById("chmi-tab-content");
  if (activeTab === "dnes") _renderTabDnes(content, stationId);
  if (activeTab === "rekordy") _renderTabRekordy(content, stationId);
  if (activeTab === "klima") _renderTabKlima(content, stationId);
  if (activeTab === "rocni") _renderTabRocni(content, stationId);
}

export function closeChmiDetail() {
  document.getElementById("chmi-detail").classList.remove("open");
  _chmiCharts.forEach(c => c.destroy());
  _chmiCharts = [];
}
