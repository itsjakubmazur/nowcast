import { state } from "./state.js";
import { wcIconSvg, wcLabel, mostSevere } from "./icons.js";
import { uvClass, esc } from "./utils.js";
import { isDarkTheme } from "./theme.js";

const N_HOURLY = 6;
const BLOCK_H = 3;

function _nn(v, def = 0) { return v != null ? v : def; }

function nowPragueStr() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" });
  return s.slice(0, 10) + "T" + s.slice(11, 14) + "00";
}

export function parseFc24(data) {
  const nowPrague = nowPragueStr();
  const h = data.hourly || {};
  const times = h.time || [];
  const wc = h.weather_code || [];
  const temp = h.temperature_2m || [];
  const feels = h.apparent_temperature || [];
  const prec = h.precipitation || [];
  const prob = h.precipitation_probability || [];
  const wind = h.wind_speed_10m || [];
  const gust = h.wind_gusts_10m || [];
  const wdir = h.wind_direction_10m || [];
  const uv = h.uv_index || [];
  const cape = h.cape || [];
  const hum = h.relative_humidity_2m || [];
  const pres = h.surface_pressure || [];

  let si = times.findIndex(t => t >= nowPrague);
  if (si < 0) si = 0;

  const hourly = [];
  for (let k = 0; k < 24 && si + k < times.length; k++) {
    const i = si + k;
    const t = temp[i], f = feels[i];
    const feelsDiff = (t != null && f != null) ? Math.round(f) - Math.round(t) : null;
    hourly.push({
      t: times[i].slice(11, 16),
      iso: times[i],
      wc: wc[i] ?? null,
      temp: t != null ? Math.round(t) : null,
      tempRaw: t,
      feelsDiff,
      feelsRaw: f,
      precip: Math.round(_nn(prec[i]) * 10) / 10,
      prob: Math.round(_nn(prob[i])),
      wind: Math.round(_nn(wind[i])),
      gust: gust[i] != null ? Math.round(gust[i]) : null,
      wind_dir: wdir[i] != null ? Math.round(wdir[i]) : null,
      uv: uv[i] != null ? Math.round(uv[i] * 10) / 10 : null,
      cape: cape[i] != null ? Math.round(cape[i]) : null,
      humidity: hum[i] != null ? Math.round(hum[i]) : null,
      pressure: pres[i] != null ? Math.round(pres[i]) : null,
    });
  }

  const first6 = hourly.slice(0, N_HOURLY);
  const blocks = [];
  let i = si + N_HOURLY;
  const end = si + 24;
  while (i < end && i < times.length) {
    const ie = Math.min(i + BLOCK_H, end, times.length);
    const sl = arr => arr.slice(i, ie).filter(v => v != null);
    const tsl = sl(temp), psl = sl(prec), prbsl = sl(prob), gsl = sl(gust);
    const tFrom = times[i].slice(11, 16);
    const tTo = times[Math.min(ie, times.length - 1)].slice(11, 16);
    blocks.push({
      t: `${tFrom}–${tTo}`,
      wc: mostSevere(wc.slice(i, ie)),
      tmin: tsl.length ? Math.round(Math.min(...tsl)) : null,
      tmax: tsl.length ? Math.round(Math.max(...tsl)) : null,
      precip: psl.length ? Math.round(psl.reduce((a, b) => a + b, 0) * 10) / 10 : 0,
      prob: prbsl.length ? Math.max(...prbsl) : 0,
      gust: gsl.length ? Math.round(Math.max(...gsl)) : 0,
    });
    i += BLOCK_H;
  }
  return { hourly: first6, hourlyFull: hourly, blocks };
}

export function parseMinutely15(data) {
  const m = data.minutely_15 || {};
  const times = m.time || [];
  const nowPrague = nowPragueStr();
  let si = times.findIndex(t => t >= nowPrague);
  if (si < 0) si = 0;
  const out = [];
  for (let k = 0; k < 16 && si + k < times.length; k++) {
    const i = si + k;
    out.push({
      t: times[i].slice(11, 16),
      precip: m.precipitation?.[i] ?? null,
      gust: m.windgusts_10m?.[i] ?? null,
      wind: m.windspeed_10m?.[i] ?? null,
      wind_dir: m.winddirection_10m?.[i] ?? null,
      cape: m.cape?.[i] ?? null,
    });
  }
  return out;
}

