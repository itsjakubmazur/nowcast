// Kde jsou bouřky — shluky blesků jako plochy, ne jen jednotlivé body.
//
// Proč to vzniklo: samotné body úderů a údaj "poslední blesk 34 km" odpovídají
// na otázku "je blízko blesk?", ale ne na tu, která uživatele zajímá víc:
// "kde je bouřka a jak je silná?". Sto rozsypaných blesků na mapě je šum;
// tři zvýrazněné buňky s počtem úderů za minutu jsou informace.
//
// Princip: údery z posledních STORM_WINDOW_MIN minut se shlukují do mřížky
// (~12 km), sousední obsazené buňky se spojí do jedné bouřky (flood fill),
// a ta se vykreslí jako kruh o poloměru podle rozlohy shluku, obarvený podle
// intenzity (úderů za minutu). Slabší, starší shluky blednou.
//
// Pohyb bouřky se tu ZÁMĚRNĚ neodhaduje: z řídkých úderů by to byl velmi
// hlučný odhad. Dráhu buněk počítá stormtrack.js z radaru, kde je to poctivé.

import { state } from "./state.js";
import { esc, num } from "./utils.js";
import { uiIcon } from "./uiicons.js";

const STORM_WINDOW_MIN = 20;    // okno pro shlukování
const CELL_DEG = 0.11;          // ~12 km — hrubší by slepilo dvě bouřky v jednu
const MIN_STRIKES = 3;          // míň úderů není bouřka, ale ojedinělý výboj
const NEIGHBOUR = 1;            // spojovat i diagonálně sousedící buňky
const MAX_STORMS = 40;

// Intenzita = údery za minutu v celém shluku. Prahy jsou empirické a slouží
// k odstupňování barvy, ne k jakékoli oficiální klasifikaci.
const LEVELS = [
  { min: 12, label: "velmi silná", color: "#FF375F", fill: 0.30 },
  { min: 5,  label: "silná",       color: "#FF9F0A", fill: 0.26 },
  { min: 1.5, label: "aktivní",    color: "#FFD60A", fill: 0.22 },
  { min: 0,  label: "slabá",       color: "#64D2FF", fill: 0.16 },
];

const LS_KEY = "nowcast_storms_on";

let _layers = [];
let _lastStorms = [];

export function stormsEnabled() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === null ? true : v === "1";
  } catch { return true; }
}

export function setStormsEnabled(on) {
  try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  state.stormsOn = on;
}

function levelFor(perMin) {
  return LEVELS.find(l => perMin >= l.min) || LEVELS[LEVELS.length - 1];
}

function clearLayers() {
  _layers.forEach(l => { try { l.remove(); } catch { /* už pryč */ } });
  _layers = [];
}

/**
 * Shlukne údery do bouřek.
 * @param strikes [{lat, lon, t}] — t v ms
 * @param nowMs   referenční čas (kvůli testovatelnosti)
 * @returns [{lat, lon, count, perMin, lastMs, radiusKm, cells}]
 */
export function clusterStrikes(strikes, nowMs = Date.now()) {
  const cutoff = nowMs - STORM_WINDOW_MIN * 60000;
  const grid = new Map();
  for (const s of strikes || []) {
    if (!s || s.t < cutoff || s.lat == null || s.lon == null) continue;
    const gy = Math.floor(s.lat / CELL_DEG);
    const gx = Math.floor(s.lon / CELL_DEG);
    const key = `${gy}_${gx}`;
    let cell = grid.get(key);
    if (!cell) grid.set(key, cell = { gy, gx, pts: [] });
    cell.pts.push(s);
  }
  if (!grid.size) return [];

  // Flood fill přes sousedící buňky — jedna bouřka je souvislá oblast,
  // ne jednotlivý čtverec mřížky.
  const seen = new Set();
  const storms = [];
  for (const [key, cell] of grid) {
    if (seen.has(key)) continue;
    const stack = [cell];
    seen.add(key);
    const members = [];
    while (stack.length) {
      const c = stack.pop();
      members.push(c);
      for (let dy = -NEIGHBOUR; dy <= NEIGHBOUR; dy++) {
        for (let dx = -NEIGHBOUR; dx <= NEIGHBOUR; dx++) {
          if (!dy && !dx) continue;
          const k = `${c.gy + dy}_${c.gx + dx}`;
          if (seen.has(k) || !grid.has(k)) continue;
          seen.add(k);
          stack.push(grid.get(k));
        }
      }
    }

    const pts = members.flatMap(m => m.pts);
    if (pts.length < MIN_STRIKES) continue;

    // Těžiště vážené čerstvostí — bouřka se posouvá, takže novější údery
    // mají o poloze říct víc než ty na hraně okna.
    let wsum = 0, latSum = 0, lonSum = 0, lastMs = 0;
    for (const p of pts) {
      const w = Math.max(0.15, 1 - (nowMs - p.t) / (STORM_WINDOW_MIN * 60000));
      wsum += w; latSum += p.lat * w; lonSum += p.lon * w;
      if (p.t > lastMs) lastMs = p.t;
    }
    const lat = latSum / wsum, lon = lonSum / wsum;

    // Poloměr z rozptylu úderů, ne z počtu buněk — lépe sedí na skutečný
    // rozsah bouřky a nedělá čtvercové artefakty.
    let maxKm = 0;
    for (const p of pts) {
      const dLat = (p.lat - lat) * 111;
      const dLon = (p.lon - lon) * 111 * Math.cos(lat * Math.PI / 180);
      const d = Math.sqrt(dLat * dLat + dLon * dLon);
      if (d > maxKm) maxKm = d;
    }
    storms.push({
      lat, lon,
      count: pts.length,
      perMin: Math.round((pts.length / STORM_WINDOW_MIN) * 10) / 10,
      lastMs,
      radiusKm: Math.max(5, Math.min(60, maxKm + 4)),
      cells: members.length,
    });
  }

  storms.sort((a, b) => b.count - a.count);
  return storms.slice(0, MAX_STORMS);
}

