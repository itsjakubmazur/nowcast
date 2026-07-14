import { state, PLAY, AUTO_REFRESH_MS } from "./state.js";
import { initTheme } from "./theme.js";
import { showToast, initToastClose } from "./toast.js";
import { initMap } from "./map.js";
import {
  preloadFrames, showFrame, stepFrame, togglePlay, setOpacity,
  toggleGlobalMode, applyManifestUI, drawRainSpark, updateStormBar,
  observeRadarBarHeight,
} from "./radar.js";
import { renderWarningsLayer } from "./warnings.js";
import {
  renderWuOwnPanel, renderWuMarkers, renderChmiMarkers, closeWuDetail, closeChmiDetail,
} from "./stations.js";
import {
  fetchOpenMeteo, parseFc24, parseMinutely15,
  renderFcHero, renderFcNow, renderFc24, renderFc7, renderMeteogram, fetchAndRenderAQ,
} from "./forecast.js";
import {
  nearestPt, templateVerdict, renderRainBadge, renderRainCountdown,
  fetchAiVerdict, renderVerdictText, renderAccuracyLine,
} from "./verdict.js";
import {
  loadFavs, renderFavRow, updateFavBtn, saveLastLocation, loadLastLocation,
  checkRainNotifications, clearRainSnooze, initPushButton,
} from "./favorites.js";
import { initSearch, reverseGeocode } from "./search.js";
import { shareCurrentView, copyEmbedLink, initEmbedMode } from "./share.js";
import { esc } from "./utils.js";

