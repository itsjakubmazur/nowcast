import { state, PLAY, AUTO_REFRESH_MS } from "./state.js";
import { initTheme } from "./theme.js";
import { showToast, initToastClose } from "./toast.js";
import { initMap, createBaseTileLayer } from "./map.js";
import {
  preloadFrames, showFrame, stepFrame, togglePlay, setOpacity,
  toggleGlobalMode, toggleSatellite, applyManifestUI, drawRainSpark, updateStormBar,
  observeRadarBarHeight,
} from "./radar.js";
import { renderWarningsLayer } from "./warnings.js";
import {
  renderWuOwnPanel, renderWuMarkers, renderChmiMarkers, closeWuDetail, closeChmiDetail,
} from "./stations.js";
import {
  fetchOpenMeteo, parseFc24, parseMinutely15,
  renderFcHero, renderFcNow, renderFc24, renderFc7, renderMeteogram, fetchAndRenderAQ,
  addModelSpread,
} from "./forecast.js";
import {
  nearestPt, templateVerdict, renderRainBadge, renderRainCountdown,
  fetchAiVerdict, renderVerdictText, renderAccuracyLine, initAiAsk, showAiAsk,
} from "./verdict.js";
import {
  loadFavs, renderFavRow, updateFavBtn, saveLastLocation, loadLastLocation,
  checkRainNotifications, clearRainSnooze, initPushButton,
} from "./favorites.js";
import { initSearch, reverseGeocode } from "./search.js";
import {
  renderMinutely, renderActivities, renderDeltaLine, renderAstro, renderWinter,
} from "./extras.js";
import { renderClimateAnomaly } from "./climate.js";
import { initLightning } from "./lightning.js";
import { showLoadingSkeletons } from "./skeleton.js";
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
  document.getElementById("fc24-place").textContent = label || "—";
  // Skeleton placeholdery mají STEJNÉ rozměry jako finální karty — takže i
  // karty pod scrollem (meteogram, 7 dní, ovzduší…) jsou hned vidět správně
  // velké, místo aby byly prázdné/schované a pak najednou "naskočily".
  showLoadingSkeletons();

  const scroll = document.getElementById("fc24-scroll");
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
    // v2.0 doplňky — každý panel se sám schová, když pro něj nejsou data
    try {
      const ptId = state.GRID ? nearestPt(lat, lon).id : null;
      renderAstro(data, fc);            // před aktivitami — nastavuje svit měsíce
      renderMinutely(ptId, minutely);
      renderActivities(fc, data);
      renderDeltaLine(data);
      renderWinter(fc, data);
      addModelSpread(lat, lon, fc);           // async — pásmo nejistoty do meteogramu
      renderClimateAnomaly(lat, lon, data);   // async — odchylka od normálu
    } catch (e) { console.warn("v2 doplňky selhaly:", e); }
  } catch (e) {
    if (e.name === "AbortError") return;
    scroll.innerHTML = `<div style="padding:.6rem 1rem;color:var(--muted);font-size:.85rem">Předpověď se nepodařilo načíst (${esc(e.message)}).</div>`;
    document.getElementById("fc7").style.display = "none";
    // Skeletony ostatních karet by jinak zůstaly navždy "načítat se" —
    // schovej je stejně, jako by to udělal jejich vlastní render, kdyby
    // pro dané místo neměly co zobrazit.
    ["meteo-block", "aq-panel", "astro-panel", "activities-panel", "minutely-panel"]
      .forEach(id => document.getElementById(id)?.classList.remove("show"));
    // Bez tohohle zůstane levá karta navždy zaseknutá na "Načítám předpověď…"
    // ze showForecast, protože se sem nikdy nedostane renderLocationVerdict.
    renderVerdictText("", `<span style="color:var(--muted)">Předpověď se nepodařilo načíst. Zkus obnovit stránku.</span>`, null);
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
  showAiAsk();

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

// ── Mobilní sheet — tažením za úchyt zvětšíš mapu, klepnutím přepneš ────────
function initSheetDrag() {
  const grabber = document.getElementById("sheet-grabber");
  if (!grabber || !window.matchMedia("(max-width: 768px)").matches) return;

  const SNAPS = [26, 40, 74]; // vh: velký přehled / výchozí / velká mapa
  let startY = 0, startVh = 40, dragging = false, moved = false;

  const getVh = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--sheet-top").trim();
    return v.endsWith("vh") ? parseFloat(v) : 40;
  };
  const setVh = vh => {
    document.documentElement.style.setProperty("--sheet-top", vh + "vh");
  };
  const settle = () => {
    // Leaflet potřebuje vědět, že se mu změnila výška kontejneru
    state.map?.invalidateSize();
  };

  grabber.addEventListener("pointerdown", e => {
    dragging = true; moved = false;
    startY = e.clientY;
    startVh = getVh();
    grabber.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grabber.addEventListener("pointermove", e => {
    if (!dragging) return;
    const dvh = (e.clientY - startY) / window.innerHeight * 100;
    if (Math.abs(dvh) > 1.5) moved = true;
    setVh(Math.min(80, Math.max(20, startVh + dvh)));
  });
  grabber.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) {
      // klepnutí = přepnutí výchozí ↔ velká mapa
      setVh(getVh() < 55 ? 74 : 40);
    } else {
      const cur = getVh();
      const snap = SNAPS.reduce((a, b) => Math.abs(b - cur) < Math.abs(a - cur) ? b : a);
      setVh(snap);
    }
    settle();
  });
  grabber.addEventListener("pointercancel", () => { dragging = false; settle(); });
}

// ── Offline badge — jasně říct, že koukáš na stará data ─────────────────────
function initOfflineBadge() {
  const badge = document.getElementById("offline-badge");
  const text = document.getElementById("offline-text");
  if (!badge) return;
  const update = () => {
    const off = !navigator.onLine;
    badge.classList.toggle("show", off);
    if (off && text) {
      const gen = state.MANIFEST?.generated_at_utc;
      text.textContent = gen
        ? `Offline — data z ${new Date(gen).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`
        : "Offline — ukazuji poslední stažená data";
    }
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
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
    createBaseTileLayer().addTo(state.map);
    document.getElementById("radar-bar").style.display = "block";
    observeRadarBarHeight();
    document.getElementById("btn-global").addEventListener("click", toggleGlobalMode);
    document.getElementById("btn-satellite")?.addEventListener("click", toggleSatellite);
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
  initAiAsk();
  initLightning();
  initOfflineBadge();
  initSheetDrag();

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
  document.getElementById("btn-satellite")?.addEventListener("click", toggleSatellite);
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
