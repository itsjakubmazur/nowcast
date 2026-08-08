// Nastavení aplikace + deník upozornění. Vše čistě v localStorage — žádný
// server. Prahy a volby čtou ostatní moduly přes getSettings().

import { state, PLAY } from "./state.js";
import { BASEMAPS, getBasemap, setBasemap } from "./map.js";
import { bindModal } from "./modal.js";
import { getThemePref, setThemePref } from "./theme.js";

const SETTINGS_KEY = "nowcast_settings_v1";
const LOG_KEY = "nowcast_notif_log_v1";
const LOG_MAX = 30;

const DEFAULTS = {
  layer: "temp",     // výchozí vrstva ČHMÚ markerů
  animMs: 500,       // rychlost radarové animace
  rainThresh: 0.2,   // mm/h — od jaké intenzity upozorňovat na déšť
};

export function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota */ }
  return s;
}

// ── Deník upozornění ─────────────────────────────────────────────────────────
export function logNotif(msg) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    log.unshift({ t: Date.now(), msg });
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, LOG_MAX)));
  } catch { /* quota */ }
}

function getNotifLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; }
}

function renderLog() {
  const el = document.getElementById("settings-log");
  if (!el) return;
  const log = getNotifLog();
  if (!log.length) {
    el.innerHTML = `<div class="set-log-empty">Zatím žádná upozornění — objeví se tu déšť a výstrahy pro oblíbená místa.</div>`;
    return;
  }
  el.innerHTML = log.map(e => {
    const d = new Date(e.t);
    const when = d.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<div class="set-log-row"><span class="set-log-time">${when}</span><span>${e.msg.replace(/</g, "&lt;")}</span></div>`;
  }).join("");
}

// ── Aplikace uložených voleb při startu ──────────────────────────────────────
export function applySettingsOnLoad() {
  const s = getSettings();
  state.chmiLayer = s.layer;
  document.querySelectorAll(".layer-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.layer === s.layer));
  PLAY.intervalMs = s.animMs;
  document.querySelectorAll(".speed-group .ctrl").forEach(b =>
    b.classList.toggle("active", +b.dataset.ms === s.animMs));
}

// ── Panel ────────────────────────────────────────────────────────────────────
export function initSettingsPanel() {
  const overlay = document.getElementById("settings-overlay");
  const btn = document.getElementById("btn-settings");
  if (!overlay || !btn) return;

  const s = getSettings();
  const layerSel = document.getElementById("set-layer");
  const animSel = document.getElementById("set-anim");
  const threshSel = document.getElementById("set-thresh");

  // Podkladová mapa. Výběr v HTML existoval, ale nikdo ho neposlouchal —
  // přepnutí tedy nic nedělalo. Volby se navíc plní z BASEMAPS, aby se
  // seznam v <select> nemohl rozejít s tím, co mapa umí vykreslit.
  const baseSel = document.getElementById("set-basemap");
  if (baseSel) {
    baseSel.innerHTML = Object.entries(BASEMAPS)
      .map(([k, b]) => `<option value="${k}">${b.label}</option>`).join("");
    baseSel.value = getBasemap();
    baseSel.addEventListener("change", () => setBasemap(baseSel.value));
  }

  // Motiv — třetí stav "podle systému", ke kterému se z topbaru nedá vrátit.
  const themeSel = document.getElementById("set-theme");
  if (themeSel) {
    themeSel.value = getThemePref();
    themeSel.addEventListener("change", () => setThemePref(themeSel.value));
    // Přepnutí tlačítkem v topbaru musí posunout i tenhle výběr, jinak by
    // ukazoval něco jiného, než co je na obrazovce.
    window.addEventListener("nowcast:theme-changed", () => { themeSel.value = getThemePref(); });
  }

  if (layerSel) layerSel.value = s.layer;
  if (animSel) animSel.value = String(s.animMs);
  if (threshSel) threshSel.value = String(s.rainThresh);

  // Skutečný dialog — fokus dovnitř, Tab cyklí, Escape zavírá, zbytek
  // stránky je inert. Dřív to byl jen překryv s třídou `open`: fokus zůstal
  // na tlačítku pod ním a Tab z dialogu utekl. Viz modal.js.
  const dlg = bindModal({ overlay: "settings-overlay", box: "settings-box", label: "Nastavení" });
  btn.addEventListener("click", () => { renderLog(); dlg.open(); });
  document.getElementById("settings-close")?.addEventListener("click", () => dlg.close());

  layerSel?.addEventListener("change", () => {
    saveSettings({ layer: layerSel.value });
    state.chmiLayer = layerSel.value;
    document.querySelectorAll(".layer-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.layer === layerSel.value));
    window.dispatchEvent(new CustomEvent("nowcast:layer-changed"));
  });
  animSel?.addEventListener("change", () => {
    const ms = +animSel.value;
    saveSettings({ animMs: ms });
    PLAY.intervalMs = ms;
    document.querySelectorAll(".speed-group .ctrl").forEach(b =>
      b.classList.toggle("active", +b.dataset.ms === ms));
  });
  threshSel?.addEventListener("change", () => saveSettings({ rainThresh: +threshSel.value }));
}
