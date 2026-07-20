// Bezpečnost a rozhodování — proměňuje data, která už máme, v konkrétní akci:
//  1) Zásah bouřkou: protne predikovaná dráha buňky (grid.cells) tvoje místo?
//     → nápadný banner "Bouřka tě zasáhne za ~25 min" s ETA a intenzitou.
//  2) Kdy vyrazit: 12h pás srážek s vyznačeným nejbližším suchým oknem.
// Obojí staví na existujících datech (bouřkové buňky z pipeline, minutely_15
// + hodinovka z Open-Meteo), nic nového se nestahuje.

import { state } from "./state.js";
import { haversine, esc, localHM } from "./utils.js";

// ── 1) Zásah bouřkou ────────────────────────────────────────────────────────
const HIT_MARGIN_KM = 4;   // okraj jádra + rezerva na nepřesnost dráhy

// Poloměr jádra z plochy (kruhová aproximace) — jak "široko" buňka zasahuje
function cellRadiusKm(c) {
  return Math.sqrt((c.area_km2 || 50) / Math.PI);
}

// Najde buňku, jejíž predikovaná dráha protne místo nejdřív. Vrací
// { cell, etaMin, missKm } nebo null. etaMin 0 = jádro už nad/u tebe.
export function stormImpact(lat, lon) {
  const cells = state.GRID?.cells || [];
  const stepMin = state.GRID?.step_min || 10;
  let soonest = null;
  for (const c of cells) {
    const path = [[c.lat, c.lon], ...(c.track || [])];
    let best = { d: Infinity, idx: 0 };
    path.forEach((p, i) => {
      const d = haversine(lat, lon, p[0], p[1]);
      if (d < best.d) best = { d, idx: i };
    });
    const hitKm = cellRadiusKm(c) + HIT_MARGIN_KM;
    if (best.d <= hitKm) {
      const etaMin = best.idx * stepMin; // idx 0 = teď
      if (!soonest || etaMin < soonest.etaMin) {
        soonest = { cell: c, etaMin, missKm: Math.round(best.d) };
      }
    }
  }
  return soonest;
}

function stormSeverity(dbz, hail) {
  if (hail || dbz >= 55) return { word: "silná bouřka s možnými kroupami", cls: "sev" };
  if (dbz >= 50) return { word: "silná bouřka", cls: "sev" };
  return { word: "bouřka", cls: "warn" };
}

export function renderStormImpact(lat, lon) {
  const el = document.getElementById("storm-impact");
  if (!el) return;
  if (!state.inCZ) { el.classList.remove("show"); return; } // buňky jsou jen ČR
  const imp = stormImpact(lat, lon);
  if (!imp) { el.classList.remove("show"); return; }

  const { cell, etaMin } = imp;
  const sev = stormSeverity(cell.dbz, cell.hail);
  const title = etaMin <= 0
    ? `⚡ ${sev.word[0].toUpperCase()}${sev.word.slice(1)} právě nad tebou`
    : `⚡ ${sev.word[0].toUpperCase()}${sev.word.slice(1)} tě zasáhne za ~${etaMin} min`;
  const dirs = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
  const from = dirs[Math.round(((cell.dir_deg + 180) % 360) / 22.5) % 16];
  const sub = `${cell.dbz} dBZ · postupuje od ${from} rychlostí ${cell.speed_kmh} km/h`
    + (cell.hail ? " · riziko krup" : "");
  el.className = `storm-impact show ${sev.cls}`;
  el.innerHTML = `<div class="si-title">${esc(title)}</div><div class="si-sub">${esc(sub)}</div>`;
}

// ── 2) Kdy vyrazit — 12h pás srážek + nejbližší suché okno ───────────────────
const WET_RATE = 0.15;       // mm/h — od kdy je slot "mokrý"
const MIN_DRY_MIN = 45;      // kratší okno nemá smysl nabízet

