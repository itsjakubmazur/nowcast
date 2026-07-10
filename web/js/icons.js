// Vlastní inline SVG sada počasí — žádná externí závislost (na rozdíl od emoji,
// vykreslí se identicky na všech OS/prohlížečích). Mapováno z WMO weather_code.

const SUN = `<circle cx="12" cy="12" r="4.4" fill="#f5a524"/>
  <g stroke="#f5a524" stroke-width="1.6" stroke-linecap="round">
    <path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5"/>
    <path d="M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3L5.6 5.6"/>
  </g>`;

const MOON = `<path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.2Z" fill="#94a3b8"/>`;

const CLOUD = (fill = "#94a3b8") =>
  `<path d="M7.5 18.5a4.3 4.3 0 0 1-.4-8.6 5.4 5.4 0 0 1 10.4-1.7 3.9 3.9 0 0 1-.7 10.3Z" fill="${fill}"/>`;

function cloudSun() {
  return `<g transform="translate(-2,-2) scale(0.72)"><g transform="translate(3,1)">${SUN}</g></g>
    <g transform="translate(3,6) scale(0.86)">${CLOUD("#cbd5e1")}</g>`;
}
function cloudMoon() {
  return `<g transform="translate(2,0) scale(0.68)">${MOON}</g>
    <g transform="translate(3,7) scale(0.86)">${CLOUD("#94a3b8")}</g>`;
}
function rainDrops(n = 3, color = "#4f8ef7") {
  const xs = [7.5, 12, 16.5].slice(0, n);
  return xs.map((x, i) =>
    `<path d="M${x} 18.5c0 1.1-.9 2-1.6 2s-1.6-.9-1.6-2c0-1.2 1.6-3.4 1.6-3.4s1.6 2.2 1.6 3.4Z" fill="${color}"/>`
  ).join("");
}
function snowFlakes(n = 3) {
  const xs = [7.5, 12, 16.5].slice(0, n);
  return xs.map(x =>
    `<g stroke="#bae6fd" stroke-width="1.3" stroke-linecap="round" transform="translate(${x},19)">
      <path d="M-1.8 0h3.6M0-1.8v3.6M-1.3-1.3l2.6 2.6M1.3-1.3l-2.6 2.6"/>
    </g>`
  ).join("");
}
function bolt() {
  return `<path d="M13 12.5h-3l1.6-4.5-4.6 6h3l-1.6 4.5 4.6-6Z" fill="#f5a524"/>`;
}
function fogLines() {
  return `<g stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round">
    <path d="M5 17h14M6.5 20h11"/>
  </g>`;
}

// (svgBody, viewBoxY) — trocha inline transformace pro sladění mraku+doplňků
function icon(body) {
  return `<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">${body}</svg>`;
}

const ICONS = {
  clearDay:    () => icon(SUN),
  clearNight:  () => icon(MOON),
  pcloudyDay:  () => icon(cloudSun()),
  pcloudyNight:() => icon(cloudMoon()),
  cloudy:      () => icon(CLOUD()),
  fog:         () => icon(CLOUD("#a8b3c4") + fogLines()),
  drizzle:     () => icon(CLOUD() + rainDrops(2)),
  rain:        () => icon(CLOUD() + rainDrops(3)),
  rainHeavy:   () => icon(CLOUD("#64748b") + rainDrops(3, "#2563eb")),
  sleet:       () => icon(CLOUD() + rainDrops(1) + snowFlakes(1)),
  snow:        () => icon(CLOUD("#cbd5e1") + snowFlakes(3)),
  thunder:     () => icon(CLOUD("#64748b") + bolt()),
  thunderHail: () => icon(CLOUD("#64748b") + bolt() + snowFlakes(1)),
  unknown:     () => icon(CLOUD()),
};

// WMO weather_code → ikona (den)
const WC_ICON_DAY = {
  0: "clearDay", 1: "pcloudyDay", 2: "pcloudyDay", 3: "cloudy",
  45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle",
  56: "sleet", 57: "sleet",
  61: "rain", 63: "rain", 65: "rainHeavy",
  66: "sleet", 67: "sleet",
  71: "snow", 73: "snow", 75: "snow", 77: "snow",
  80: "drizzle", 81: "rain", 82: "rainHeavy",
  85: "snow", 86: "snow",
  95: "thunder", 96: "thunderHail", 99: "thunderHail",
};
// Noční varianty jen pro jasno/polojasno — zbytek stejný ve dne v noci
const WC_ICON_NIGHT = { ...WC_ICON_DAY, 0: "clearNight", 1: "pcloudyNight", 2: "pcloudyNight" };

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
  const table = night ? WC_ICON_NIGHT : WC_ICON_DAY;
  const key = wc != null ? (table[wc] ?? "unknown") : "unknown";
  return (ICONS[key] || ICONS.unknown)();
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
