// Dráhy bouřkových buněk na mapě — z GRID.cells (pipeline/grid.py detekuje
// konvektivní jádra ≥ 40 dBZ a predikuje jejich pozice +10..+60 min stejným
// pohybovým polem jako radarová extrapolace). Buňka = kruhová značka barvená
// podle intenzity, čárkovaná dráha s časovými značkami, u ≥ 55 dBZ příznak
// možného krupobití (bez volume dat je sloupcové MAX_Z nejlepší proxy).

import { state } from "./state.js";
import { esc } from "./utils.js";

function cellStyle(dbz) {
  if (dbz >= 55) return { color: "#BF5AF2", label: "extrémní jádro" };
  if (dbz >= 50) return { color: "#FF453A", label: "silná bouřka" };
  if (dbz >= 45) return { color: "#FF9F0A", label: "bouřka" };
  return { color: "#FFD60A", label: "silná přeháňka" };
}

const DIRS = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
const dirLabel = deg => DIRS[Math.round(deg / 22.5) % 16];

export function renderStormTracks() {
  if (!state.map) return;
  if (state.stormLayer) { state.map.removeLayer(state.stormLayer); state.stormLayer = null; }
  const cells = state.GRID?.cells || [];
  if (!cells.length) return;

  const layer = L.layerGroup();
  const stepMin = state.GRID.step_min || 10;

  for (const c of cells) {
    const st = cellStyle(c.dbz);

    // Predikovaná dráha — čárkovaně, s časovými značkami po 20 min
    if (Array.isArray(c.track) && c.track.length) {
      layer.addLayer(L.polyline([[c.lat, c.lon], ...c.track], {
        color: st.color, weight: 2, opacity: 0.7, dashArray: "6 6",
        pane: "markerPane",
      }));
      c.track.forEach((pos, i) => {
        const mins = (i + 1) * stepMin;
        if (mins % 20 !== 0) return; // značky jen +20/+40/+60
        layer.addLayer(L.marker(pos, {
          icon: L.divIcon({
            className: "storm-eta-label",
            html: `<span style="border-color:${st.color}">+${mins}′</span>`,
            iconSize: null,
          }),
          interactive: false, pane: "markerPane",
        }));
      });
    }

    const marker = L.circleMarker([c.lat, c.lon], {
      radius: c.dbz >= 50 ? 9 : 7,
      color: st.color, fillColor: st.color, fillOpacity: 0.55,
      weight: 2.5, pane: "markerPane",
    });
    marker.bindPopup(`
      <div class="storm-popup">
        <h4>${c.hail ? "⚠️ " : ""}${esc(st.label)} · ${c.dbz} dBZ</h4>
        <div class="storm-meta">plocha ~${c.area_km2} km² · táhne na ${dirLabel(c.dir_deg)} rychlostí ${c.speed_kmh} km/h</div>
        ${c.hail ? `<div class="storm-hail">Odrazivost ≥ 55 dBZ — možné krupobití</div>` : ""}
        <div class="storm-meta">Čárkovaná čára = predikovaná dráha jádra na příští hodinu.</div>
      </div>`);
    layer.addLayer(marker);
  }

  state.stormLayer = layer.addTo(state.map);
}