export function renderFcHero(fc) {
  const now = fc.hourly[0];
  const hero = document.getElementById("fc-hero");
  if (!now || now.temp == null) { hero.style.display = "none"; return; }
  const tempEl = document.getElementById("fc-temp-big");
  const iconEl = document.getElementById("fc-hero-icon");
  const descEl = document.getElementById("fc-desc");
  const feelsEl = document.getElementById("fc-feels");

  tempEl.textContent = now.temp + "°";
  tempEl.className = "fc-temp-big" + (now.temp < 5 ? " cold" : "");
  const hour = parseInt(now.t);
  if (iconEl) iconEl.innerHTML = now.wc != null ? wcIconSvg(now.wc, hour) : "";
  descEl.textContent = now.wc != null ? wcLabel(now.wc) : "";
  feelsEl.textContent = now.feels != null && Math.abs(now.feelsRaw - now.tempRaw) >= 2
    ? `Pocitová ${Math.round(now.feelsRaw)}°` : "";
  hero.style.display = "flex";
}

export function renderFcNow(fc, minutely) {
  const el = document.getElementById("fc-now");
  const now = fc.hourly[0];
  if (!now) { el.style.display = "none"; return; }

  const windDir = now.wind_dir != null ? degCompass(now.wind_dir) : "";
  const windVal = now.wind != null
    ? `${now.wind}${now.gust != null ? "·" + now.gust : ""} km/h${windDir ? " " + windDir : ""}`
    : "—";

  const humPct = now.humidity != null ? now.humidity : null;
  const windPct = now.wind != null ? Math.min(now.wind / 120 * 100, 100) : null;
  const precipPct = (now.precip ?? 0) > 0 ? Math.min(now.precip / 20 * 100, 100) : 0;
  const pressPct = now.pressure != null ? Math.min(Math.max((now.pressure - 960) / (1040 - 960) * 100, 0), 100) : null;

  // Nejbližší 15min krok s nejvyšším nárazem — jemnější detail než hodinové maximum
  const nearGust = minutely?.length ? Math.max(...minutely.map(m => m.gust ?? 0)) : null;

  const stats = [
    { label: "Vítr", val: windVal, color: "#06b6d4", pct: windPct },
    { label: "Vlhkost", val: now.humidity != null ? now.humidity + " %" : "—", color: "#22c55e", pct: humPct },
    { label: "Tlak", val: now.pressure != null ? now.pressure + " hPa" : "—", color: "#a855f7", pct: pressPct },
    { label: "Srážky", val: (now.precip ?? 0) > 0 ? now.precip + " mm" : "0 mm", color: "#3b82f6", pct: precipPct },
    ...(now.uv != null ? [{ label: "UV index", val: String(now.uv), color: "#f59e0b", pct: Math.min(now.uv / 11 * 100, 100) }] : []),
    ...(now.cape != null && now.cape >= 200 ? [{ label: "CAPE", val: now.cape + " J/kg", color: "#ef4444", pct: Math.min(now.cape / 3000 * 100, 100) }] : []),
    ...(nearGust != null && nearGust >= 25 ? [{ label: "Náraz (15min)", val: Math.round(nearGust) + " km/h", color: "#0ea5e9", pct: Math.min(nearGust / 120 * 100, 100) }] : []),
  ];

  el.style.display = "block";
  el.innerHTML = `<div class="fc-stats">
    ${stats.map(s => `<div class="fc-stat">
      <div class="fc-stat-label">${esc(s.label)}</div>
      <div class="fc-stat-val">${esc(s.val)}</div>
      ${s.pct != null ? `<div class="fc-stat-bar"><div class="fc-stat-bar-fill" style="width:${s.pct.toFixed(0)}%;background:${s.color}"></div></div>` : ""}
    </div>`).join("")}
  </div>`;
}

function degCompass(deg) {
  const dirs = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
  return dirs[Math.round(deg / 22.5) % 16];
}