export function renderStorms(strikes, nowMs = Date.now()) {
  clearLayers();
  const btn = document.getElementById("btn-storms");
  btn?.classList.toggle("active", stormsEnabled());
  if (!state.map || typeof L === "undefined" || !stormsEnabled()) {
    _lastStorms = [];
    updateStormChip();
    return [];
  }

  const storms = clusterStrikes(strikes, nowMs);
  _lastStorms = storms;

  for (const st of storms) {
    const lvl = levelFor(st.perMin);
    // Starší bouřky blednou — poslední úder před 15 min už je spíš doznívání.
    const ageMin = (nowMs - st.lastMs) / 60000;
    const fade = Math.max(0.35, 1 - ageMin / STORM_WINDOW_MIN);

    if (typeof L.circle === "function") {
      const circle = L.circle([st.lat, st.lon], {
        radius: st.radiusKm * 1000,
        color: lvl.color,
        weight: 2,
        opacity: 0.75 * fade,
        fillColor: lvl.color,
        fillOpacity: lvl.fill * fade,
        interactive: true,
        className: "storm-blob",
      }).addTo(state.map);
      const mins = Math.round(ageMin);
      circle.bindPopup?.(
        `<div class="wu-popup"><div class="pop-head">${uiIcon("bolt")}<strong>Bouřka — ${esc(lvl.label)}</strong></div>` +
        `${st.count} úderů za ${STORM_WINDOW_MIN} min (${num(st.perMin)}/min)<br>` +
        `<small style="color:var(--muted)">poslední ${mins < 1 ? "právě teď" : `před ${mins} min`} · ` +
        `průměr ~${Math.round(st.radiusKm * 2)} km</small></div>`);
      _layers.push(circle);
    }

    // Číslo doprostřed — bez něj je z blobu jen barevná skvrna.
    const html = `<div class="storm-badge" style="--sc:${lvl.color}">${uiIcon("bolt")}${st.count}</div>`;
    const icon = L.divIcon({ className: "", html, iconSize: [46, 22], iconAnchor: [23, 11] });
    const badge = L.marker([st.lat, st.lon], { icon, interactive: false, zIndexOffset: 500 })
      .addTo(state.map);
    _layers.push(badge);
  }

  updateStormChip();
  return storms;
}

// Souhrn do chipu: kolik bouřek je vidět a jak daleko je ta nejbližší.
function updateStormChip() {
  const el = document.getElementById("storm-summary");
  if (!el) return;
  if (!_lastStorms.length || state.currentLat == null) {
    el.classList.remove("show");
    return;
  }
  let near = null, nearKm = Infinity;
  for (const st of _lastStorms) {
    const dLat = (st.lat - state.currentLat) * 111;
    const dLon = (st.lon - state.currentLon) * 111 * Math.cos(state.currentLat * Math.PI / 180);
    const d = Math.sqrt(dLat * dLat + dLon * dLon);
    if (d < nearKm) { nearKm = d; near = st; }
  }
  if (!near) { el.classList.remove("show"); return; }
  const lvl = levelFor(near.perMin);
  el.innerHTML =
    `<b>${_lastStorms.length}</b> ${_lastStorms.length === 1 ? "bouřka" : "bouřky"} v dosahu · ` +
    `nejbližší <b>${Math.round(nearKm)} km</b> (${esc(lvl.label)}, ${near.count} úderů)`;
  el.classList.toggle("storm-close", nearKm <= 25);
  el.classList.add("show");
}

export function initStormsButton(onToggle) {
  state.stormsOn = stormsEnabled();
  const btn = document.getElementById("btn-storms");
  if (!btn) return;
  btn.classList.toggle("active", state.stormsOn);
  btn.addEventListener("click", () => {
    setStormsEnabled(!stormsEnabled());
    btn.classList.toggle("active", stormsEnabled());
    onToggle?.();
  });
}
