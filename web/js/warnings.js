import { state } from "./state.js";
import { esc, localHM } from "./utils.js";
import { gc } from "./palette.js";

const COLOR_HEX = { yellow: gc("vystraha1"), orange: gc("teplo"), red: gc("horko"), unknown: gc("neutral") };

export function renderWarningsLayer() {
  if (state.warningsLayerGroup) {
    state.warningsLayerGroup.clearLayers();
  } else {
    state.warningsLayerGroup = L.layerGroup().addTo(state.map);
  }
  const warnings = state.GRID?.warnings || [];
  for (const w of warnings) {
    for (const ring of w.polygons || []) {
      if (ring.length < 3) continue;
      const color = COLOR_HEX[w.color] || COLOR_HEX.unknown;
      const poly = L.polygon(ring, {
        color, weight: 1.5, fillColor: color, fillOpacity: 0.12, opacity: 0.6,
      }).addTo(state.warningsLayerGroup);
      poly.bindPopup(`
        <div class="warn-popup">
          <h4>${esc(w.event)}</h4>
          <div class="warn-meta">${esc(w.color?.toUpperCase())} · platí ${localHM(w.onset_utc)}–${localHM(w.expires_utc)}</div>
          ${w.areas?.length ? `<div class="warn-meta">${esc(w.areas.join(", "))}</div>` : ""}
          ${w.description ? `<div class="warn-desc">${esc(w.description)}</div>` : ""}
        </div>`);
    }
  }
}
