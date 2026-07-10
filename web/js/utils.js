// Sdílené drobné utility — bez závislosti na DOM/mapě, snadno testovatelné.

export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

export function localHM(utcIso) {
  return new Date(utcIso).toLocaleTimeString("cs-CZ", { timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit" });
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

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Fáze měsíce — hrubý astronomický odhad (přesnost ~den, na ikonu stačí).
const MOON_PHASES = ["🌑 Nov", "🌒 Dorůstající srpek", "🌓 První čtvrť", "🌔 Dorůstající měsíc",
  "🌕 Úplněk", "🌖 Couvající měsíc", "🌗 Poslední čtvrť", "🌘 Couvající srpek"];
export function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const known = Date.UTC(2000, 0, 6, 18, 14); // referenční nov
  const days = (date.getTime() - known) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic;
  const idx = Math.floor((phase / synodic) * 8 + 0.5) % 8;
  return { label: MOON_PHASES[idx], fraction: phase / synodic };
}
