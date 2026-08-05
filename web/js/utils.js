// Sdílené drobné utility — bez závislosti na DOM/mapě, snadno testovatelné.

import { state } from "./state.js";

export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Desetinné číslo pro čtenáře — česky, tedy s ČÁRKOU.
 *
 * Appka to dělala oběma způsoby najednou. V pravém sloupci pod sebou stály
 * dva panely: "NORMÁL 1991–2020 · 18,8 °C" (chmidata.js si čárku dosazoval
 * ručně) a hned pod ním "TENTO DEN V HISTORII · 30.4 °C" (climate.js
 * nechával toFixed jak je). Stejný typ čísla, stejná jednotka, dva zápisy
 * na vzdálenost dvou centimetrů.
 *
 * Ruční `.replace(".", ",")` roztroušené po souborech to neuhlídá — stačí
 * na jednom místě zapomenout. Proto jedna funkce, přes kterou jde každé
 * číslo, které uvidí uživatel. Vnitřní hodnoty (klíče cache, souřadnice do
 * URL, procenta do CSS) přes ni NESMÍ — tam musí zůstat tečka.
 */
export function num(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  // Koncová nula se ořezává. Bez toho vycházelo "UV INDEX 1,0" a "SRÁŽKY/H
  // 0,0 mm" — desetinné místo, které nenese žádnou informaci, jen tvrdí
  // přesnost, kterou ta čísla nemají. Když je co ukázat, ukáže se to:
  // 0.42 → "0,42", 6.5 → "6,5", 22 → "22".
  return Number(v).toFixed(digits).replace(/\.?0+$/, "").replace(".", ",") || "0";
}

export function haversine(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dp = (la2 - la1) * r, dl = (lo2 - lo1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dL = (lon2 - lon1) * r;
  const y = Math.sin(dL) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r)
          - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
  const b = (Math.atan2(y, x) / r + 360) % 360;
  const dirs = ["S", "SV", "V", "JV", "J", "JZ", "Z", "SZ"];
  return dirs[Math.round(b / 45) % 8];
}

export function degToCompass(deg) {
  const dirs = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
  return dirs[Math.round(deg / 22.5) % 16];
}

export function ageMinutes(isoStr) {
  try { return Math.round((Date.now() - new Date(isoStr).getTime()) / 60000); }
  catch { return null; }
}

// Časy se zobrazují v místním čase VYBRANÉHO MÍSTA (state.tz z Open-Meteo
// timezone=auto) — pro ČR je to Europe/Prague, pro Tokio Asia/Tokyo atd.
export function localHM(utcIso) {
  return new Date(utcIso).toLocaleTimeString("cs-CZ", { timeZone: state.tz, hour: "2-digit", minute: "2-digit" });
}

// "Teď" jako naivní lokální řetězec místa (YYYY-MM-DDTHH:00) — pro hledání
// aktuálního indexu v hodinových řadách Open-Meteo (ty chodí v local time).
export function nowLocStr() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: state.tz });
  return s.slice(0, 10) + "T" + s.slice(11, 14) + "00";
}

// Dnešní datum místa (YYYY-MM-DD) — pro ořez daily řad a denní srovnání.
export function locDateStr() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: state.tz });
}

export function uvClass(uv) {
  if (uv == null) return "";
  if (uv < 3) return "uv-low";
  if (uv < 6) return "uv-mod";
  if (uv < 8) return "uv-high";
  return "uv-vhigh";
}

export function beaufortLabel(kmh) {
  if (kmh == null) return "";
  if (kmh < 1) return "Beaufort 0 · Bezvětří";
  if (kmh < 6) return "Beaufort 1 · Vánek";
  if (kmh < 12) return "Beaufort 2 · Větřík";
  if (kmh < 20) return "Beaufort 3 · Slabý vítr";
  if (kmh < 29) return "Beaufort 4 · Mírný vítr";
  if (kmh < 39) return "Beaufort 5 · Čerstvý vítr";
  if (kmh < 50) return "Beaufort 6 · Silný vítr";
  if (kmh < 62) return "Beaufort 7 · Mírný štorm";
  if (kmh < 75) return "Beaufort 8 · Čerstvý štorm";
  if (kmh < 89) return "Beaufort 9 · Silný štorm";
  if (kmh < 103) return "Beaufort 10 · Plný štorm";
  if (kmh < 118) return "Beaufort 11 · Vichřice";
  return "Beaufort 12 · Orkán";
}

// Nahradí obsah elementu s krátkým fade-in — místo "naskočení" hotového
// obsahu (typicky přes skeleton placeholder) se nový obsah zjeví plynule.
// Element musí mít definovanou transition na opacity (viz .fade-swap v CSS).
export function revealSwap(el, html) {
  if (!el) return;
  el.classList.add("fade-swap");
  el.style.opacity = "0";
  el.innerHTML = html;
  void el.offsetWidth; // vynutí reflow, ať se přechod skutečně přehraje
  requestAnimationFrame(() => { el.style.opacity = "1"; });
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Fáze měsíce tady BYLA, ale nikdo ji nevolal — počítá ji astro.js a kreslí
// icons.js přes Meteocons. Zbyl z ní jen seznam emoji, který tiše kazil
// jednotnou ikonografii, tak šla pryč.