// Postaví timeline srážek (mm/h) po 30 min na příštích ~12 h: minutely_15 na
// začátek (jemné), pak hodinovka. Vrací [{ ms, rate }].
function precipTimeline(minutely, fc) {
  const now = Date.now();
  const out = [];
  // 0–4 h z minutely_15 (mm/15min → mm/h ×4), agregováno po 30 min
  if (minutely?.length) {
    for (let i = 0; i + 1 < minutely.length && i < 16; i += 2) {
      const mm = (minutely[i]?.precip ?? 0) + (minutely[i + 1]?.precip ?? 0);
      out.push({ ms: now + i * 15 * 60000, rate: mm * 2 }); // 2×15min mm → mm/h
    }
  }
  // navazující hodinovka (od poslední pokryté hodiny do +12 h)
  const covMs = out.length ? out[out.length - 1].ms : now;
  for (const h of (fc?.hourlyFull || [])) {
    const ms = new Date(h.iso).getTime();
    if (ms <= covMs + 60000 || ms > now + 12 * 3600000) continue;
    out.push({ ms, rate: h.precip ?? 0 });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export function renderOutlookWindows(minutely, fc) {
  const panel = document.getElementById("outlook-panel");
  if (!panel) return;
  const tl = precipTimeline(minutely, fc);
  if (tl.length < 6) { panel.classList.remove("show"); return; }

  const now = Date.now();
  const wetNow = tl[0].rate >= WET_RATE;

  // najdi souvislá suchá okna
  const windows = [];
  let start = null;
  for (const p of tl) {
    if (p.rate < WET_RATE) { if (start == null) start = p.ms; }
    else if (start != null) { windows.push([start, p.ms]); start = null; }
  }
  if (start != null) windows.push([start, tl[tl.length - 1].ms + 30 * 60000]);
  const good = windows.filter(([a, b]) => b - a >= MIN_DRY_MIN * 60000);

  // hlavní hláška
  let msg;
  const nextGood = good.find(([a]) => a >= now - 5 * 60000);
  if (wetNow) {
    const stops = tl.find(p => p.rate < WET_RATE);
    msg = stops
      ? `Teď prší. Ustane kolem <b>${localHM(new Date(stops.ms).toISOString())}</b>` +
        (nextGood ? `, pak sucho aspoň do ${localHM(new Date(nextGood[1]).toISOString())}.` : ".")
      : `Prší souvisle příštích 12 h — bez suchého okna.`;
  } else {
    const rainStarts = tl.find(p => p.rate >= WET_RATE);
    if (!rainStarts) {
      msg = `Beze srážek celých příštích 12 h — vyrazit můžeš kdykoli. ☀️`;
    } else {
      const mins = Math.round((rainStarts.ms - now) / 60000);
      msg = `Sucho ještě ~<b>${mins >= 60 ? Math.round(mins / 60) + " h" : mins + " min"}</b>, `
        + `déšť přijde kolem <b>${localHM(new Date(rainStarts.ms).toISOString())}</b>.`;
    }
  }

  // pás: sloupec za slot, mokrý = modrý, suchý = tlumený; nejbližší dobré okno zvýrazněné
  const maxRate = Math.max(...tl.map(p => p.rate), 1);
  const bars = tl.map(p => {
    const wet = p.rate >= WET_RATE;
    const inGood = nextGood && p.ms >= nextGood[0] && p.ms < nextGood[1];
    const h = wet ? Math.max(20, Math.round(p.rate / maxRate * 100)) : 10;
    const cls = wet ? "wet" : inGood ? "dry-good" : "dry";
    return `<i class="${cls}" style="height:${h}%" title="${localHM(new Date(p.ms).toISOString())} · ${p.rate.toFixed(1)} mm/h"></i>`;
  }).join("");

  const ticks = [0, Math.floor(tl.length / 2), tl.length - 1]
    .map(i => `<span>${localHM(new Date(tl[i].ms).toISOString())}</span>`).join("");

  panel.innerHTML = `
    <div class="ow-title">Kdy vyrazit <span class="ow-sub">okna beze srážek, 12 h</span></div>
    <div class="ow-msg">${msg}</div>
    <div class="ow-bars">${bars}</div>
    <div class="ow-axis">${ticks}</div>`;
  panel.classList.add("show");
}
