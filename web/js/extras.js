// Doplňkové panely v2.0 — minutový graf srážek, aktivitní indexy,
// "včera vs. dnes", astro a zimní podmínky. Všechno počítané z dat,
// která už stahujeme (grid série + Open-Meteo hourly/daily).

import { state } from "./state.js";
import { esc } from "./utils.js";
import { moonIconImg, wImg } from "./icons.js";

function nowPragueStr() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" });
  return s.slice(0, 10) + "T" + s.slice(11, 14) + "00";
}
function pragueMonth() {
  return +new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" }).slice(5, 7);
}

// ── Minutový graf srážek 0–120 min ───────────────────────────────────────────
// Primárně z naší radarové extrapolace (grid.series per bod, krok 10 min),
// fallback na Open-Meteo minutely_15 (krok 15 min, přemapovaný na 10min sloty).
export function renderMinutely(ptId, minutely) {
  const panel = document.getElementById("minutely-panel");
  const barsEl = document.getElementById("minutely-bars");
  const srcEl = document.getElementById("minutely-src");
  if (!panel || !barsEl) return;

  const SLOTS = 12; // 12 × 10 min
  let vals = null, src = null;

  const series = state.GRID?.series?.[String(ptId)];
  const stepMin = state.GRID?.step_min || 10;
  if (series?.length) {
    vals = [];
    for (let i = 0; i < SLOTS; i++) {
      const t = i * 10; // minuta slotu
      const idx = Math.floor(t / stepMin);
      vals.push(idx < series.length ? series[idx] : null);
    }
    src = "radarová extrapolace";
  } else if (minutely?.length) {
    vals = [];
    for (let i = 0; i < SLOTS; i++) {
      const idx = Math.min(Math.floor(i * 10 / 15), minutely.length - 1);
      vals.push(minutely[idx]?.precip ?? null);
    }
    src = "model (15min)";
  }

  if (!vals || !vals.some(v => v != null)) { panel.classList.remove("show"); return; }

  const known = vals.filter(v => v != null);
  // Když je celých 120 minut sucho, graf nic neříká — countdown karta
  // ("Nejbližší 2 h bez srážek") to komunikuje líp. Ukazuj jen když prší.
  if (Math.max(...known) < 0.05) { panel.classList.remove("show"); return; }
  const maxV = Math.max(...known, 1.5);
  barsEl.innerHTML = vals.map(v => {
    if (v == null || v < 0.05) return `<i class="dry"></i>`;
    const h = Math.max(12, Math.round(v / maxV * 100));
    return `<i style="height:${h}%" title="${v.toFixed(1)} mm/h"></i>`;
  }).join("");
  if (srcEl) srcEl.textContent = src;
  panel.classList.add("show");
}

// ── Aktivitní indexy (0–10) ──────────────────────────────────────────────────
function clamp10(v) { return Math.max(0, Math.min(10, Math.round(v))); }
function scoreClass(s) { return s >= 7 ? "good" : s >= 4 ? "mid" : "bad"; }

