import { state } from "./state.js";

export function initMap(onMapClick) {
  state.map = L.map("map", { zoomControl: false }).setView([49.8, 15.5], 7);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> © <a href='https://carto.com/attributions'>CARTO</a>",
      subdomains: "abcd", maxZoom: 19,
    }
  ).addTo(state.map);

  // Dva overlaye pro crossfade — vždy jeden "aktivní" (viditelný), druhý
  // v pozadí připravený na příští snímek; přepnutí je jen opacity tween.
  const bounds = state.MANIFEST.bounds;
  const firstSrc = state.preloadedImgs[0]?.src || "";
  state.radarOverlayA = L.imageOverlay(firstSrc, bounds, {
    opacity: state.radarOpacity, interactive: false, zIndex: 200,
  }).addTo(state.map);
  state.radarOverlayB = L.imageOverlay(firstSrc, bounds, {
    opacity: 0, interactive: false, zIndex: 199,
  }).addTo(state.map);
  state.radarActiveIsA = true;

  state.map.on("click", e => onMapClick(e.latlng.lat, e.latlng.lng));
}

// Nastaví nový snímek s krátkým crossfade tweenem mezi dvěma overlayi.
export function setRadarFrameUrl(url, opacity) {
  const active = state.radarActiveIsA ? state.radarOverlayA : state.radarOverlayB;
  const hidden = state.radarActiveIsA ? state.radarOverlayB : state.radarOverlayA;

  hidden.setUrl(url);
  // Malé zpoždění, ať prohlížeč stihne načíst obrázek dřív, než ho odkryjeme
  // (jinak by "crossfade" byl vidět jako bílý/černý probliknutí).
  const img = hidden.getElement();
  const reveal = () => {
    hidden.setOpacity(opacity);
    active.setOpacity(0);
    state.radarActiveIsA = !state.radarActiveIsA;
  };
  if (img && !img.complete) {
    img.addEventListener("load", reveal, { once: true });
    setTimeout(reveal, 260); // pojistka kdyby load event nedorazil včas
  } else {
    reveal();
  }
}

export function setRadarOpacityBoth(opacity) {
  const active = state.radarActiveIsA ? state.radarOverlayA : state.radarOverlayB;
  active.setOpacity(opacity);
}
