// Celosvětové teploty ze stanic přímo na mapě, s možností je skrýt.
//
// Zapnuto NATIVNĚ: naměřená teplota je to první, co člověk od mapy počasí
// čeká. Vypínač je tam proto, aby šla vidět mapa pod tím — stejná logika
// jako u vrstvy větru nebo hladin.
//
// Data jsou dlaždice METAR z worldstations.js (~5000 letišť celosvětově).
// České stanice ČHMÚ kreslí renderChmiMarkers() zvlášť a hustěji, takže
// tady se jim vyhýbáme — dvě čísla přes sebe na jednom místě jsou horší
// než jedno.

import { state } from "./state.js";
import { esc, haversine, ageMinutes } from "./utils.js";
import { tilesForBounds, loadTile } from "./worldstations.js";
import { chmiMarkerColor, renderChmiMarkers } from "./stations.js";
import { thinByZoom, maxLabelsFor } from "./labelthin.js";

const LS_KEY = "nowcast_temps_on";
const MIN_ZOOM = 4;        // níž je celý kontinent a popisky by byly kaše
const MAX_TILES = 16;      // pojistka proti "oddálím na celý svět"
const MAX_LABELS = 160;
const MAX_AGE_MIN = 180;
const CHMI_SKIP_KM = 12;   // blíž k české stanici popisek nekreslíme

let _token = 0;            // stejná ochrana jako u větru — rychlé posouvání
                           // mapy nesmí nechat dokreslit starý výřez

export function tempsEnabled() {
  const v = localStorage.getItem(LS_KEY);
  return v === null ? true : v === "1";   // výchozí stav: ZAPNUTO
}

function setEnabled(on) {
  localStorage.setItem(LS_KEY, on ? "1" : "0");
  state.tempsOn = on;
}

function clearMarkers() {
  (state.worldTempMarkers || []).forEach(m => m.remove());
  state.worldTempMarkers = [];
}

// Prořezání popisků: v jedné buňce mřížky necháme jen jednu stanici, jinak
// by se u hustých oblastí (Německo, východní pobřeží USA) čísla slila.
// Sdíleno s českou vrstvou (labelthin.js), ať se obě chovají stejně —
// dřív měla každá vrstva vlastní pravidlo a české stanice se neprořezávaly
// vůbec.
export function thinStations(stations, zoom, maxLabels = MAX_LABELS) {
  return thinByZoom(stations, zoom, { maxLabels: maxLabelsFor(zoom, maxLabels) });
}

function nearChmi(s) {
  const cz = state.CHMI?.stations || [];
  for (const c of cz) {
    if (c.lat == null || c.temp == null) continue;
    if (haversine(s.lat, s.lon, c.lat, c.lon) <= CHMI_SKIP_KM) return true;
  }
  return false;
}

export async function renderWorldTemps() {
  const btn = document.getElementById("btn-temps");
  if (!state.map) return;
  const my = ++_token;
  clearMarkers();
  btn?.classList.toggle("active", tempsEnabled());
  if (!tempsEnabled()) return;

  const zoom = state.map.getZoom?.() ?? 7;
  if (zoom < MIN_ZOOM) return;
  const b = state.map.getBounds?.();
  if (!b) return;
  const south = b.getSouth(), west = b.getWest();
  const north = b.getNorth(), east = b.getEast();

  const ids = tilesForBounds(south, west, north, east).slice(0, MAX_TILES);
  const lists = await Promise.all(ids.map(loadTile));
  if (my !== _token) return;      // mezitím se mapa posunula

  const inView = [];
  for (const list of lists) {
    for (const s of list) {
      if (s.temp == null || s.lat == null) continue;
      if (s.lat < south || s.lat > north) continue;
      if (west <= east ? (s.lon < west || s.lon > east)
        : (s.lon < west && s.lon > east)) continue;
      const age = ageMinutes(s.time_utc);
      if (age == null || age > MAX_AGE_MIN) continue;
      if (nearChmi(s)) continue;
      inView.push(s);
    }
  }

  const shown = thinStations(inView, zoom);
  const markers = [];
  for (const s of shown) {
    const t = Math.round(s.temp);
    const text = `${t} °C`;
    const w = Math.max(34, text.length * 8 + 8);
    const icon = L.divIcon({
      className: "",
      html: `<div class="temp-label-marker wt-label" style="background:${chmiMarkerColor("temp", s.temp)};width:${w}px">${esc(text)}</div>`,
      iconSize: [w, 18],
      iconAnchor: [w / 2, 9],
    });
    const age = ageMinutes(s.time_utc);
    const m = L.marker([s.lat, s.lon], { icon, zIndexOffset: 20 })
      .bindPopup(`<div class="wu-popup"><strong>${esc(s.name || s.id)}</strong>`
        + `<span style="color:var(--muted);font-size:var(--fs-tiny)"> ● METAR</span><br>`
        + `🌡️ ${esc(s.temp)} °C`
        + (s.humidity != null ? ` &nbsp; 💧 ${esc(s.humidity)} %` : "")
        + (s.wind_kmh != null ? `<br>🌬️ ${esc(s.wind_kmh)} km/h` : "")
        + (age != null ? `<br><small style="color:var(--muted)">před ${age} min</small>` : "")
        + `</div>`)
      .addTo(state.map);
    markers.push(m);
  }
  if (my !== _token) { markers.forEach(m => m.remove()); return; }
  state.worldTempMarkers = markers;
}

let _debounce = null;
let _debounceCz = null;

export function initWorldTemps() {
  const btn = document.getElementById("btn-temps");
  btn?.classList.toggle("active", tempsEnabled());
  btn?.addEventListener("click", () => {
    setEnabled(!tempsEnabled());
    renderChmiMarkers();   // české stanice se schovají/objeví spolu s letištními
    renderWorldTemps();
  });
  // Překreslujeme až po doposunutí — během tažení mapy by to jen zdržovalo.
  // České stanice se musí překreslit taky: prořezání závisí na zoomu a výřezu,
  // takže bez tohohle by po přiblížení zůstal starý (řídký) výběr.
  state.map?.on?.("moveend", () => {
    clearTimeout(_debounceCz);
    _debounceCz = setTimeout(() => renderChmiMarkers(), 250);
  });
  state.map?.on?.("moveend", () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(renderWorldTemps, 250);
  });
  renderWorldTemps();
}