export function renderActivities(fc, data) {
  const panel = document.getElementById("activities-panel");
  const grid = document.getElementById("act-grid");
  if (!panel || !grid) return;
  const all = fc.hourlyFull || [];
  if (!all.length) { panel.classList.remove("show"); return; }

  // denní okno (dnešních příštích ~12 h) a večerní/noční okno
  const day = all.slice(0, 12).filter(h => { const hr = +h.t.slice(0, 2); return hr >= 7 && hr <= 21; });
  const evening = all.filter(h => { const hr = +h.t.slice(0, 2); return hr >= 17 && hr <= 21; });
  const night = all.filter(h => { const hr = +h.t.slice(0, 2); return hr >= 22 || hr <= 2; }).slice(0, 5);
  if (!day.length) { panel.classList.remove("show"); return; }

  const mx = (arr, k) => arr.length ? Math.max(...arr.map(h => h[k] ?? 0)) : 0;
  const mean = (arr, k) => arr.length ? arr.reduce((s, h) => s + (h[k] ?? 0), 0) / arr.length : 0;

  const feelsMax = mx(day, "feelsRaw") || mx(day, "tempRaw");
  const probMax = mx(day, "prob");
  const precSum = day.reduce((s, h) => s + (h.precip || 0), 0);
  const gustMax = mx(day, "gust");
  const uvMax = mx(day, "uv");
  const humMean = mean(day, "humidity");

  const run = clamp10(10 - Math.max(0, feelsMax - 20) * 0.55 - (probMax > 50 ? 3 : probMax > 25 ? 1 : 0) - (gustMax > 40 ? 2 : 0));
  const bike = clamp10(10 - Math.max(0, feelsMax - 24) * 0.45 - (probMax > 50 ? 3 : 0) - Math.max(0, gustMax - 28) * 0.12);
  const water = clamp10(precSum > 3 ? 2 : 8 + (feelsMax >= 26 ? 2 : 0) - (probMax > 60 ? 4 : 0));
  const laundry = clamp10(9 - (probMax > 30 ? probMax / 12 : 0) - (humMean > 75 ? 2 : 0) + (gustMax >= 10 && gustMax <= 35 ? 1 : 0));
  const grill = clamp10(9 - (mx(evening, "prob") > 40 ? 4 : 0) - Math.max(0, mx(evening, "gust") - 30) * 0.15 - (mean(evening, "tempRaw") < 14 ? 3 : 0));
  const nightCloud = night.length ? mean(night, "cloud") : 60;
  const stars = clamp10(10 * (1 - nightCloud / 100) - ((state._moonIllum ?? 0.5) * 3));

  const items = [
    ["🏃", "Běhání", run, `pocitově až ${Math.round(feelsMax)}°, srážky ${probMax}%`],
    ["🚴", "Kolo", bike, `nárazy až ${Math.round(gustMax)} km/h`],
    ["🚿", "Zalévání", water, precSum > 1 ? `spadne ~${precSum.toFixed(1)} mm — příroda zalije sama` : "beze srážek, zalij"],
    ["👕", "Prádlo", laundry, `vlhkost ~${Math.round(humMean)} %`],
    ["🔥", "Gril", grill, `večer srážky ${Math.round(mx(evening, "prob"))}%`],
    ["🔭", "Hvězdy", stars, `oblačnost v noci ~${Math.round(nightCloud)} %`],
  ];
  grid.innerHTML = items.map(([e, n, s, why]) =>
    `<span class="act" title="${esc(why)}"><span class="a-e">${e}</span><span class="a-n">${esc(n)}</span><span class="a-s ${scoreClass(s)}">${s}/10</span></span>`
  ).join("");
  panel.classList.add("show");
  void uvMax; void data;
}

// ── Včera vs. dnes + (později) odchylka od normálu ───────────────────────────
export function renderDeltaLine(data) {
  const el = document.getElementById("delta-line");
  if (!el) return;
  const h = data.hourly || {};
  const times = h.time || [];
  const temp = h.temperature_2m || [];
  const nowP = nowPragueStr();
  let i = times.findIndex(t => t >= nowP);
  if (i < 0 || i - 24 < 0 || temp[i] == null || temp[i - 24] == null) { el.classList.remove("show"); el.innerHTML = ""; return; }

  const diff = temp[i] - temp[i - 24];
  let html = "";
  if (Math.abs(diff) >= 1.5) {
    const up = diff > 0;
    html += `<span class="${up ? "d-up" : "d-down"}">${up ? "▲" : "▼"} o ${Math.abs(Math.round(diff))}° ${up ? "tepleji" : "chladněji"} než včera</span>`;
  }
  // #delta-anomaly plní asynchronně climate.js (odchylka od normálu) — když
  // dorazí, sám řádek zviditelní; tady ho ukazujeme jen s reálným obsahem
  html += `<span id="delta-anomaly"></span>`;
  el.innerHTML = html;
  el.classList.toggle("show", html !== `<span id="delta-anomaly"></span>`);
}

