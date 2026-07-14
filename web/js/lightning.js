// Blesky naživo — komunitní síť Blitzortung.org (websocket, zdarma).
// Server posílá údery LZW-komprimované; dekodér níž je standardní postup
// používaný open-source klienty. Když se spojení nepovede, funkce tiše
// degraduje — chip i markery prostě zůstanou skryté.

import { state } from "./state.js";

const WS_HOSTS = ["wss://ws1.blitzortung.org", "wss://ws7.blitzortung.org", "wss://ws8.blitzortung.org"];
const BBOX = { latMin: 47.5, latMax: 52.5, lonMin: 10.0, lonMax: 20.5 }; // ČR + okolí
const MAX_MARKERS = 150;
const MARKER_TTL_MS = 10 * 60 * 1000;

let _ws = null;
let _hostIdx = 0;
let _markers = [];       // { marker, time, lat, lon }
let _lastStrike = null;  // { lat, lon, time }
let _chipTimer = null;
let _reconnectTimer = null;

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

function updateChip() {
  const chip = document.getElementById("lightning-chip");
  const distEl = document.getElementById("lightning-dist");
  const ageEl = document.getElementById("lightning-age");
  if (!chip || !distEl) return;
  if (!_lastStrike || state.currentLat == null
      || Date.now() - _lastStrike.time > MARKER_TTL_MS) {
    chip.classList.remove("show");
    return;
  }
  const d = haversineKm(state.currentLat, state.currentLon, _lastStrike.lat, _lastStrike.lon);
  if (d > 150) { chip.classList.remove("show"); return; } // daleko — nezajímavé
  distEl.textContent = `${Math.round(d)} km`;
  if (ageEl) {
    const s = Math.round((Date.now() - _lastStrike.time) / 1000);
    ageEl.textContent = s < 90 ? `před ${s} s` : `před ${Math.round(s / 60)} min`;
  }
  chip.classList.add("show");
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
  if (!("WebSocket" in window)) return;
  connect();
  _chipTimer = setInterval(() => { pruneMarkers(); updateChip(); }, 15000);
  void _chipTimer;
}
