// Ikony počasí — Meteocons (Bas Milius, MIT), plnobarevná "fill" sada,
// jemně animovaná (SMIL uvnitř SVG — animace běží i v <img>). Soubory jsou
// self-hostované v icons/weather/, mapované z WMO weather_code s variantami
// den/noc. Vracíme <img> místo inline SVG — Meteocons používají <defs> s
// generickými ID gradientů, inline by na stránce kolidovaly.

const W_PATH = "icons/weather/";

export function wImg(name, cls = "wicon") {
  return `<img class="${cls}" src="${W_PATH}${name}.svg" alt="" decoding="async">`;
}

// WMO weather_code → název souboru (denní varianta)
const WC_DAY = {
  0: "clear-day", 1: "partly-cloudy-day", 2: "partly-cloudy-day", 3: "overcast-day",
  45: "fog-day", 48: "fog-day",
  51: "drizzle", 53: "drizzle", 55: "drizzle",
  56: "sleet", 57: "sleet",
  61: "rain", 63: "rain", 65: "extreme-day-rain",
  66: "sleet", 67: "sleet",
  71: "snow", 73: "snow", 75: "snow", 77: "snow",
  80: "partly-cloudy-day-rain", 81: "rain", 82: "extreme-day-rain",
  85: "partly-cloudy-day-snow", 86: "snow",
  95: "thunderstorms-day", 96: "thunderstorms-day-rain", 99: "thunderstorms-rain",
};
// Noční varianty — jen tam, kde se den/noc liší
const WC_NIGHT_OVERRIDE = {
  0: "clear-night", 1: "partly-cloudy-night", 2: "partly-cloudy-night", 3: "overcast-night",
  45: "fog-night", 48: "fog-night",
  65: "extreme-night-rain", 80: "partly-cloudy-night-rain", 82: "extreme-night-rain",
  85: "partly-cloudy-night-snow",
  95: "thunderstorms-night", 96: "thunderstorms-night-rain",
};

const WC_LABEL = {
  0: "Jasno", 1: "Převážně jasno", 2: "Polojasno", 3: "Zataženo",
  45: "Mlha", 48: "Mlha", 51: "Slabé mrholení", 53: "Mrholení", 55: "Silné mrholení",
  56: "Mrznoucí mrholení", 57: "Silné mrznoucí mrholení",
  61: "Slabý déšť", 63: "Déšť", 65: "Silný déšť",
  66: "Mrznoucí déšť", 67: "Silný mrznoucí déšť",
  71: "Slabé sněžení", 73: "Sněžení", 75: "Silné sněžení", 77: "Sněhové krupky",
  80: "Přeháňky", 81: "Přeháňky", 82: "Silné přeháňky",
  85: "Sněhové přeháňky", 86: "Silné sněhové přeháňky",
  95: "Bouřka", 96: "Bouřka s krupobitím", 99: "Silná bouřka s krupobitím",
};

export function wcLabel(wc) { return WC_LABEL[wc] ?? ""; }

export function wcIconSvg(wc, hour) {
  const night = hour != null && (hour < 6 || hour >= 21);
  let name = wc != null ? WC_DAY[wc] : null;
  if (night && wc != null && WC_NIGHT_OVERRIDE[wc]) name = WC_NIGHT_OVERRIDE[wc];
  return wImg(name || "cloudy");
}

// Fáze měsíce (0–1 věku synodického měsíce → 8 fází)
const MOON_PHASES = [
  "moon-new", "moon-waxing-crescent", "moon-first-quarter", "moon-waxing-gibbous",
  "moon-full", "moon-waning-gibbous", "moon-last-quarter", "moon-waning-crescent",
];
export function moonIconImg(phaseFrac) {
  const idx = Math.round(phaseFrac * 8) % 8;
  return wImg(MOON_PHASES[idx]);
}

const WC_SEV = {
  95: 9, 96: 9, 99: 9, 71: 8, 73: 8, 75: 8, 77: 8, 85: 7, 86: 7,
  55: 6, 57: 6, 65: 6, 67: 6, 51: 5, 53: 5, 61: 5, 63: 5, 80: 5, 81: 5, 82: 5,
  45: 4, 48: 4, 3: 3, 1: 2, 2: 2, 0: 1,
};
export function wcSev(c) { return WC_SEV[c] ?? 0; }
export function mostSevere(arr) {
  const v = arr.filter(c => c != null);
  return v.length ? v.reduce((a, b) => (wcSev(b) > wcSev(a) ? b : a)) : null;
}