export function renderFc24(fc, label) {
  const el = document.getElementById("fc24");
  const scroll = document.getElementById("fc24-scroll");
  document.getElementById("fc24-place").textContent = label || "—";
  scroll.innerHTML = "";

  for (const h of fc.hourly) {
    const col = document.createElement("div");
    col.className = "fc24-col";
    const feelsStr = h.feelsDiff != null && Math.abs(h.feelsDiff) >= 2
      ? `<span class="fc24-feels">(${h.feelsDiff > 0 ? "+" : ""}${h.feelsDiff}°)</span>` : "";
    const uvStr = h.uv != null && h.uv >= 1
      ? `<span class="fc24-uv ${uvClass(h.uv)}">UV${Math.round(h.uv)}</span>` : "";
    const capeStr = h.cape != null && h.cape >= 200
      ? `<span class="cape-badge ${h.cape >= 1000 ? "cape-high" : h.cape >= 500 ? "cape-mod" : "cape-low"}">⚡${h.cape >= 1000 ? "silné" : h.cape >= 500 ? "střední" : "nízké"}</span>` : "";
    col.innerHTML = `
      <div class="fc24-time">${esc(h.t)}</div>
      <div class="fc24-icon">${wcIconSvg(h.wc, parseInt(h.t))}</div>
      <div class="fc24-temp">${h.temp != null ? h.temp + "°" : "—"}${feelsStr}</div>
      <div class="fc24-sub fc24-prec">${h.prob > 0 ? `<span>${h.prob}%</span>` : ""}${h.precip > 0 ? ` <span>${h.precip}mm</span>` : ""}</div>
      <div class="fc24-sub fc24-wind">${h.wind > 0 ? `<span>${h.wind}km/h</span>` : ""}${uvStr}${capeStr}</div>`;
    scroll.appendChild(col);
  }

  if (fc.hourly.length && fc.blocks.length) {
    const sep = document.createElement("div");
    sep.className = "fc24-sep";
    scroll.appendChild(sep);
  }

  for (const b of fc.blocks) {
    const col = document.createElement("div");
    col.className = "fc24-col fc24-block";
    const tRange = b.tmin != null ? `${b.tmin}–${b.tmax}°` : "—";
    col.innerHTML = `
      <div class="fc24-time">${esc(b.t)}</div>
      <div class="fc24-icon">${wcIconSvg(b.wc, parseInt(b.t))}</div>
      <div class="fc24-range">${esc(tRange)}</div>
      <div class="fc24-sub">${b.prob > 0 ? `<span class="fc24-prec">${b.prob}%</span>` : ""}${b.precip > 0 ? ` <span class="fc24-prec">${b.precip}mm</span>` : ""}</div>
      <div class="fc24-sub fc24-wind">${b.gust > 0 ? `<span>${b.gust}km/h</span>` : ""}</div>`;
    scroll.appendChild(col);
  }

  el.style.display = "block";
}

const CZ_DAYS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const CZ_MONTHS = ["led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"];

export function renderFc7(data, label) {
  const el = document.getElementById("fc7");
  const grid = document.getElementById("fc7-grid");
  const d = data.daily || {};
  const dates = d.time || [];
  if (!dates.length) { el.style.display = "none"; return; }

  document.getElementById("fc7-place").textContent = label || "—";
  grid.innerHTML = "";
  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });

  dates.forEach((dateStr, i) => {
    const dt = new Date(dateStr + "T12:00:00");
    const isToday = dateStr === todayStr;
    const dayName = isToday ? "Dnes" : CZ_DAYS[dt.getDay()];
    const dayDate = `${dt.getDate()}. ${CZ_MONTHS[dt.getMonth()]}`;
    const tmax = d.temperature_2m_max?.[i];
    const tmin = d.temperature_2m_min?.[i];
    const prec = d.precipitation_sum?.[i];
    const prob = d.precipitation_probability_max?.[i];
    const gust = d.wind_gusts_10m_max?.[i];
    const uv = d.uv_index_max?.[i];
    const wc = d.weather_code?.[i];
    const rise = d.sunrise?.[i]?.slice(11, 16);
    const set_ = d.sunset?.[i]?.slice(11, 16);

    const tempStr = (tmax != null && tmin != null)
      ? `<span>${Math.round(tmax)}°</span> <span class="tmin">${Math.round(tmin)}°</span>` : "—";
    const precStr = (prob > 0 || prec > 0)
      ? `<span class="prec">${prob != null ? prob + "%" : ""}${prec > 0 ? " " + Math.round(prec * 10) / 10 + "mm" : ""}</span>` : "";
    const gustStr = gust != null && gust >= 30 ? `<span>💨 ${Math.round(gust)} km/h</span>` : "";
    const uvStr = uv != null && uv >= 1 ? `<span class="${uvClass(uv)}">UV${Math.round(uv)}</span>` : "";
    const sunStr = (rise && set_) ? `<span>🌅${esc(rise)} 🌇${esc(set_)}</span>` : "";

    const day = document.createElement("div");
    day.className = "fc7-day" + (isToday ? " fc7-today" : "");
    day.innerHTML = `
      <div class="fc7-day-name">${esc(dayName)}</div>
      <div class="fc7-day-date">${esc(dayDate)}</div>
      <div class="fc7-day-icon">${wcIconSvg(wc)}</div>
      <div class="fc7-day-temp">${tempStr}</div>
      <div class="fc7-day-sub">${precStr}${gustStr}${uvStr}</div>
      <div class="fc7-day-sun">${sunStr}</div>`;
    grid.appendChild(day);
  });

  el.style.display = "block";
}