// ── Astro — měsíc, zlatá hodina, kvalita noci ────────────────────────────────
const SYNODIC = 29.530588853;
function moonAge(d = new Date()) {
  const ref = Date.UTC(2000, 0, 6, 18, 14); // nov 6. 1. 2000
  const days = (d.getTime() - ref) / 86400000;
  return ((days % SYNODIC) + SYNODIC) % SYNODIC;
}
function moonInfo() {
  const age = moonAge();
  const illum = (1 - Math.cos(2 * Math.PI * age / SYNODIC)) / 2;
  const idx = Math.round(age / SYNODIC * 8) % 8;
  const name = ["nov", "dorůstající srpek", "první čtvrť", "dorůstající", "úplněk", "couvající", "poslední čtvrť", "couvající srpek"][idx];
  return { age, illum, frac: age / SYNODIC, name };
}
function addMin(hm, mins) {
  if (!hm) return null;
  const [H, M] = hm.split(":").map(Number);
  const t = H * 60 + M + mins;
  const hh = Math.floor(((t % 1440) + 1440) % 1440 / 60), mm = ((t % 60) + 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function renderAstro(data, fc) {
  const panel = document.getElementById("astro-panel");
  const body = document.getElementById("astro-body");
  if (!panel || !body) return;
  const d = data.daily || {};
  const rise = d.sunrise?.[0]?.slice(11, 16);
  const set_ = d.sunset?.[0]?.slice(11, 16);
  if (!rise || !set_) { panel.classList.remove("show"); return; }

  const [rh, rm] = rise.split(":").map(Number);
  const [sh, sm] = set_.split(":").map(Number);
  const dayMin = (sh * 60 + sm) - (rh * 60 + rm);
  const dayLen = `${Math.floor(dayMin / 60)} h ${String(dayMin % 60).padStart(2, "0")} min`;

  const moon = moonInfo();
  state._moonIllum = moon.illum; // pro index hvězdaření

  const night = (fc?.hourlyFull || []).filter(h => { const hr = +h.t.slice(0, 2); return hr >= 22 || hr <= 2; }).slice(0, 5);
  const nightCloud = night.length ? night.reduce((s, h) => s + (h.cloud ?? 50), 0) / night.length : null;
  let nightQ = null;
  if (nightCloud != null) {
    const q = 10 * (1 - nightCloud / 100) - moon.illum * 3;
    nightQ = q >= 6.5 ? "výborná" : q >= 4 ? "průměrná" : "špatná";
  }

  body.innerHTML = `
    <div class="astro-row"><span class="a-k">Slunce</span><span class="a-v">${wImg("sunrise", "wicon winline")} ${esc(rise)} → ${wImg("sunset", "wicon winline")} ${esc(set_)}</span><span class="a-d">den ${esc(dayLen)}</span></div>
    <div class="astro-row"><span class="a-k">Zlatá h.</span><span class="a-v">${esc(addMin(set_, -45))}–${esc(set_)}</span><span class="a-d">ráno ${esc(rise)}–${esc(addMin(rise, 45))}</span></div>
    <div class="astro-row"><span class="a-k">Měsíc</span><span class="a-v">${moonIconImg(moon.frac).replace("wicon", "wicon winline")} ${esc(moon.name)}</span><span class="a-d">svit ${Math.round(moon.illum * 100)} %</span></div>
    ${nightQ ? `<div class="astro-row"><span class="a-k">Noc</span><span class="a-v">pozorování: ${esc(nightQ)}</span><span class="a-d">oblačnost ~${Math.round(nightCloud)} %</span></div>` : ""}`;
  panel.classList.add("show");
}

// ── Zimní podmínky — jen když je co hlásit ───────────────────────────────────
export function renderWinter(fc, data) {
  const panel = document.getElementById("winter-panel");
  const body = document.getElementById("winter-body");
  if (!panel || !body) return;
  const all = fc.hourlyFull || [];
  const h = data.hourly || {};
  const snowArr = h.snowfall || [];
  const times = h.time || [];
  const nowP = nowPragueStr();
  let si = times.findIndex(t => t >= nowP);
  if (si < 0) si = 0;

  const next48snow = snowArr.slice(si, si + 48).reduce((s, v) => s + (v || 0), 0);
  const frostHours = all.filter(x => (x.tempRaw ?? 99) <= 0).length;
  const iceRisk = all.some(x => (x.tempRaw ?? 99) <= 1 && (x.precip || 0) > 0);
  const inSeason = [11, 12, 1, 2, 3].includes(pragueMonth());

  if (!inSeason && next48snow < 0.2 && !iceRisk) { panel.classList.remove("show"); return; }
  if (next48snow < 0.2 && frostHours === 0 && !iceRisk) { panel.classList.remove("show"); return; }

  const rows = [];
  if (next48snow >= 0.2) rows.push(`<div class="astro-row"><span class="a-k">Sněžení</span><span class="a-v">~${next48snow.toFixed(1)} cm / 48 h</span></div>`);
  if (frostHours > 0) rows.push(`<div class="astro-row"><span class="a-k">Mráz</span><span class="a-v">${frostHours} h pod 0 °C</span><span class="a-d">z příštích 24 h</span></div>`);
  if (iceRisk) rows.push(`<div class="astro-row"><span class="a-k">Náledí</span><span class="a-v" style="color:var(--red)">riziko</span><span class="a-d">srážky při teplotě ≤ 1 °C</span></div>`);
  body.innerHTML = rows.join("");
  panel.classList.add("show");
}
