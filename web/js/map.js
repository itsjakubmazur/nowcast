import { state } from "./state.js";
import { isDarkTheme } from "./theme.js";

// Podkladové mapy.
//
// Původní Positron/Dark Matter byly záměrně minimalistické, aby "nerušily"
// radar — jenže bez sídel, silnic a vodstva se v nich nedalo zorientovat a
// mapa působila jako prázdná plocha. Výchozí je proto Voyager: má barvy,
// silnice i popisky, a přitom je pod poloprůhledným radarem pořád čitelný.
// Stejný host jako dřív (basemaps.cartocdn.com), takže beze změny CSP.
//
// K tomu terén a satelit z ArcGIS Online — na orientaci v kopcích a na
// "kde to vlastně jsem" je to nesrovnatelně lepší než jakákoli plochá mapa.
const CARTO = "https://{s}.basemaps.cartocdn.com";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ATTR_CARTO = "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> © <a href='https://carto.com/attributions'>CARTO</a>";
const ATTR_ESRI = "© <a href='https://www.esri.com/'>Esri</a>, USGS, NOAA";

export const BASEMAPS = {
  // klíč: { název, světlá/tmavá varianta URL, atribuce, maxZoom, subdomény }
  voyager: {
    label: "Barevná",
    light: `${CARTO}/rastertiles/voyager/{z}/{x}/{y}{r}.png`,
    dark: `${CARTO}/rastertiles/voyager_labels_under/{z}/{x}/{y}{r}.png`,
    attribution: ATTR_CARTO, subdomains: "abcd", maxZoom: 19,
  },
  terrain: {
    label: "Terén",
    light: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    dark: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    attribution: ATTR_ESRI, maxZoom: 19,
  },
  satellite: {
    label: "Satelit",
    light: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    dark: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    attribution: ATTR_ESRI, maxZoom: 19,
  },
  minimal: {
    label: "Minimální",
    light: `${CARTO}/light_all/{z}/{x}/{y}{r}.png`,
    dark: `${CARTO}/dark_all/{z}/{x}/{y}{r}.png`,
    attribution: ATTR_CARTO, subdomains: "abcd", maxZoom: 19,
  },
};

const BASEMAP_KEY = "nowcast_basemap";
export const DEFAULT_BASEMAP = "voyager";

export function getBasemap() {
  try {
    const v = localStorage.getItem(BASEMAP_KEY);
    return BASEMAPS[v] ? v : DEFAULT_BASEMAP;
  } catch { return DEFAULT_BASEMAP; }
}

export function setBasemap(key) {
  if (!BASEMAPS[key]) return;
  try { localStorage.setItem(BASEMAP_KEY, key); } catch { /* private mode */ }
  applyBasemap();
}

function baseTileUrl() {
  const b = BASEMAPS[getBasemap()] || BASEMAPS[DEFAULT_BASEMAP];
  return isDarkTheme() ? b.dark : b.light;
}

// Satelit a terén jsou samy o sobě tmavé/pestré — radar přes ně potřebuje
// vyšší kontrast, jinak splyne. Vrací třídu na <body>, CSS si zbytek dořeší.
function basemapBodyClass() {
  const k = getBasemap();
  return k === "satellite" || k === "terrain" ? "basemap-busy" : "";
}

let _layer = null;

function applyBasemap() {
  const b = BASEMAPS[getBasemap()] || BASEMAPS[DEFAULT_BASEMAP];
  document.body.classList.toggle("basemap-busy", !!basemapBodyClass());
  if (!_layer) return;
  _layer.setUrl(baseTileUrl());
  // Atribuce se musí přepsat taky — jinak by u Esri dlaždic svítilo CARTO.
  try {
    const ctrl = _layer._map?.attributionControl;
    if (ctrl) {
      Object.keys(ctrl._attributions || {}).forEach(a => ctrl.removeAttribution(a));
      ctrl.addAttribution(b.attribution);
    }
  } catch { /* atribuce je kosmetika, ne důvod k pádu */ }
  window.dispatchEvent(new CustomEvent("nowcast:basemap-changed", { detail: { key: getBasemap() } }));
}

// Vytvoří podkladovou vrstvu a přihlásí ji k odběru změn motivu.
// Používá se i z fallback větve v app.js (mapa bez radarového manifestu).
export function createBaseTileLayer() {
  const b = BASEMAPS[getBasemap()] || BASEMAPS[DEFAULT_BASEMAP];
  const opts = { attribution: b.attribution, maxZoom: b.maxZoom || 19 };
  if (b.subdomains) opts.subdomains = b.subdomains;
  const layer = L.tileLayer(baseTileUrl(), opts);
  _layer = layer;
  document.body.classList.toggle("basemap-busy", !!basemapBodyClass());
  window.addEventListener("nowcast:theme-changed", () => layer.setUrl(baseTileUrl()));
  return layer;
}

export function initMap(onMapClick) {
  state.map = L.map("map", { zoomControl: false }).setView([49.8, 15.5], 7);
  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  state.baseTiles = createBaseTileLayer().addTo(state.map);

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