// ── Meteogram — kombinovaný graf (teplota + srážky + vítr + noc) ────────────
let _meteoChart = null;

export function renderMeteogram(fc, daily) {
  const wrap = document.getElementById("meteo-block");
  const canvasWrap = document.getElementById("meteo-canvas-wrap");
  const hourly = fc.hourlyFull || fc.hourly;
  if (!hourly.length) { wrap.classList.remove("show"); return; }

  wrap.classList.add("show");
  if (_meteoChart) { _meteoChart.destroy(); _meteoChart = null; }
  canvasWrap.innerHTML = `<canvas id="meteo-canvas"></canvas>`;

  const labels = hourly.map(h => h.t);
  const temps = hourly.map(h => h.tempRaw ?? null);
  const feelsArr = hourly.map(h => h.feelsRaw ?? null);
  const precip = hourly.map(h => h.precip ?? 0);
  const prob = hourly.map(h => h.prob ?? 0);
  const gusts = hourly.map(h => h.gust ?? null);

  const sunrise = daily?.sunrise?.[0]?.slice(11, 16);
  const sunset = daily?.sunset?.[0]?.slice(11, 16);

  const isDark = isDarkTheme();
  const gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const textColor = isDark ? "#8b93ab" : "#56606f";

  const precipColors = precip.map((v, i) => {
    const p = prob[i] || 0;
    const alpha = v > 0 ? Math.max(0.35, Math.min(p / 100, 1)) : 0.15;
    return `rgba(79,142,247,${alpha})`;
  });

  // Noční pásmo — jednoduchý plugin kreslící šedý obdélník mimo rise/set
  const nightPlugin = {
    id: "nightBand",
    beforeDraw(chart) {
      if (!sunrise || !sunset) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      ctx.save();
      ctx.fillStyle = isDark ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.05)";
      labels.forEach((t, i) => {
        if (t < sunrise || t >= sunset) {
          const x0 = xScale.getPixelForValue(i) - (xScale.width / labels.length) / 2;
          const w = xScale.width / labels.length;
          ctx.fillRect(x0, chartArea.top, w, chartArea.height);
        }
      });
      ctx.restore();
    },
  };

  _meteoChart = new Chart(document.getElementById("meteo-canvas"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar", label: "Srážky (mm)", data: precip,
          backgroundColor: precipColors, yAxisID: "y1", order: 3,
          barPercentage: 0.9, categoryPercentage: 1,
        },
        {
          type: "line", label: "Teplota (°C)", data: temps,
          borderColor: "#fb923c", backgroundColor: "transparent",
          borderWidth: 2.2, pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1,
        },
        {
          type: "line", label: "Pocitová (°C)", data: feelsArr,
          borderColor: "#fb923c", backgroundColor: "transparent",
          borderWidth: 1.3, borderDash: [4, 3], pointRadius: 0, tension: 0.35, yAxisID: "y", order: 2,
        },
        {
          type: "line", label: "Nárazy větru (km/h)", data: gusts,
          borderColor: "#06b6d4", backgroundColor: "transparent",
          borderWidth: 1.3, pointRadius: 0, borderDash: [1, 3], tension: 0.2, yAxisID: "y2", order: 4,
        },
      ],
    },
    plugins: [nightPlugin],
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: { color: textColor, font: { size: 10 }, boxWidth: 10, padding: 8 } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 8 }, grid: { display: false } },
        y: { position: "left", ticks: { color: textColor, font: { size: 10 }, callback: v => v + "°" }, grid: { color: gridColor } },
        y1: { position: "right", ticks: { color: textColor, font: { size: 10 } }, grid: { display: false }, beginAtZero: true, suggestedMax: 5 },
        y2: { display: false },
      },
    },
  });
}

