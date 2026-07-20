// Úhrnová mapa — kolik spadlo za posledních 24 h. Data z NWP podmřížky
// (grid.nwp.pts, 6. prvek = accum24_mm), kterou pipeline stahuje tak jako tak,
// takže vrstva nestojí žádný request navíc. Rozlišení 30 km (model ICON-D2),
// proto poctivý popis "model", ne radarové měření — na 24h úhrn ale ICON-D2
// sedí velmi dobře a ukáže, kde bylo mokro.

import { state } from "./state.js";

// Barevná škála úhrnu (mm/24h) — [práh, barva]. Standardní srážkové odstíny.
const SCALE = [
  [1,   "#9fd0ff"],
  [5,   "#4da3ff"],
  [10,  "#1f6fe0"],
  [20,  "#2ec26b"],
  [30,  "#f5c400"],
  [40,  "#ff8a00"],
  [60,  "#ff3b30"],
  [100, "#bf5af2"],
];
function accColor(mm) {
  let c = SCALE[0][1];
  for (const [t, col] of SCALE) { if (mm >= t) c = col; }
  return c;
}

let _btnWired = false;

export function toggleAccum() {
  const btn = document.getElementById("btn-accum");
  state.accumMode = !state.accumMode;
  const legend = document.getElementById("accum-legend");

  if (!state.accumMode) {
    if (state.accumLayer) { state.map.removeLayer(state.accumLayer); state.accumLayer = null; }
    btn?.classList.remove("active");
    legend?.classList.remove("show");
    return;
  }
  btn?.classList.add("active");

  const pts = state.GRID?.nwp?.pts || [];
  const wet = pts.filter(p => (p[5] ?? 0) >= 1);
  if (!wet.length) {
    btn.title = "Za posledních 24 h nikde v ČR výrazně nepršelo";
    state.accumMode = false;
    btn?.classList.remove("active");
    return;
  }
  if (state.accumLayer) { state.map.removeLayer(state.accumLayer); state.accumLayer = null; }

  const stepKm = state.GRID.nwp.step_km || 30;
  const dLat = stepKm / 111 / 2;                    // půl-buňka na šířku
  const layer = L.layerGroup();
  for (const p of wet) {
    const [lat, lon, , , , mm] = p;
    const dLon = dLat / Math.cos(lat * Math.PI / 180);
    const rect = L.polygon([
      [lat - dLat, lon - dLon], [lat - dLat, lon + dLon],
      [lat + dLat, lon + dLon], [lat + dLat, lon - dLon],
    ], {
      color: accColor(mm), fillColor: accColor(mm),
      fillOpacity: 0.42, weight: 0, pane: "overlayPane",
    });
    rect.bindPopup(`<div class="accum-popup"><b>${mm} mm</b> za 24 h<br><span>${lat.toFixed(2)}, ${lon.toFixed(2)} · model ICON-D2</span></div>`);
    layer.addLayer(rect);
  }
  state.accumLayer = layer.addTo(state.map);
  document.getElementById("accum-legend")?.classList.add("show");
}

export function initAccumButton() {
  if (_btnWired) return;
  const btn = document.getElementById("btn-accum");
  if (!btn) return;
  _btnWired = true;
  btn.addEventListener("click", toggleAccum);
}
