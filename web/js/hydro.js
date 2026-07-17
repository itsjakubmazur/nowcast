// Hlásné profily — vrstva stavů a průtoků vodních toků (data/hydro.json,
// generuje pipeline/hydro.py z opendata ČHMÚ). Barva podle stupně povodňové
// aktivity; vrstva se zapíná tlačítkem 🌊 v radarovém doku.

import { state } from "./state.js";
import { esc } from "./utils.js";

const SPA_STYLE = {
  "-1": { color: "#a16207", label: "sucho (pod limitem)" },
  "0":  { color: "#0A84FF", label: "normální stav" },
  "1":  { color: "#eab308", label: "1. SPA — bdělost" },
  "2":  { color: "#f97316", label: "2. SPA — pohotovost" },
  "3":  { color: "#ef4444", label: "3. SPA — ohrožení" },
};

let _layer = null;

export async function toggleHydro() {
  const btn = document.getElementById("btn-hydro");
  state.hydroMode = !state.hydroMode;

  if (!state.hydroMode) {
    if (_layer) { state.map.removeLayer(_layer); _layer = null; }
    btn?.classList.remove("active");
    return;
  }
  btn?.classList.add("active");
  try {
    const r = await fetch(`data/hydro.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const stations = data.stations || [];
    if (!stations.length) throw new Error("bez stanic");
    if (!state.hydroMode) return; // mezitím vypnuto

    _layer = L.layerGroup();
    for (const s of stations) {
      const style = SPA_STYLE[String(s.spa ?? 0)] || SPA_STYLE["0"];
      const trend = s.trend_cm == null ? ""
        : s.trend_cm > 2 ? ` · ↗ +${s.trend_cm} cm/6 h`
        : s.trend_cm < -2 ? ` · ↘ ${s.trend_cm} cm/6 h` : " · → stagnuje";
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: (s.spa ?? 0) > 0 ? 7 : 4.5,
        color: style.color, fillColor: style.color,
        fillOpacity: 0.85, weight: (s.spa ?? 0) > 0 ? 2.5 : 1,
        pane: "markerPane",
      });
      marker.bindPopup(`<b>${esc(s.name)}</b>${s.stream ? ` <span style="color:#888">· ${esc(s.stream)}</span>` : ""}<br>
        ${s.h_cm != null ? `stav <b>${s.h_cm} cm</b>` : ""}${s.q_m3s != null ? ` · průtok <b>${s.q_m3s} m³/s</b>` : ""}<br>
        <span style="color:${style.color};font-weight:600">${esc(style.label)}</span>${esc(trend)}`);
      _layer.addLayer(marker);
    }
    _layer.addTo(state.map);
  } catch (e) {
    console.warn("Hydro:", e);
    state.hydroMode = false;
    btn?.classList.remove("active");
    if (btn) { btn.title = "Data hlásných profilů zatím nejsou k dispozici"; }
  }
}