// ── Kvalita ovzduší + pyl (Open-Meteo Air Quality API) ───────────────────────
const AQ_LEVELS = [
  [0, 20, "good", "Dobrá"], [20, 40, "fair", "Uspokojivá"], [40, 60, "moderate", "Zhoršená"],
  [60, 80, "poor", "Špatná"], [80, 100, "verypoor", "Velmi špatná"], [100, Infinity, "extreme", "Extrémní"],
];
function aqLevel(pm25) {
  if (pm25 == null) return null;
  return AQ_LEVELS.find(([lo, hi]) => pm25 >= lo && pm25 < hi) || AQ_LEVELS[AQ_LEVELS.length - 1];
}

export async function fetchAndRenderAQ(lat, lon) {
  const panel = document.getElementById("aq-panel");
  if (!panel) return;
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&current=pm10,pm2_5,ozone,nitrogen_dioxide,european_aqi`
      + `&hourly=alder_pollen,birch_pollen,grass_pollen,ragweed_pollen`
      + `&timezone=Europe%2FPrague&forecast_days=1`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderAQ(data);
  } catch (e) {
    panel.classList.remove("show");
  }
}

function pollenNow(hourly, key) {
  if (!hourly?.time?.length || !hourly[key]) return null;
  const nowPrague = nowPragueStr();
  let idx = hourly.time.findIndex(t => t >= nowPrague);
  if (idx < 0) idx = 0;
  return hourly[key][idx] ?? null;
}

function renderAQ(data) {
  const panel = document.getElementById("aq-panel");
  const cur = data.current || {};
  const pm25 = cur.pm2_5;
  const lvl = aqLevel(pm25);

  const pollenItems = [
    ["Bříza", pollenNow(data.hourly, "birch_pollen")],
    ["Tráva", pollenNow(data.hourly, "grass_pollen")],
    ["Olše", pollenNow(data.hourly, "alder_pollen")],
    ["Ambrózie", pollenNow(data.hourly, "ragweed_pollen")],
  ].filter(([, v]) => v != null && v > 0);

  const items = [
    { label: "PM2.5", val: pm25 != null ? `<span class="aq-badge aq-${lvl?.[2] || "good"}"></span>${pm25.toFixed(0)} µg/m³` : "—" },
    { label: "PM10", val: cur.pm10 != null ? cur.pm10.toFixed(0) + " µg/m³" : "—" },
    { label: "Ozón O₃", val: cur.ozone != null ? cur.ozone.toFixed(0) + " µg/m³" : "—" },
    { label: "Evropský AQI", val: cur.european_aqi != null ? String(Math.round(cur.european_aqi)) : "—" },
    ...pollenItems.map(([label, v]) => ({ label: `Pyl · ${label}`, val: `${v.toFixed(0)} zrn/m³` })),
  ];

  panel.innerHTML = `<div class="aq-title">Ovzduší a pyl${lvl ? ` <span style="color:var(--muted);font-weight:400">· ${esc(lvl[3])}</span>` : ""}</div>
    <div class="aq-grid">${items.map(it => `<div class="aq-item">
      <div class="aq-item-label">${esc(it.label)}</div>
      <div class="aq-item-val">${it.val}</div>
    </div>`).join("")}</div>`;
  panel.classList.add("show");
}

export async function fetchOpenMeteo(lat, lon, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cape,relative_humidity_2m,surface_pressure`
    + `&minutely_15=precipitation,rain,snowfall,windspeed_10m,windgusts_10m,winddirection_10m,cape`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset`
    + `&forecast_days=7&timezone=Europe%2FPrague`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
