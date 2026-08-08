// Hlásné profily — vrstva stavů a průtoků vodních toků (data/hydro.json,
// generuje pipeline/hydro.py z opendata ČHMÚ). Barva podle stupně povodňové
// aktivity; vrstva se zapíná tlačítkem 🌊 v radarovém doku.

import { state } from "./state.js";
import { esc } from "./utils.js";
import { gc } from "./palette.js";

const SPA_STYLE = {
  "-1": { color: "#a16207", label: "sucho (pod limitem)" },
  "0":  { color: "#0A84FF", label: "normální stav" },
  "1":  { color: gc("vystraha1"), label: "1. SPA — bdělost" },
  "2":  { color: gc("teplo"), label: "2. SPA — pohotovost" },
  "3":  { color: gc("horko"), label: "3. SPA — ohrožení" },
};

// Vrstva žije na state.hydroLayer (stejný vzorec jako state.windLayer/
// state.satLayer u ostatních přepínatelných vrstev) — snadno testovatelné
// zvenčí a konzistentní se zbytkem kódu.
// Token per zapnutí — bez něj by rychlé zap/vyp/zap nechalo na mapě
// duplicitní vrstvu (starší dokončený fetch přepíše referenci, aniž by
// odstranil tu, kterou mezitím na mapu přidal ten předchozí).
let _token = 0;

export async function toggleHydro() {
  const btn = document.getElementById("btn-hydro");
  state.hydroMode = !state.hydroMode;

  if (!state.hydroMode) {
    _token++; // zneplatní jakýkoli rozpracovaný fetch z předchozího zapnutí
    if (state.hydroLayer) { state.map.removeLayer(state.hydroLayer); state.hydroLayer = null; }
    btn?.classList.remove("active");
    return;
  }
  const myToken = ++_token;
  btn?.classList.add("active");
  try {
    const r = await fetch(`data/hydro.json?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const stations = data.stations || [];
    if (!stations.length) throw new Error("bez stanic");
    if (myToken !== _token) return; // mezitím uživatel znovu přepnul

    if (state.hydroLayer) { state.map.removeLayer(state.hydroLayer); state.hydroLayer = null; } // pojistka
    const layer = L.layerGroup();
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
      marker.bindPopup(`
        <div class="hydro-popup">
          <h4>${esc(s.name)}${s.stream ? ` <span class="hydro-meta">· ${esc(s.stream)}</span>` : ""}</h4>
          <div class="hydro-meta">${s.h_cm != null ? `stav <b>${s.h_cm} cm</b>` : ""}${s.q_m3s != null ? ` · průtok <b>${s.q_m3s} m³/s</b>` : ""}</div>
          <div class="hydro-spa" style="color:${style.color}">${esc(style.label)}<span class="hydro-meta">${esc(trend)}</span></div>
        </div>`);
      layer.addLayer(marker);
    }
    state.hydroLayer = layer.addTo(state.map);
  } catch (e) {
    if (myToken !== _token) return; // mezitím uživatel znovu přepnul
    console.warn("Hydro:", e);
    state.hydroMode = false;
    btn?.classList.remove("active");
    if (btn) { btn.title = "Data hlásných profilů zatím nejsou k dispozici"; }
  }
}
