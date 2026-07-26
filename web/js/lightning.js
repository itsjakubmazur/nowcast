// Blesky naživo — komunitní síť Blitzortung.org (websocket, zdarma).
// Server posílá údery LZW-komprimované; dekodér níž je standardní postup
// používaný open-source klienty. Když se spojení nepovede, funkce tiše
// degraduje — chip i markery prostě zůstanou skryté.

import { state } from "./state.js";
import { renderStorms, initStormsButton, stormsEnabled } from "./storms.js";

const WS_HOSTS = ["wss://ws1.blitzortung.org", "wss://ws7.blitzortung.org", "wss://ws8.blitzortung.org"];
const BBOX = { latMin: 47.5, latMax: 52.5, lonMin: 10.0, lonMax: 20.5 }; // ČR + okolí
// Jednotlivé body úderů zůstávají jen krátce a je jich málo: "kde je bouřka"
// od téhle verze říkají shluky ze storms.js, takže sto rozsypaných blesků na
// mapě už jen překáželo.
const MAX_MARKERS = 60;
const MARKER_TTL_MS = 4 * 60 * 1000;

// Surové údery pro shlukování — delší okno a větší strop než u markerů,
// protože z nich vzniká plocha bouřky, ne body.
const STRIKE_TTL_MS = 25 * 60 * 1000;
const MAX_STRIKES = 4000;
const STORM_REDRAW_MS = 20 * 1000;

const NOTIFY_KM = 12;              // úder blíž = upozorni
const NOTIFY_SNOOZE_MS = 10 * 60 * 1000;

let _ws = null;
let _hostIdx = 0;
let _markers = [];       // { marker, time, lat, lon }
let _lastStrike = null;  // { lat, lon, time }
let _chipTimer = null;
let _reconnectTimer = null;
let _prevNearKm = null;  // nejbližší úder z minulého tiku — pro trend
let _lastNotify = 0;
let _strikes = [];       // { lat, lon, t } — vstup pro shlukování bouřek
let _lastStormDraw = 0;

// LZW dekodér Blitzortung streamu (publikovaný komunitní postup)
function decode(b) {
  const e = {};
  const d = b.split("");
  let c = d[0];
  let f = c;
  const g = [c];
  const h = 256;
  let o = h;
  for (let i = 1; i < d.length; i++) {
    const code = d[i].charCodeAt(0);
    const chunk = h > code ? d[i] : (e[code] ?? f + c);
    g.push(chunk);
    c = chunk.charAt(0);
    e[o] = f + c;
    o++;
    f = chunk;
  }
  return g.join("");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function addStrike(lat, lon, timeMs) {
  // Do bufferu pro shlukování jde úder vždy, i když se bod nekreslí —
  // bouřková vrstva na jednotlivých markerech nezávisí.
  _strikes.push({ lat, lon, t: timeMs });
  if (_strikes.length > MAX_STRIKES) _strikes.splice(0, _strikes.length - MAX_STRIKES);

  if (!state.map || typeof L === "undefined") return;
  const icon = L.divIcon({
    className: "lightning-marker",
    html: `<svg width="16" height="16" viewBox="0 0 24 24"><path d="M13.5 2 6 13.5h4.5L9 22l8.5-11.5H13z" fill="#FFD60A"/></svg>`,
    iconSize: [16, 16], iconAnchor: [8, 8],
  });
  const marker = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 400 }).addTo(state.map);
  _markers.push({ marker, time: timeMs, lat, lon });
  if (_markers.length > MAX_MARKERS) {
    const old = _markers.shift();
    old.marker.remove();
  }
  _lastStrike = { lat, lon, time: timeMs };
  updateChip();
  maybeRedrawStorms();
}

export function getStrikes() {
  return _strikes;
}

function pruneStrikes() {
  const cutoff = Date.now() - STRIKE_TTL_MS;
  if (_strikes.length && _strikes[0].t < cutoff) {
    _strikes = _strikes.filter(s => s.t >= cutoff);
  }
}

// Překreslení bouřek je dražší než posun markeru, tak se škrtí. Nový úder
// v už zakreslené bouřce nemusí vyvolat překreslení okamžitě.
function maybeRedrawStorms(force = false) {
  const now = Date.now();
  if (!force && now - _lastStormDraw < STORM_REDRAW_MS) return;
  _lastStormDraw = now;
  pruneStrikes();
  try { renderStorms(_strikes, now); } catch (e) { console.error("storms:", e); }
}

export function redrawStorms() {
  maybeRedrawStorms(true);
}

function pruneMarkers() {
  const cutoff = Date.now() - MARKER_TTL_MS;
  _markers = _markers.filter(m => {
    if (m.time < cutoff) { m.marker.remove(); return false; }
    // starší údery blednou
    const age = (Date.now() - m.time) / MARKER_TTL_MS;
    m.marker.setOpacity(1 - age * 0.75);
    return true;
  });
}