// ── Data fetch (graceful degradation — radar/grid kritické, zbytek volitelné) ─
async function loadData() {
  const v = `?v=${Date.now()}`;
  const opts = { cache: "no-store" };
  const fetchJson = async (name, versionKey) => {
    const url = `data/${name}${versionKey ? `?v=${encodeURIComponent(versionKey)}` : v}`;
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  const [manifest, grid] = await Promise.all([
    fetchJson("radar_manifest.json"),
    fetchJson("forecast_grid.json"),
  ]);
  state.MANIFEST = manifest;
  state.GRID = grid;

  // forecast.json (Prahou fixovaný Gemini verdikt) se záměrně nefetchuje —
  // AI verdikt teď jede per-location přes worker (viz verdict.js), takže by
  // to byl jen zbytečný request navíc.
  const optional = await Promise.allSettled([
    fetchJson("wu_stations.json"),
    fetchJson("chmi_stations.json"),
    fetchJson("accuracy.json"),
  ]);
  const [wu, chmi, accuracy] = optional.map(r => (r.status === "fulfilled" ? r.value : null));
  state.WU = wu;
  state.CHMI = chmi;
  state.ACCURACY = accuracy;
}

// ── Forecast pro vybrané místo (24h strip + meteogram + AQ + AI verdikt) ────
async function showFc24(lat, lon, label) {
  const scroll = document.getElementById("fc24-scroll");
  document.getElementById("fc24-place").textContent = label || "—";
  scroll.innerHTML = `<div style="padding:.6rem 1rem;color:var(--muted);font-size:.85rem">Načítám předpověď…</div>`;
  document.getElementById("fc24").style.display = "block";

  state.fc24Ctrl?.abort();
  const ctrl = new AbortController();
  state.fc24Ctrl = ctrl;

  try {
    const data = await fetchOpenMeteo(lat, lon, ctrl.signal);
    const fc = parseFc24(data);
    const minutely = parseMinutely15(data);
    renderFcHero(fc);
    renderFc24(fc, label);
    renderFcNow(fc, minutely);
    renderFc7(data, label);
    renderMeteogram(fc, data.daily);
    renderLocationVerdict(fc, lat, lon, label);
    fetchAndRenderAQ(lat, lon);
  } catch (e) {
    if (e.name === "AbortError") return;
    scroll.innerHTML = `<div style="padding:.6rem 1rem;color:var(--muted);font-size:.85rem">Předpověď se nepodařilo načíst (${esc(e.message)}).</div>`;
    document.getElementById("fc7").style.display = "none";
  }
}

function renderLocationVerdict(fc, lat, lon, label) {
  const h = fc.hourly;
  const b = fc.blocks;
  const sentences = [];

  const temps = h.map(x => x.temp).filter(v => v != null);
  if (temps.length) {
    const tmin = Math.min(...temps), tmax = Math.max(...temps);
    sentences.push(tmin === tmax ? `Teplota kolem ${tmax} °C.` : `Teploty ${tmin}–${tmax} °C.`);
  }
  const feelsDiffs = h.map(x => x.feelsDiff).filter(v => v != null && Math.abs(v) >= 3);
  if (feelsDiffs.length) {
    const d = feelsDiffs.reduce((a, x) => Math.abs(x) > Math.abs(a) ? x : a);
    sentences.push(`Pocitově ${d > 0 ? "tepleji" : "chladněji"} (${d > 0 ? "+" : ""}${d} °C).`);
  }
  const rainH = h.filter(x => x.precip > 0);
  if (rainH.length) {
    const totalMm = Math.round(rainH.reduce((s, x) => s + x.precip, 0) * 10) / 10;
    const maxProb = Math.max(...rainH.map(x => x.prob));
    const mmStr = totalMm < 1 ? "do 1 mm" : `kolem ${totalMm} mm`;
    sentences.push(`Srážky od ${rainH[0].t} do ${rainH[rainH.length - 1].t}, úhrn ${mmStr} (pravděpodobnost ${maxProb} %).`);
  } else {
    sentences.push("Srážky se v nejbližší době neočekávají.");
  }
  const maxGust = Math.max(...h.map(x => x.wind || 0));
  if (maxGust >= 30) sentences.push(`Vítr v nárazech až ${maxGust} km/h.`);
  const maxUv = Math.max(...h.map(x => x.uv || 0));
  if (maxUv >= 6) sentences.push(`Silné UV záření (index ${Math.round(maxUv)}) — doporučena ochrana.`);

  const p2 = [];
  const allTemps = b.flatMap(x => [x.tmin, x.tmax]).filter(v => v != null);
  if (allTemps.length) p2.push(`Denní teplotní rozsah ${Math.min(...allTemps)}–${Math.max(...allTemps)} °C.`);
  const rainBlocks = b.filter(x => x.precip > 0);
  p2.push(rainBlocks.length ? `Srážky možné od ${rainBlocks[0].t.split("–")[0]}.` : "Do konce dne bez výraznějších srážek.");

  const templateText = esc(sentences.join(" ") + (p2.length ? "\n\n" + p2.join(" ") : "")).replace(/\n\n/g, "<br><br>");

  let chips = "";
  try {
    const ptId = nearestPt(state.currentLat ?? lat, state.currentLon ?? lon).id;
    renderRainBadge(ptId);
    renderRainCountdown(ptId);
    chips = templateVerdict(ptId).chips;
  } catch { /* GRID pro toto místo nemusí mít bod */ }

  renderVerdictText(chips, templateText, null);

  // AI verdikt doplní/nahradí šablonu, jakmile dorazí (progressive enhancement)
  fetchAiVerdict(lat, lon, label).then(aiText => {
    if (aiText && state.currentLat === lat && state.currentLon === lon) {
      renderVerdictText(chips, templateText, aiText);
    }
  });

  renderAccuracyLine();
}

// ── Výběr místa ───────────────────────────────────────────────────────────────
function showForecast(lat, lon, label) {
  state.currentLat = lat; state.currentLon = lon; state.currentLabel = label;
  saveLastLocation(lat, lon, label);

  const { id, dist } = nearestPt(lat, lon);
  const { chips } = templateVerdict(id);
  renderRainBadge(id);
  renderRainCountdown(id);
  const pt = state.GRID.pts[id];

  document.getElementById("place").textContent = label || "Vybrané místo";
  document.getElementById("dist").textContent = `Nejbližší bod mřížky: ${dist.toFixed(1)} km`;
  updateFavBtn(lat, lon, label, () => renderFavRow(showForecast));

  renderVerdictText(chips, `<span style="color:var(--muted)">Načítám předpověď…</span>`, null);

  if (state.locationMarker) state.locationMarker.remove();
  state.locationMarker = L.marker([pt[0], pt[1]], { zIndexOffset: 500 }).addTo(state.map);
  state.map.setView([lat, lon], Math.max(state.map.getZoom(), 9));

  drawRainSpark(id);
  updateStormBar();
  showFc24(lat, lon, label);

  const u = new URL(window.location);
  u.searchParams.set("lat", lat.toFixed(4));
  u.searchParams.set("lon", lon.toFixed(4));
  if (label) u.searchParams.set("q", label);
  history.replaceState(null, "", u);
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const btn = document.getElementById("btn-refresh");
  btn.classList.add("spinning");
  btn.textContent = "↺ Načítám…";
  try {
    await loadData();
    preloadFrames();
    applyManifestUI();
    renderWuOwnPanel(); renderWuMarkers(); renderChmiMarkers(); renderWarningsLayer();
    if (state.currentLat !== null) showFc24(state.currentLat, state.currentLon, state.currentLabel);
  } catch (e) {
    document.getElementById("refresh-time").textContent = "Chyba: " + e.message;
  } finally {
    btn.classList.remove("spinning");
    btn.textContent = "↺ Aktualizovat";
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initToastClose();
  initEmbedMode();

  try {
    await loadData();
  } catch (err) {
    renderVerdictText("", `<span class="hint">Data se nepodařilo načíst (${esc(err.message)}). Pipeline možná ještě neproběhla.</span>`, null);
    state.map = L.map("map").setView([49.8, 15.5], 7);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { attribution: "© OpenStreetMap © CARTO", subdomains: "abcd" }).addTo(state.map);
    document.getElementById("radar-bar").style.display = "block";
    observeRadarBarHeight();
    document.getElementById("btn-global").addEventListener("click", toggleGlobalMode);
    return;
  }

  preloadFrames();
  initMap((lat, lon) => showForecast(lat, lon, "Bod na mapě"));
  document.getElementById("radar-bar").style.display = "block";
  observeRadarBarHeight();
  applyManifestUI();
  renderFavRow(showForecast);
  renderWuOwnPanel(); renderWuMarkers(); renderChmiMarkers(); renderWarningsLayer();
  checkRainNotifications();
  initPushButton();
  initSearch(showForecast);

  // ── Radar ovládání ────────────────────────────────────────────────────────
  document.getElementById("timeline").addEventListener("input", e => {
    if (state.playing) togglePlay(false);
    showFrame(+e.target.value);
  });
  document.getElementById("btn-prev").addEventListener("click", () => { if (state.playing) togglePlay(false); stepFrame(-1); });
  document.getElementById("btn-next").addEventListener("click", () => { if (state.playing) togglePlay(false); stepFrame(+1); });
  document.getElementById("btn-play").addEventListener("click", () => togglePlay());

  document.querySelectorAll(".speed-group .ctrl").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".speed-group .ctrl").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      PLAY.intervalMs = +btn.dataset.ms;
    });
  });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    if (e.key === "ArrowLeft") { if (state.playing) togglePlay(false); stepFrame(-1); }
    if (e.key === "ArrowRight") { if (state.playing) togglePlay(false); stepFrame(+1); }
  });

  document.getElementById("opacity-slider").addEventListener("input", e => setOpacity(+e.target.value));

  // ── Geolokace ─────────────────────────────────────────────────────────────
  document.getElementById("geo").addEventListener("click", () => {
    if (!navigator.geolocation) { showToast("Geolokace není podporována."); return; }
    const btn = document.getElementById("geo");
    btn.textContent = "📍 Zjišťuji…"; btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      async p => {
        const { latitude, longitude } = p.coords;
        let label = "Moje poloha";
        try {
          const name = await reverseGeocode(latitude, longitude);
          if (name) label = name;
        } catch { /* fallback na "Moje poloha" */ }
        btn.textContent = "📍"; btn.disabled = false;
        showForecast(latitude, longitude, label);
      },
      () => { btn.textContent = "📍"; btn.disabled = false; showToast("Polohu se nepodařilo zjistit."); },
      { timeout: 10000 }
    );
  });

  // ── Refresh / vrstvy / globální radar ────────────────────────────────────
  document.getElementById("btn-refresh").addEventListener("click", refreshAll);
  document.getElementById("btn-global").addEventListener("click", toggleGlobalMode);
  setInterval(() => { refreshAll(); checkRainNotifications(); }, AUTO_REFRESH_MS);

  document.getElementById("chmi-detail-close").addEventListener("click", closeChmiDetail);

  document.querySelectorAll(".layer-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".layer-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.chmiLayer = btn.dataset.layer;
      renderChmiMarkers();
    });
  });

  document.getElementById("notif-close").addEventListener("click", () => {
    document.getElementById("notif-bar").classList.remove("show");
    clearRainSnooze();
  });

  document.getElementById("wu-detail-overlay").addEventListener("click", e => {
    if (e.target.id === "wu-detail-overlay") closeWuDetail();
  });

  // ── Sdílení / embed ───────────────────────────────────────────────────────
  document.getElementById("btn-share")?.addEventListener("click", () => shareCurrentView(state.currentLabel));
  document.getElementById("btn-share-2")?.addEventListener("click", () => shareCurrentView(state.currentLabel));
  document.getElementById("btn-embed")?.addEventListener("click", copyEmbedLink);

  // ── Motiv (přerenderuj sparkline/legendu po přepnutí — barvy se liší) ──────
  window.addEventListener("nowcast:theme-changed", () => {
    if (state.currentLat !== null) {
      const { id } = nearestPt(state.currentLat, state.currentLon);
      drawRainSpark(id);
    }
  });

  // ── Obnov stav: URL params > poslední místo > první oblíbené > nic ────────
  const u = new URL(window.location);
  const qLat = parseFloat(u.searchParams.get("lat"));
  const qLon = parseFloat(u.searchParams.get("lon"));
  const q = u.searchParams.get("q");
  if (!isNaN(qLat) && !isNaN(qLon)) {
    showForecast(qLat, qLon, q || "Vybrané místo");
  } else {
    const last = loadLastLocation();
    const favs = loadFavs();
    if (last) showForecast(last.lat, last.lon, last.label);
    else if (favs.length) showForecast(favs[0].lat, favs[0].lon, favs[0].label);
  }
});

// ── Service Worker ────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