// Nejbližší ŽIVÝ úder (do TTL) k danému místu — pro trend a upozornění.
// Bereme minimum přes markery, ne jen poslední úder: poslední mohl padnout
// daleko, zatímco bouřka je blízko z jiného směru.
function nearestStrikeKm(lat, lon) {
  const cutoff = Date.now() - MARKER_TTL_MS;
  let best = Infinity;
  for (const m of _markers) {
    if (m.time < cutoff) continue;
    const d = haversineKm(lat, lon, m.lat, m.lon);
    if (d < best) best = d;
  }
  return best === Infinity ? null : best;
}

function updateChip() {
  const chip = document.getElementById("lightning-chip");
  const distEl = document.getElementById("lightning-dist");
  const ageEl = document.getElementById("lightning-age");
  const trendEl = document.getElementById("lightning-trend");
  if (!chip || !distEl) return;
  if (state.currentLat == null) { chip.classList.remove("show"); return; }

  const near = nearestStrikeKm(state.currentLat, state.currentLon);
  if (near == null || near > 150) { chip.classList.remove("show"); _prevNearKm = null; return; }

  distEl.textContent = `${Math.round(near)} km`;
  if (_lastStrike && ageEl) {
    const s = Math.round((Date.now() - _lastStrike.time) / 1000);
    ageEl.textContent = s < 90 ? `před ${s} s` : `před ${Math.round(s / 60)} min`;
  }

  // trend přibližuje/vzdaluje (hystereze ±2 km, ať to nepobliká)
  let approaching = false;
  if (trendEl) {
    if (_prevNearKm != null) {
      const diff = near - _prevNearKm;
      if (diff < -2) { trendEl.textContent = "↘ přibližuje se"; trendEl.className = "approaching"; approaching = true; }
      else if (diff > 2) { trendEl.textContent = "↗ vzdaluje se"; trendEl.className = "receding"; }
      else { trendEl.textContent = "→ stacionární"; trendEl.className = ""; }
    } else { trendEl.textContent = ""; }
  }
  _prevNearKm = near;

  chip.classList.toggle("near", near <= NOTIFY_KM);
  chip.classList.add("show");

  // Upozornění: bouřka blízko (a spíš se blíží). Respektuje snooze i to,
  // jestli má uživatel notifikace vůbec povolené.
  if (near <= NOTIFY_KM && Date.now() - _lastNotify > NOTIFY_SNOOZE_MS) {
    _lastNotify = Date.now();
    const msg = `⚡ Blesky ${Math.round(near)} km${approaching ? " a přibližují se" : ""} — bouřka nablízku.`;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("⚡ Bouřka nablízku", { body: msg, icon: "icon.svg", tag: "lightning-near" });
      }
    } catch { /* notifikace jsou bonus */ }
    window.dispatchEvent(new CustomEvent("nowcast:lightning-near", { detail: { km: Math.round(near), approaching } }));
  }
}

function connect() {
  try {
    _ws = new WebSocket(WS_HOSTS[_hostIdx % WS_HOSTS.length]);
  } catch {
    scheduleReconnect();
    return;
  }
  _ws.onopen = () => {
    _ws.send(JSON.stringify({ a: 111 })); // subscribe na stream úderů
  };
  _ws.onmessage = ev => {
    try {
      const strike = JSON.parse(decode(ev.data));
      const lat = strike.lat, lon = strike.lon;
      if (lat == null || lon == null) return;
      if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) return;
      const timeMs = strike.time ? Math.round(strike.time / 1e6) : Date.now();
      addStrike(lat, lon, timeMs);
    } catch { /* nečitelný záznam — ignoruj */ }
  };
  _ws.onerror = () => { try { _ws.close(); } catch { /* už zavřeno */ } };
  _ws.onclose = () => {
    _hostIdx++;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(_reconnectTimer);
  // po 3 neúspěšných kolech to vzdej na 10 minut (ať zbytečně nežereme baterii)
  const delay = _hostIdx >= WS_HOSTS.length * 3 ? 10 * 60 * 1000 : 5000;
  if (_hostIdx >= WS_HOSTS.length * 3) _hostIdx = 0;
  _reconnectTimer = setTimeout(connect, delay);
}

export function initLightning() {
  // Tlačítko a prázdné vykreslení jdou i bez WebSocketu — jinak by po vypnutí
  // sítě zůstalo tlačítko mrtvé a stará vrstva viset na mapě.
  initStormsButton(() => redrawStorms());
  try { renderStorms(_strikes, Date.now()); } catch { /* mapa ještě nemusí být */ }
  if (!("WebSocket" in window)) return;
  connect();
  _chipTimer = setInterval(() => {
    pruneMarkers();
    updateChip();
    maybeRedrawStorms(true);   // i bez nových úderů: staré bouřky musí vyblednout
  }, 15000);
  void _chipTimer;
  void stormsEnabled;
}
