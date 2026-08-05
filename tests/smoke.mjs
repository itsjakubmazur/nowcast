// Smoke test — ověří, že přestavěný frontend (moduly + nová UI) skutečně
// naběhne a klíčové featury fungují end-to-end, s fixture daty a stub
// Leaflet/Chart.js (sandbox nemá odchozí přístup na unpkg/jsdelivr/Open-Meteo).
//
// Spuštění: NODE_PATH=/opt/node22/lib/node_modules node tests/smoke.mjs

// V CI (npm ci) se "playwright" resolvuje normálně z node_modules/. V tomto
// vývojovém sandboxu není npm install spustitelný (bez sítě), takže tam
// spadneme zpět na globálně nainstalovaný balíček.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  ({ chromium } = (await import("/opt/node22/lib/node_modules/playwright/index.js")).default);
}
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const WEB = path.join(REPO, "web");
const FIXTURES = path.join(__dirname, "fixtures");
const SERVE = path.join(__dirname, ".serve-tmp");

let failures = 0;
function assertTrue(cond, msg) {
  if (!cond) { failures++; console.error(`✗ FAIL: ${msg}`); }
  else console.log(`✓ ${msg}`);
}

// ── Naivní lokální (Praha wall-clock) čas, bez DST komplikací — reprezentován
// jako UTC Date, jehož UTC-getters čteme jako "místní" pole. ─────────────────
function pragueNowAsNaive() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  return new Date(Date.UTC(+g("year"), +g("month") - 1, +g("day"), +g("hour") === 24 ? 0 : +g("hour"), +g("minute"), +g("second")));
}
function fmtDateTime(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtDate(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Syntetická klimatologie 1991–2020 pro archive-api (normál + rekordy) —
// stačí pár let, agregace v climate.js si poradí s libovolným počtem.
function buildArchiveFixture() {
  const daily = { time: [], temperature_2m_mean: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let y = 2015; y <= 2020; y++) {
    for (let d = 0; d < 365; d++) {
      const dt = new Date(Date.UTC(y, 0, 1 + d));
      daily.time.push(dt.toISOString().slice(0, 10));
      const seasonal = 10 + 10 * Math.sin(((d - 105) / 365) * 2 * Math.PI);
      daily.temperature_2m_mean.push(Math.round(seasonal * 10) / 10);
      daily.temperature_2m_max.push(Math.round((seasonal + 6 + (y - 2015)) * 10) / 10);
      daily.temperature_2m_min.push(Math.round((seasonal - 6 - (y - 2015)) * 10) / 10);
    }
  }
  return { daily };
}

function buildOpenMeteoFixture() {
  const nowHour = pragueNowAsNaive();
  nowHour.setUTCMinutes(0, 0, 0);

  const hourly = { time: [], weather_code: [], temperature_2m: [], apparent_temperature: [],
    precipitation: [], precipitation_probability: [], wind_speed_10m: [], wind_gusts_10m: [],
    wind_direction_10m: [], uv_index: [], cape: [], relative_humidity_2m: [], surface_pressure: [] };
  for (let i = 0; i < 30; i++) {
    const t = new Date(nowHour.getTime() + i * 3600000);
    hourly.time.push(fmtDateTime(t));
    hourly.weather_code.push(i < 3 ? 1 : i < 8 ? 61 : 2);
    hourly.temperature_2m.push(20 + Math.sin(i / 4) * 4);
    hourly.apparent_temperature.push(19 + Math.sin(i / 4) * 4);
    hourly.precipitation.push(i >= 3 && i < 6 ? 1.2 : 0);
    hourly.precipitation_probability.push(i >= 3 && i < 6 ? 70 : 5);
    hourly.wind_speed_10m.push(10 + (i % 5));
    hourly.wind_gusts_10m.push(18 + (i % 7) * 2);
    hourly.wind_direction_10m.push(220);
    hourly.uv_index.push(i < 10 ? Math.max(0, 6 - Math.abs(i - 5)) : 0);
    hourly.cape.push(i >= 3 && i < 6 ? 650 : 100);
    hourly.relative_humidity_2m.push(55);
    hourly.surface_pressure.push(1013);
  }

  const m15 = { time: [], precipitation: [], rain: [], snowfall: [], windspeed_10m: [], windgusts_10m: [], winddirection_10m: [], cape: [] };
  for (let i = 0; i < 40; i++) {
    const t = new Date(nowHour.getTime() + i * 15 * 60000);
    m15.time.push(fmtDateTime(t));
    m15.precipitation.push(i >= 12 && i < 24 ? 1.5 : 0);
    m15.rain.push(0); m15.snowfall.push(0);
    m15.windspeed_10m.push(10); m15.windgusts_10m.push(20 + (i % 5));
    m15.winddirection_10m.push(220); m15.cape.push(300);
  }

  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
    precipitation_sum: [], precipitation_probability_max: [], wind_gusts_10m_max: [], uv_index_max: [],
    sunrise: [], sunset: [] };
  const dayStart = pragueNowAsNaive();
  for (let i = 0; i < 7; i++) {
    const d = new Date(dayStart.getTime() + i * 86400000);
    daily.time.push(fmtDate(d));
    daily.weather_code.push(i === 0 ? 61 : 2);
    daily.temperature_2m_max.push(24 + i);
    daily.temperature_2m_min.push(14 + i);
    daily.precipitation_sum.push(i === 0 ? 4.2 : 0);
    daily.precipitation_probability_max.push(i === 0 ? 70 : 10);
    daily.wind_gusts_10m_max.push(35);
    daily.uv_index_max.push(6);
    daily.sunrise.push(fmtDateTime(new Date(d.getTime() + 5 * 3600000)));
    daily.sunset.push(fmtDateTime(new Date(d.getTime() + 20 * 3600000)));
  }

  return { hourly, minutely_15: m15, daily, timezone: "Europe/Prague" };
}

// Multi-model odpověď (models=…) — suffixované klíče per model, jak je vrací
// Open-Meteo. Slouží panelu "Modely pro tohle místo" i spreadu v meteogramu.
function buildMultiModelFixture(om) {
  const ids = ["icon_d2", "icon_seamless", "ecmwf_ifs025", "gfs_seamless", "meteofrance_seamless", "ukmo_seamless"];
  const hourly = { time: [...om.hourly.time] };
  ids.forEach((id, k) => {
    hourly[`temperature_2m_${id}`] = om.hourly.temperature_2m.map(t => t + (k - 2) * 0.7);
    hourly[`precipitation_${id}`] = om.hourly.precipitation.map(p => p * (1 + k * 0.1));
  });
  return { hourly, timezone: "Europe/Prague" };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

// Čekání na podmínku, která potřebuje dynamický import (a tedy async).
// page.waitForFunction() se na to nedá použít: async callback vrací Promise,
// kterou Playwright vyhodnotí jako truthy hned napoprvé.
async function waitForAsync(page, fn, timeoutMs = 8000, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await page.evaluate(fn)) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return false;
}

// Stránky v testech startují v sekci "Vše": drtivá většina asercí ověřuje
// VYKRESLENÍ panelu, ne to, ve které sekci sedí. Filtrování by je jen slepilo.
// Samotné přepínání sekcí má vlastní blok asercí.
async function startInAllSections(p) {
  await p.addInitScript(() => localStorage.setItem("nowcast_section", "all"));
}

function prepareServeDir() {
  rmrf(SERVE);
  fs.mkdirSync(SERVE, { recursive: true });
  fs.cpSync(WEB, SERVE, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "site-data"), path.join(SERVE, "data"), { recursive: true });

  // t0_utc/generated_at_utc musí být "teď" (v UTC), jinak by hero countdown
  // počítal proti minulosti a radar age-warning by vždy hlásil staré dny.
  const nowIso = new Date().toISOString();
  for (const name of ["radar_manifest.json", "forecast_grid.json"]) {
    const p = path.join(SERVE, "data", name);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.t0_utc = nowIso;
    j.generated_at_utc = nowIso;
    fs.writeFileSync(p, JSON.stringify(j));
  }

  // Stanice potřebují čerstvý time_utc (kontrola biasu ignoruje měření > 90 min)
  for (const name of ["chmi_stations.json", "wu_stations.json", "metar_stations.json",
    "euro_stations.json"]) {
    const p = path.join(SERVE, "data", name);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const s of j.stations || []) s.time_utc = nowIso;
    fs.writeFileSync(p, JSON.stringify(j));
  }

  // accuracy.json: denní rozpad pro kartu "Trefili jsme se?" — datumy
  // posledních 7 dní relativně k dnešku (fixture s pevnými daty by zastarala)
  {
    const p = path.join(SERVE, "data", "accuracy.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.daily = Array.from({ length: 7 }, (_, i) => ({
      date: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10),
      hit_rate_pct: [95, 88, 91, 72, 93, 86, 90][i],
      mae_mm_h: 0.4, n_runs: 100,
    }));
    fs.writeFileSync(p, JSON.stringify(j));
  }

  // aladin.json: běh "teď", jeden bod na testovací lokaci (50.09,14.40),
  // 12 h teploty → panel modelů má ukázat ALADIN vedle Open-Meteo modelů
  {
    const startMs = Math.floor(Date.now() / 3.6e6) * 3.6e6;
    const temp = Array.from({ length: 12 }, (_, i) => 20 + Math.round(Math.sin(i / 3) * 4 * 10) / 10);
    fs.writeFileSync(path.join(SERVE, "data", "aladin.json"), JSON.stringify({
      run_utc: new Date().toISOString(),
      start_utc: new Date(startMs).toISOString(),
      step_hours: 1, n_hours: 12, grid_step_deg: 0.25,
      pts: [[50.09, 14.40]],
      temp: { "0": temp },
      precip: { "0": temp.map(() => 0) },
    }));
  }

  // ── Nová data ČHMÚ ──────────────────────────────────────────────────────
  // Mřížky se párují přes t0_utc a n_pts s forecast_grid.json (3 body), takže
  // fixture musí sedět — jinak se panely SPRÁVNĚ nezobrazí a test by hlásil
  // regresi tam, kde je ve skutečnosti funkční pojistka.
  {
    const gridPath = path.join(SERVE, "data", "forecast_grid.json");
    const grid = JSON.parse(fs.readFileSync(gridPath, "utf8"));
    const nowIso2 = new Date().toISOString();

    // COTREC: bod 0 (testovací lokace) dostane déšť až ve 4. kroku = za 40 min.
    // forecast_grid má pro týž bod act[0] se startem hned → metody se liší,
    // což je zajímavější případ než shoda.
    fs.writeFileSync(path.join(SERVE, "data", "chmi_fct.json"), JSON.stringify({
      generated_at_utc: nowIso2,
      base_utc: new Date(Date.now() - 4 * 60000).toISOString(),
      age_min: 4, source: "ČHMÚ COTREC (composite/fct_maxz)", method: "COTREC",
      step_min: 10, horizon_h: 1, threshold_mm_h: 0.1,
      peak_mm_h: 1.8, total_mm: 0.5,
      timeseries: [],
      grid: {
        t0_utc: grid.t0_utc, n_pts: grid.pts.length, step_min: 10,
        series: { "0": [0, 0, 0, 1.2, 1.8, 0.4] },
      },
    }));

    fs.writeFileSync(path.join(SERVE, "data", "echotop.json"), JSON.stringify({
      generated_at_utc: nowIso2, obs_utc: nowIso2, age_min: 2,
      source: "ČHMÚ ETOP (composite/echotop, hladina 4 dBZ)",
      box_px: 2, box_km: 6.2, grid_t0_utc: grid.t0_utc, n_pts: grid.pts.length,
      max_m: 11800, max_severity: "extrémní", p95_m: 9200, p99_m: 11000,
      coverage_pct: 41.2,
      thresholds_m: { "extrémní": 11000, "silná": 8000, "mírná": 5000, "mělká": 0 },
      tops_m: { "0": 9400 },
    }));

    fs.writeFileSync(path.join(SERVE, "data", "chmi_aero.json"), JSON.stringify({
      generated_at_utc: nowIso2,
      source: "ČHMÚ — radiosondáž (weather/radiosounding)",
      caveat: "Dvě stanice, dva vzestupy denně.",
      units: { cape: "J/kg", cin: "J/kg", t_konv: "°C" },
      labels: { lcl: "výstupná kondenzační hladina", ccl: "konvektivní kondenzační hladina" },
      cape_levels: { "velmi silná": 2500, "silná": 1000, "mírná": 300, "slabá": 0 },
      stations: [{
        name: "Praha-Libuš", lat: 50.008, lon: 14.447,
        file: "26072612_Praha_ascent_vypis_111506.csv",
        sounding_utc: new Date(Date.now() - 6 * 3600000).toISOString(), age_h: 6,
        cape: 1450, cin: -120, dci: 21.5, t_konv: 34,
        lcl: { t_c: 2.5, hpa: 700 }, ccl: { t_c: 1.6, hpa: 656 }, cape_label: "silná",
      }],
    }));

    fs.writeFileSync(path.join(SERVE, "data", "chmi_air.json"), JSON.stringify({
      generated_at_utc: nowIso2, observed_utc: nowIso2, age_min: 52,
      source: "ČHMÚ — státní síť imisního monitoringu (air_quality/now)",
      count: 1, components: ["NO2", "O3", "PM10", "PM2_5"],
      stations: [{
        code: "APRG", name: "Praha 4-Libuš", lat: 50.007, lon: 14.446,
        elev: 302, region: "Praha", time_utc: nowIso2, index: 1.2,
        v: {
          PM2_5: { val: 8.4, unit: "µg∙m⁻³" }, PM10: { val: 14.1, unit: "µg∙m⁻³" },
          NO2: { val: 11.7, unit: "µg∙m⁻³" }, O3: { val: 62.3, unit: "µg∙m⁻³" },
        },
      }],
    }));

    fs.writeFileSync(path.join(SERVE, "data", "chmi_normals.json"), JSON.stringify({
      period: "1991_2020", generated_at_utc: nowIso2, count: 1,
      elements: ["SRA", "T", "TMA", "TMI"],
      stations: {
        "0-20000-0-11518": {
          name: "Praha-Ruzyně", lat: 50.10, lon: 14.26, elev: 380,
          normals: {
            T: [-0.5, 0.6, 4.2, 9.4, 13.9, 17.4, 19.2, 18.8, 14.2, 9.2, 4.4, 0.7],
            TMA: [2.1, 4.0, 9.0, 15.1, 19.6, 23.1, 25.2, 24.9, 19.6, 13.5, 7.2, 3.0],
            TMI: [-3.1, -2.5, 0.2, 3.9, 8.3, 11.8, 13.5, 13.2, 9.4, 5.6, 1.6, -1.9],
            SRA: [26, 23, 30, 33, 61, 66, 74, 68, 44, 36, 32, 29],
          },
        },
      },
    }));

    // Krajské průměry: jen sloupec CR se v UI používá, ale fixture drží
    // všech 14 krajů, ať se otestuje i hledání indexu podle kódu.
    const REG = ["CR", "JHC", "JHM", "KVK", "HKK", "LBK", "MSK", "OLK", "PAK",
      "PLK", "PHA+STC", "ULK", "VYS", "ZLK"];
    const pad = (v) => REG.map((_, i) => (i === 0 ? v : v + i * 0.1));
    const nowY = String(new Date().getFullYear());
    const nowM = String(new Date().getMonth() + 1).padStart(2, "0");
    fs.writeFileSync(path.join(SERVE, "data", "chmi_regional.json"), JSON.stringify({
      generated_at_utc: nowIso2,
      source: "ČHMÚ — areálové průměry po krajích (products/regional_averages)",
      normal_period: "1991-2020",
      regions: REG.map(c => ({ code: c, name: c })),
      temp_annual: [
        { year: "2024", element: "T", v: pad(9.6) },
        { year: "2025", element: "T", v: pad(8.8) },
      ],
      temp_current: [{ year: nowY, month: nowM, element: "T", v: pad(19.1) }],
      temp_normal: [
        { month: nowM, element: "T", v: pad(18.0) },
        { month: "Year", element: "T", v: pad(8.3) },
      ],
      prec_current: [{ year: nowY, month: nowM, element: "SRA", v: pad(40) }],
      prec_normal: [{ month: nowM, element: "SRA", v: pad(80) }],
    }));

    fs.writeFileSync(path.join(SERVE, "data", "chmi_forecast.json"), JSON.stringify({
      generated_at_utc: nowIso2,
      source: "ČHMÚ — textová předpověď (weather/forecast/now)",
      file: "web_pCRntx_262100.json", age_h: 1.2,
      issued_utc: new Date(Date.now() - 72 * 60000).toISOString(),
      author: "Filip Smola", place: "pro Českou republiku", nuts: "CZ",
      headline: "Předpověď na noc",
      blocks: [
        { name: "textIntro", headline: null, text: "Teplá noc s převážně velkou oblačností." },
        { name: "textWeather", headline: "Počasí (22-07):", text: "Převládne velká oblačnost, místy přeháňky." },
      ],
    }));
  }
}

function startServer() {
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const full = path.join(SERVE, p);
    if (!full.startsWith(SERVE)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found: " + p); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  prepareServeDir();
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  // serviceWorkers: "block" — sw.js by jinak fetch handlerem (network-first
  // pro same-origin) obsluhoval requesty MIMO stránku (samostatný CDP target),
  // takže page.route() by je vůbec neviděl. Objevilo se to teprve u
  // same-origin fixture routy (vendor/leaflet-velocity.min.js) — dřívější
  // fixtures byly všechny cross-origin, kde SW záměrně nezasahuje.
  const context = await browser.newContext({ serviceWorkers: "block" });
  // Pokročilé panely (modely/ovzduší/obloha/…) jsou defaultně ve sbalené sekci
  // "Podrobnější data" (display:none) → rozbal je, ať jsou viditelné pro
  // waitForSelector(...show) v testech i pro vizuální kontrolu.
  await context.addInitScript(() => localStorage.setItem("nowcast_more_open", "1"));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await context.newPage();
  await startInAllSections(page);

  const consoleErrors = [];
  page.on("console", msg => {
    if (process.env.DEBUG) console.log(`[console:${msg.type()}]`, msg.text());
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", err => {
    if (process.env.DEBUG) console.log("[pageerror]", err.message, err.stack);
    consoleErrors.push("pageerror: " + err.message);
  });
  page.on("requestfailed", req => {
    if (process.env.DEBUG) console.log("[requestfailed]", req.url(), req.failure()?.errorText);
  });
  page.on("response", async res => {
    if (process.env.DEBUG) console.log("[response]", res.status(), res.headers()["content-type"], res.url());
  });

  // ── Route interception: CDN vendor libs → lokální stuby ────────────────────
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route =>
    route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route =>
    route.fulfill({ body: "", contentType: "text/css" }));
  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route =>
    route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));

  // ── Route interception: externí API → fixture data ─────────────────────────
  const omFixture = buildOpenMeteoFixture();
  const mmFixture = buildMultiModelFixture(omFixture);
  await page.route("https://api.open-meteo.com/v1/forecast**", route =>
    route.fulfill({ body: JSON.stringify(route.request().url().includes("models=") ? mmFixture : omFixture), contentType: "application/json" }));
  await page.route("https://air-quality-api.open-meteo.com/**", route =>
    route.fulfill({ body: JSON.stringify({
      current: { pm10: 12.3, pm2_5: 8.1, ozone: 55, nitrogen_dioxide: 10, european_aqi: 22 },
      hourly: { time: [omFixture.hourly.time[0]], birch_pollen: [3], grass_pollen: [15], alder_pollen: [0], ragweed_pollen: [0] },
    }), contentType: "application/json" }));
  await page.route("https://geocoding-api.open-meteo.com/**", route =>
    route.fulfill({ body: JSON.stringify({ results: [
      { name: "Brno", admin1: "Jihomoravský kraj", latitude: 49.1951, longitude: 16.6068 },
      { name: "Brno-Bystrc", admin1: "Jihomoravský kraj", latitude: 49.22, longitude: 16.53 },
    ] }), contentType: "application/json" }));
  await page.route("https://api.rainviewer.com/**", route =>
    route.fulfill({ body: JSON.stringify({
      host: "https://tilecache.rainviewer.com",
      radar: { past: [{ time: 1, path: "/v2/radar/1" }], nowcast: [] },
      satellite: { infrared: [{ time: 1, path: "/v2/satellite/1" }] },
    }), contentType: "application/json" }));
  // klimatologie 1991–2020 (normál + rekordy) — malá syntetická řada, ať
  // renderClimateAnomaly/renderDayInHistory nejdou do reálné sítě
  await page.route("https://archive-api.open-meteo.com/**", route =>
    route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await page.route("https://ensemble-api.open-meteo.com/**", route =>
    route.fulfill({ body: "{}", contentType: "application/json" }));
  // leaflet-velocity je self-hosted (web/vendor/) — reálná knihovna potřebuje
  // plný Leaflet, který stub neposkytuje; pro test stačí minimální náhrada.
  await page.route("**/vendor/leaflet-velocity.min.js", route =>
    route.fulfill({ path: path.join(FIXTURES, "velocity-stub.js"), contentType: "text/javascript" }));
  await page.route("https://*.workers.dev/vapid-public-key**", route =>
    route.fulfill({ body: JSON.stringify({ publicKey: "BM60k6heLK2a7KNELX05p5_Wpv1zhUbB2JFLMLVz13uirAVfjkCtoksQ7bdQIMd5hqvwUTwPUWUGfhFm0KkhF3Y" }), contentType: "application/json" }));
  // Sdílené učení: server vrací skóre za okolí a přijímá pozorování.
  // Bez stubu by fetch propadl na síť a shodil kontrolu "žádné chyby v konzoli".
  let obsPosted = 0;
  await page.route("https://*.workers.dev/model-obs**", route => {
    obsPosted++;
    route.fulfill({ body: JSON.stringify({ ok: true, taken: 1 }), contentType: "application/json" });
  });
  await page.route("https://*.workers.dev/model-scores**", route =>
    route.fulfill({ body: JSON.stringify({
      cell: 0.25, updatedAt: new Date().toISOString(),
      models: { icon_d2: { n: 30, mae: 1.1, bias: 0.4 } },
    }), contentType: "application/json" }));
  await page.route("https://*.workers.dev/push-status**", route =>
    route.fulfill({ body: JSON.stringify({ registered: true, favorites: 1 }), contentType: "application/json" }));
  let testPushBody = null;
  await page.route("https://*.workers.dev/test-push**", async route => {
    testPushBody = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ body: JSON.stringify({ ok: true, dueAt: new Date(Date.now() + 60000).toISOString(), delaySec: 60 }), contentType: "application/json" });
  });

  await page.route("https://*.workers.dev/verdict**", route =>
    route.fulfill({ body: JSON.stringify({ text: "Testovací AI verdikt: dnes odpoledne přeháňky, jinak teplo." }), contentType: "application/json" }));

  // data/wind_grid.json a data/hydro.json: PRVNÍ request v testu níže je
  // úmyslně zpožděn, aby odpovědi dorazily v OPAČNÉM pořadí, než v jakém
  // byly vyslány — to je přesně scénář, kdy race condition v
  // toggleWindLayer/toggleHydro reálně škodí (pozdě dorazivší stará
  // odpověď přepíše stav nastavený mezitím dokončenou novější odpovědí).
  // Bez zpoždění by na rychlém lokálním serveru odpovědi typicky dorazily
  // ve stejném pořadí, v jakém byly vyslány, a test by nic neodhalil.
  let windReqN = 0;
  await page.route("**/data/wind_grid.json**", async route => {
    windReqN++;
    if (windReqN === 1) await new Promise(r => setTimeout(r, 350));
    route.continue();
  });
  let hydroReqN = 0;
  await page.route("**/data/hydro.json**", async route => {
    hydroReqN++;
    if (hydroReqN === 1) await new Promise(r => setTimeout(r, 350));
    route.continue();
  });

  await page.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });

  // ── Základní načtení ─────────────────────────────────────────────────────
  await page.waitForFunction(() => document.getElementById("place")?.textContent?.includes("TestObec"), { timeout: 8000 });
  assertTrue(true, "stránka se načetla a zvolila místo z URL parametrů");

  // ── Hero countdown ("Déšť za X min") ─────────────────────────────────────
  await page.waitForSelector("#rain-countdown.show", { timeout: 5000 });
  const rcClasses = await page.getAttribute("#rain-countdown", "class");
  const rcTitle = await page.textContent("#rc-title");
  assertTrue(rcClasses.includes("imminent"), `hero countdown je v imminent stavu (class="${rcClasses}")`);
  assertTrue(/Déšť za/.test(rcTitle), `hero countdown ukazuje odpočet ("${rcTitle}")`);

  // ── Výstražné chipy (z GRID.warnings + wmatch) ───────────────────────────
  await page.waitForSelector(".warn-chip", { timeout: 5000 });
  // Ne první v pořadí — pruh řadí od nejzávažnější, takže bouřky mezi jinými
  // oranžovými výstrahami klidně skončí až za nimi. Stačí, že tam jsou.
  const chipTexts = await page.evaluate(() =>
    [...document.querySelectorAll("#alert-bar .warn-chip")].map(c => c.textContent.trim()));
  assertTrue(chipTexts.some(t => t.includes("Bouřky")),
    `výstražný chip "Bouřky" se zobrazil (${chipTexts.join(" | ")})`);
  // Fixture má tutéž výstrahu 2× (ČHMÚ ji publikuje per oblast) — UI ji smí
  // ukázat jen jednou (regrese "Riziko požárů" 3× vedle sebe). Pozor na rozdíl
  // proti seskupování: TOHLE jsou dvě identické výstrahy, ne tentýž jev na dva
  // dny, takže se nesmí objevit ani jako "2×".
  const bourky = await page.evaluate(() =>
    [...document.querySelectorAll("#alert-bar .warn-chip")]
      .map(c => c.textContent.trim()).filter(t => t.startsWith("Bouřky")));
  assertTrue(bourky.length === 1 && bourky[0] === "Bouřky",
    `duplicitní výstraha se zobrazí jen jednou a bez počtu (${bourky.join(" | ") || "žádná"})`);

  // ── AI verdikt (progressive enhancement přes worker) ─────────────────────
  await page.waitForSelector(".verdict-ai-badge", { timeout: 8000 }).catch(() => {});
  const verdictHtml = await page.innerHTML("#verdict");
  assertTrue(verdictHtml.includes("Testovací AI verdikt"), "AI verdikt z workeru nahradil šablonu");

  // ── Přesnost nowcastu ─────────────────────────────────────────────────────
  await page.waitForSelector("#accuracy-line.show", { timeout: 5000 });
  const accText = await page.textContent("#accuracy-line");
  assertTrue(/\+10′ 91\s?%/.test(accText), `accuracy.json se zobrazil per lead-time (obsah: "${accText.trim()}")`);

  // ── 24h strip + meteogram + AQ + 7denní výhled ───────────────────────────
  await page.waitForSelector("#fc24-scroll .fc24-col", { timeout: 8000 });
  const fc24cols = await page.locator(".fc24-col").count();
  assertTrue(fc24cols > 0, `fc24 strip vykreslil ${fc24cols} sloupců`);

  // Chytilo reálný bug: obsah sloupce (vítr+UV+CAPE na jednom řádku)
  // přetékal mimo úzký sloupec a překrýval sousední hodiny.
  const fc24Overflow = await page.evaluate(() =>
    [...document.querySelectorAll(".fc24-col")].some(col => col.scrollWidth > col.clientWidth + 1)
  );
  assertTrue(!fc24Overflow, "obsah fc24 sloupců nepřetéká mimo sloupec");

  await page.waitForSelector("#meteo-block.show canvas#meteo-canvas", { timeout: 5000 });
  assertTrue(true, "meteogram se vykreslil (canvas existuje)");

  await page.waitForSelector(".fc7-day", { timeout: 5000 });
  const fc7days = await page.locator(".fc7-day").count();
  assertTrue(fc7days === 7, `7denní výhled má 7 dní (má ${fc7days})`);

  await page.waitForSelector("#aq-panel.show", { timeout: 5000 });
  const aqText = await page.textContent("#aq-panel");
  assertTrue(aqText.includes("PM2.5"), "panel kvality ovzduší se vykreslil");

  // ── Navigace sekcí — Teď / Dnes / Týden / Data / Vše ─────────────────────
  // Sbalitelnou sekci "Podrobnější data" nahradily sekce: dvě vrstvy skládání
  // by znamenaly klik navíc k témuž. Test hlídá to podstatné — že přepnutí
  // opravdu skryje cizí panely a že se volba pamatuje.
  {
    const secs = await page.evaluate(() =>
      [...document.querySelectorAll("#secnav button")].map(b => b.dataset.sec));
    assertTrue(secs.join(",") === "now,today,week,data,all",
      `navigace nabízí všech pět sekcí (${secs.join(",")})`);

    await page.click('#secnav button[data-sec="week"]');
    await page.waitForTimeout(200);
    const inWeek = await page.evaluate(() => ({
      body: document.body.dataset.sec,
      fc7: getComputedStyle(document.getElementById("fc7")).display !== "none",
      fc24: getComputedStyle(document.getElementById("fc24")).display !== "none",
      aq: getComputedStyle(document.getElementById("aq-panel")).display !== "none",
      stored: localStorage.getItem("nowcast_section"),
      pressed: document.querySelector('#secnav button[data-sec="week"]')
        .getAttribute("aria-pressed"),
    }));
    assertTrue(inWeek.body === "week" && inWeek.fc7,
      `sekce Týden ukazuje 7denní výhled (${inWeek.body})`);
    assertTrue(!inWeek.fc24 && !inWeek.aq,
      `sekce Týden skryla panely z Dnes (fc24=${inWeek.fc24}, ovzduší=${inWeek.aq})`);
    assertTrue(inWeek.stored === "week", `volba sekce se pamatuje (${inWeek.stored})`);
    assertTrue(inWeek.pressed === "true", "aktivní tlačítko hlásí aria-pressed");

    // Navigace sama nese data-sec na tlačítkách — nesmí se odfiltrovat.
    const navVisible = await page.evaluate(() =>
      [...document.querySelectorAll("#secnav button")]
        .every(b => getComputedStyle(b).display !== "none"));
    assertTrue(navVisible, "tlačítka navigace zůstala viditelná i po přepnutí");

    await page.click('#secnav button[data-sec="all"]');
    await page.waitForTimeout(200);
    const inAll = await page.evaluate(() => ({
      fc7: getComputedStyle(document.getElementById("fc7")).display !== "none",
      fc24: getComputedStyle(document.getElementById("fc24")).display !== "none",
      aq: getComputedStyle(document.getElementById("aq-panel")).display !== "none",
    }));
    assertTrue(inAll.fc7 && inAll.fc24 && inAll.aq,
      "sekce Vše nefiltruje nic (na širokém monitoru se svitek uživí)");
  }

  // ── Vlna PRO: bouřkové buňky, verifikace, bias stanice, průběh dne ────────
  const stormInfo = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const subs = state.stormLayer?._sub || [];
    return { hasLayer: !!state.stormLayer, n: subs.length,
      popup: subs.map(s => s._popupHtml || "").join(" ") };
  });
  // 2 buňky: 2 markery + 2 dráhy + časové značky (+20/+40/+60 = 3 per buňka)
  assertTrue(stormInfo.hasLayer && stormInfo.n >= 8,
    `dráhy bouřkových buněk na mapě (${stormInfo.n} prvků vrstvy)`);
  assertTrue(stormInfo.popup.includes("krupobití"),
    "buňka ≥ 55 dBZ nese varování před krupobitím");

  await page.waitForSelector("#verif-panel.show", { timeout: 5000 });
  const verifText = await page.textContent("#verif-panel");
  assertTrue(verifText.includes("Trefili jsme se?") && (await page.locator("#verif-panel .vf-col").count()) === 7,
    "karta 'Trefili jsme se?' ukazuje 7 dní verifikace");

  await page.waitForSelector("#station-check.show", { timeout: 5000 });
  const stText = await page.textContent("#station-check");
  assertTrue(/Stanice .+ hlásí .+ °C/.test(stText), `kontrola proti stanici funguje ("${stText.slice(0, 60)}…")`);

  await page.waitForSelector("#daytl-panel.show", { timeout: 5000 });
  const dtlSegs = await page.locator("#daytl-panel .dtl-seg").count();
  assertTrue(dtlSegs >= 2 && dtlSegs <= 5, `průběh dne má ${dtlSegs} fází`);

  // ── Vlna SAFETY: zásah bouřkou, okna beze srážek, shoda modelů ────────────
  // Fixture buňka (49.95,14.2, hail) má dráhu vedoucí přes ~50.07,14.40, tedy
  // ~2 km od testovací lokace 50.09,14.40 → zásah cca za 40 min.
  await page.waitForSelector("#storm-impact.show", { timeout: 5000 });
  const siText = await page.textContent("#storm-impact");
  assertTrue(/za ~\d+ min|právě nad tebou/.test(siText) && /kroup|bouřka/i.test(siText),
    `banner zásahu bouřkou funguje ("${siText.replace(/\s+/g, " ").slice(0, 70)}…")`);

  // ── Srážky: jeden panel, dvě měřítka ──────────────────────────────────────
  // Regrese, kterou to hlídá: dřív to byly DVĚ karty nad sebou (0–120 min
  // a 0–12 h), tedy dvě časové osy téhož nad hero countdownem.
  await page.waitForSelector("#precip-panel.show", { timeout: 5000 });
  const owBars = await page.locator("#precip-panel .ow-bars i").count();
  const owWet = await page.locator("#precip-panel .ow-bars i.wet").count();
  assertTrue(owBars >= 6 && owWet >= 1,
    `12h pás má mokré i suché sloty (${owBars} slotů, ${owWet} mokrých)`);
  const owMsg = await page.textContent("#outlook-msg");
  assertTrue(/prší|sucho|déšť|srážek/i.test(owMsg || ""),
    `věta 'kdy vyrazit' zůstala ("${(owMsg || "").slice(0, 60)}")`);
  assertTrue(await page.locator("#outlook-panel").count() === 0,
    "samostatná karta 'Kdy vyrazit' už neexistuje");

  const scale = await page.evaluate(() => {
    const panel = document.getElementById("precip-panel");
    const track = document.getElementById("pp-track");
    const before = panel.dataset.active;
    panel.querySelector('.pp-tab[data-scale="12h"]').click();
    const after12 = panel.dataset.active;
    panel.querySelector('.pp-tab[data-scale="2h"]').click();
    const after2 = panel.dataset.active;
    return {
      before, after12, after2,
      tabs: [...panel.querySelectorAll(".pp-tab")].map(t => t.dataset.scale),
      activeCount: panel.querySelectorAll(".pp-tab.active").length,
      minutelyBars: panel.querySelectorAll("#minutely-bars i").length,
      // dráha musí být opravdu přejížděcí, ne dvě skryté vrstvy
      snap: getComputedStyle(track).scrollSnapType,
      bodies: [...track.querySelectorAll(".pp-body:not([hidden])")].length,
      aria: panel.querySelector('.pp-tab[data-scale="2h"]').getAttribute("aria-selected"),
    };
  });
  assertTrue(scale.tabs.join(",") === "2h,12h",
    `panel má obě měřítka (${scale.tabs.join(",")})`);
  assertTrue(scale.before === "2h" && scale.after12 === "12h" && scale.after2 === "2h",
    `přepínač mění aktivní měřítko (${JSON.stringify([scale.before, scale.after12, scale.after2])})`);
  assertTrue(scale.activeCount === 1,
    `aktivní je právě jedna záložka (${scale.activeCount})`);
  assertTrue(scale.minutelyBars >= 6,
    `2h graf má sloupce (${scale.minutelyBars})`);
  assertTrue(/x/.test(scale.snap || ""),
    `dráha má vodorovný snap, takže jde přejet prstem ("${scale.snap}")`);
  assertTrue(scale.bodies === 2,
    `obě měřítka jsou v dráze, ne skrytá pod sebou (${scale.bodies})`);
  assertTrue(scale.aria === "true",
    `aktivní záložka se hlásí čtečkám (aria-selected=${scale.aria})`);

  // Přejetí prstem: posun dráhy musí indikátor dotáhnout sám.
  const swiped = await page.evaluate(async () => {
    const panel = document.getElementById("precip-panel");
    const track = document.getElementById("pp-track");
    const target = track.querySelector('.pp-body[data-scale="12h"]');
    track.scrollLeft = target.offsetLeft;
    track.dispatchEvent(new Event("scroll"));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return panel.dataset.active;
  });
  assertTrue(swiped === "12h",
    `přejetí na 12h dráhu přepne indikátor samo (${swiped})`);

  // Klávesnice — gesto nesmí být jediná cesta.
  const byKey = await page.evaluate(() => {
    const panel = document.getElementById("precip-panel");
    // Událost musí vzniknout na ZAOSTŘENÉM tlačítku, ne na panelu — jinak
    // e.target není uvnitř .pp-tabs a handler ji správně ignoruje.
    const tab = panel.querySelector('.pp-tab[data-scale="12h"]');
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    return panel.dataset.active;
  });
  assertTrue(byKey === "2h", `šipka přepne měřítko i bez gesta (${byKey})`);

  await page.waitForSelector("#confidence-chip.show", { timeout: 5000 });
  const cfText = await page.textContent("#confidence-chip");
  assertTrue(/Jistota výhledu/.test(cfText), `chip jistoty výhledu z modelů ("${cfText.slice(0, 50)}…")`);

  // ── WU vlastní stanice ────────────────────────────────────────────────────
  const wuRows = await page.locator(".wu-mini-row").count();
  assertTrue(wuRows === 1, `WU vlastní stanice panel má 1 řádek (má ${wuRows})`);

  // ── Radar ovládání ────────────────────────────────────────────────────────
  await page.click("#btn-play");
  await page.waitForSelector("#btn-play.active", { timeout: 3000 });
  assertTrue(true, "play tlačítko se aktivovalo");
  await page.click("#btn-play");
  await page.waitForFunction(() => !document.getElementById("btn-play").classList.contains("active"), { timeout: 3000 });
  assertTrue(true, "pauza tlačítko funguje");

  const frameBefore = await page.textContent("#frame-time");
  await page.click("#btn-prev");
  await page.waitForTimeout(150);
  const frameAfter = await page.textContent("#frame-time");
  assertTrue(typeof frameAfter === "string", `radar frame krokování neshodilo appku (před="${frameBefore.trim()}" po="${frameAfter.trim()}")`);

  // ── Legenda radaru ────────────────────────────────────────────────────────
  await page.waitForSelector("#radar-legend.show", { timeout: 3000 });
  assertTrue(true, "legenda radaru se zobrazila");

  // ── Žádné neúmyslné překryvy fixed panelů (chytilo reálný bug: legenda
  //    se dřív kreslila přes spodní karty v #left-card) ─────────────────────
  const overlapPairs = [
    ["#radar-legend", "#left-card"],
    ["#layer-selector", "#left-card"],
    ["#radar-legend", "#layer-selector"],
    ["#storm-bar", "#right-panel"],
  ];
  for (const [selA, selB] of overlapPairs) {
    const overlap = await page.evaluate(([a, b]) => {
      const elA = document.querySelector(a), elB = document.querySelector(b);
      if (!elA || !elB) return null;
      const ra = elA.getBoundingClientRect(), rb = elB.getBoundingClientRect();
      if (ra.width === 0 || ra.height === 0 || rb.width === 0 || rb.height === 0) return false;
      return !(ra.right <= rb.left || ra.left >= rb.right || ra.bottom <= rb.top || ra.top >= rb.bottom);
    }, [selA, selB]);
    assertTrue(overlap !== true, `${selA} se nepřekrývá s ${selB}`);
  }

  // ── Vrstvový selektor ČHMÚ ────────────────────────────────────────────────
  await page.click('.layer-btn[data-layer="wind_kmh"]');
  const activeLayer = await page.getAttribute('.layer-btn[data-layer="wind_kmh"]', "class");
  assertTrue(activeLayer.includes("active"), "přepnutí vrstvy ČHMÚ markerů funguje");

  // ── Globální radar (RainViewer): rychlé zap→vyp nesmí "vzkřísit" vrstvu ──
  // po dokončení pozdě doražené odpovědi (stejná třída bugů jako u wind/hydro).
  await page.click("#btn-global");
  await page.click("#btn-global");
  await page.waitForTimeout(400);
  const globalStillOff = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return { mode: state.globalMode, hasLayer: !!(state.map._layers || []).includes(state.rvLayer) };
  });
  assertTrue(!globalStillOff.mode && !globalStillOff.hasLayer,
    `rychlé zap/vyp globálního radaru zůstalo vypnuté (mode=${globalStillOff.mode}, vrstva=${globalStillOff.hasLayer})`);

  // ── Mapové vrstvy: satelit / vítr / hydrologie ────────────────────────────
  await page.click("#btn-satellite");
  await page.waitForTimeout(300);
  assertTrue((await page.getAttribute("#btn-satellite", "class") || "").includes("active"),
    "satelitní vrstva se zapnula");
  await page.click("#btn-satellite");
  await page.waitForTimeout(100);
  assertTrue(!(await page.getAttribute("#btn-satellite", "class") || "").includes("active"),
    "satelitní vrstva se vypnula");

  // Rychlé zap→vyp BEZ čekání, s uměle zpožděnou první odpovědí (viz route
  // výše): fetch z "zap" dorazí AŽ PO "vyp". Bez token guardu v
  // toggleWindLayer/toggleHydro by tahle pozdě dorazivší odpověď vrstvu na
  // mapě "vzkřísila" i po vypnutí — stejná třída bugu jako u
  // loadRainViewerFrames/toggleGlobalMode, tady ověřená s deterministickým
  // zpožděním místo spoléhání na to, že klik č. 2 stihne doběhnout dřív
  // než fetch (což na rychlém lokálním serveru není zaručeno).
  await page.click("#btn-wind"); // zap — vyšle zpožděný fetch
  await page.click("#btn-wind"); // vyp — hned poté, fetch ještě neskončil
  await page.waitForTimeout(600); // > 350ms zpoždění první odpovědi
  const windCheck = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return {
      mode: state.windMode,
      hasLayer: !!state.windLayer,
      onMap: !!(state.windLayer && state.map._layers?.includes(state.windLayer)),
    };
  });
  assertTrue(!windCheck.mode && !windCheck.hasLayer && !windCheck.onMap,
    `rychlé zap→vyp větru (se zpožděnou odpovědí) nevzkřísilo vrstvu po vypnutí (mode=${windCheck.mode}, hasLayer=${windCheck.hasLayer}, onMap=${windCheck.onMap})`);

  // Vítr podruhé — teď už bez zpoždění, ať se vrstva opravdu postaví a tooltip
  // řekne, jak čerstvá data jsou (windgrid.py smí pole doplnit z minulého běhu).
  await page.click("#btn-wind");
  await page.waitForTimeout(400);
  const windOn = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return { mode: state.windMode, hasLayer: !!state.windLayer,
             title: document.getElementById("btn-wind")?.title || "" };
  });
  assertTrue(windOn.mode && windOn.hasLayer,
    `vrstva větru se z wind_grid.json postaví (mode=${windOn.mode}, hasLayer=${windOn.hasLayer})`);
  assertTrue(/Vítr 10 m/.test(windOn.title) && /78 % bodů měřeno/.test(windOn.title),
    `tlačítko větru hlásí stáří i podíl měřených bodů ("${windOn.title}")`);
  await page.click("#btn-wind"); // ukliď po sobě

  const windLabels = await page.evaluate(async () => {
    const { windFreshnessLabel } = await import("./js/radar.js");
    const t = (min, f, tot) => windFreshnessLabel({
      refTime: new Date(Date.now() - min * 60000).toISOString(),
      freshPoints: f, totalPoints: tot,
    });
    return [t(20, 238, 238), t(300, 100, 238), windFreshnessLabel(null),
            windFreshnessLabel({ refTime: "nesmysl", freshPoints: 238, totalPoints: 238 })];
  });
  assertTrue(windLabels[0] === "Vítr 10 m · data 20 min stará",
    `plné čerstvé pole nehlásí žádné dopočítávání ("${windLabels[0]}")`);
  assertTrue(/5 h stará/.test(windLabels[1]) && /42 % bodů měřeno/.test(windLabels[1]),
    `staré a děravé pole se přizná ("${windLabels[1]}")`);
  assertTrue(windLabels[2] === "Vítr 10 m" && windLabels[3] === "Vítr 10 m",
    `chybějící/rozbitá hlavička nevyrobí "NaN min stará" (${windLabels[2]} | ${windLabels[3]})`);

  const windCaveats = await page.evaluate(async () => {
    const { windCaveat } = await import("./js/radar.js");
    const c = (min, f, t) => windCaveat({
      refTime: new Date(Date.now() - min * 60000).toISOString(),
      freshPoints: f, totalPoints: t,
    });
    // 200/238 = 84 % je nad prahem 80 % → záměrně žádný toast
    return [c(20, 238, 238), c(20, 180, 238), c(400, 238, 238), windCaveat(null),
            c(20, 200, 238)];
  });
  assertTrue(windCaveats[0] === null && windCaveats[3] === null,
    `bezvadná (i chybějící) data toast nevyvolají (${windCaveats[0]} | ${windCaveats[3]})`);
  assertTrue(/76 % mřížky/.test(windCaveats[1] || ""),
    `děravé pole vyvolá toast o dopočtu ("${windCaveats[1]}")`);
  assertTrue(windCaveats[4] === null,
    `drobný dopočet (84 %) uživatele zbytečně neotravuje (${windCaveats[4]})`);
  assertTrue(/7 h stará/.test(windCaveats[2] || ""),
    `stará data vyvolají toast o stáří ("${windCaveats[2]}")`);

  await page.click("#btn-hydro"); // zap — vyšle zpožděný fetch
  await page.click("#btn-hydro"); // vyp — hned poté, fetch ještě neskončil
  await page.waitForTimeout(600); // > 350ms zpoždění první odpovědi
  const hydroCheck = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return {
      mode: state.hydroMode,
      hasLayer: !!state.hydroLayer,
      onMap: !!(state.hydroLayer && state.map._layers?.includes(state.hydroLayer)),
    };
  });
  assertTrue(!hydroCheck.mode && !hydroCheck.hasLayer && !hydroCheck.onMap,
    `rychlé zap→vyp hydrologie (se zpožděnou odpovědí) nevzkřísilo vrstvu po vypnutí (mode=${hydroCheck.mode}, hasLayer=${hydroCheck.hasLayer}, onMap=${hydroCheck.onMap})`);

  // ── Úhrnová mapa (24h srážky z NWP podmřížky) ─────────────────────────────
  await page.click("#btn-accum");
  await page.waitForTimeout(200);
  const accum = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const sub = state.accumLayer?._sub || [];
    return { mode: state.accumMode, n: sub.length,
      legend: document.getElementById("accum-legend")?.classList.contains("show") };
  });
  // 2 body fixtury mají accum24 ≥ 1 (8.5 a 22.0), třetí je 0 → 2 polygony
  assertTrue(accum.mode && accum.n === 2 && accum.legend,
    `úhrnová mapa vykreslila mokré buňky (mode=${accum.mode}, buněk=${accum.n}, legenda=${accum.legend})`);
  await page.click("#btn-accum");
  await page.waitForTimeout(100);
  const accumOff = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return { mode: state.accumMode, hasLayer: !!state.accumLayer };
  });
  assertTrue(!accumOff.mode && !accumOff.hasLayer, "úhrnová mapa se vypnula");

  // ── Vyhledávání s klávesovou navigací ─────────────────────────────────────
  await page.fill("#search", "Brno");
  await page.waitForSelector("#suggestions li", { timeout: 3000 });
  await page.keyboard.press("ArrowDown");
  const selected = await page.getAttribute("#suggestions li:nth-child(1)", "aria-selected");
  assertTrue(selected === "true", "klávesová navigace v našeptávači zvýrazní první položku");

  // ── Motiv ─────────────────────────────────────────────────────────────────
  const themeBefore = await page.getAttribute("html", "data-theme");
  await page.click("#btn-theme");
  await page.waitForTimeout(100);
  const themeAfter = await page.getAttribute("html", "data-theme");
  assertTrue(themeBefore !== themeAfter, `přepnutí motivu funguje (${themeBefore} → ${themeAfter})`);

  // ── Sdílení ───────────────────────────────────────────────────────────────
  await page.click("#btn-share");
  await page.waitForTimeout(300);
  assertTrue(true, "kliknutí na sdílet neshodilo appku");

  // ── Push tlačítko (jen kontrola dostupnosti, ne reálný subscribe) ─────────
  await page.waitForTimeout(500);
  const pushBtnClass = await page.getAttribute("#btn-push", "class").catch(() => "");
  assertTrue((pushBtnClass || "").includes("available"), "push tlačítko rozpoznalo podporu prohlížeče");

  // ── Embed mód ─────────────────────────────────────────────────────────────
  await page.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec&embed=1`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const bodyClass = await page.getAttribute("body", "class");
  assertTrue((bodyClass || "").includes("embed"), "embed mód nastaví body.embed");

  // ── Žádné neočekávané JS chyby po celou dobu ─────────────────────────────
  // blitzortung: živé blesky přes WebSocket — externí služba, v sandboxu
  // (i leckde v produkci) nedostupná; appka na tom nezávisí a tiše degraduje
  const realErrors = consoleErrors.filter(e => !/favicon|blitzortung/i.test(e));
  assertTrue(realErrors.length === 0, `žádné console/page chyby (nalezeno ${realErrors.length})`);
  if (realErrors.length) realErrors.forEach(e => console.error("  · " + e));

  // ── ČHMÚ detail panel (série + rekordy/klimatologie/roční trend) ─────────
  // Marker popupy jsou v Leaflet stubu nefunkční (nekreslí se do DOM), takže
  // otevřeme detail přímo přes modul — appka ho stejně jen volá z popup tlačítka.
  await page.evaluate(async () => {
    const mod = await import("./js/stations.js");
    await mod.openChmiDetail("0-20000-0-11518");
  });
  await page.waitForSelector("#chmi-detail.open .sd-hero", { timeout: 5000 });
  assertTrue(true, "ČHMÚ detail panel se otevřel a načetl 24h sérii");
  await page.click('.chmi-tab-btn[data-tab="rekordy"]');
  await page.waitForFunction(() => document.getElementById("chmi-tab-content")?.textContent?.includes("38.5"), { timeout: 3000 });
  assertTrue(true, "záložka Rekordy vykreslila chmi_stats.json data");
  await page.click("#chmi-detail-close");

  // ── Auto-obnova posledního místa (bez URL parametrů) ─────────────────────
  const page2 = await context.newPage();
  await startInAllSections(page2);
  await page2.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await page2.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await page2.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await page2.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
  await page2.route("https://api.open-meteo.com/v1/forecast**", route =>
    route.fulfill({ body: JSON.stringify(omFixture), contentType: "application/json" }));
  await page2.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await page2.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await page2.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  const errors2 = [];
  page2.on("pageerror", e => { errors2.push(e.message); if (process.env.DEBUG) console.log("[page2:pageerror]", e.message); });
  page2.on("console", msg => { if (process.env.DEBUG) console.log(`[page2:console:${msg.type()}]`, msg.text()); });
  await page2.goto(`${base}/`, { waitUntil: "load" });
  if (process.env.DEBUG) {
    const ls = await page2.evaluate(() => localStorage.getItem("nowcast_last_location"));
    console.log("[page2] localStorage nowcast_last_location =", ls);
  }
  await page2.waitForFunction(() => document.getElementById("place")?.textContent?.includes("TestObec"), { timeout: 8000 });
  assertTrue(true, "bez URL parametrů appka obnovila poslední navštívené místo (localStorage)");
  assertTrue(errors2.length === 0, `žádné JS chyby při auto-obnově místa (nalezeno ${errors2.length})`);
  await page2.close();

  // ── Auto-poloha při startu: geolokace nahradí placeholder ─────────────────
  const geoCtx = await browser.newContext({
    serviceWorkers: "block",
    permissions: ["geolocation"],
    geolocation: { latitude: 49.84, longitude: 18.29 }, // Ostrava
  });
  const pageG0 = await geoCtx.newPage();
  await startInAllSections(pageG0);
  const errG0 = [];
  pageG0.on("pageerror", e => errG0.push(e.message));
  await pageG0.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await pageG0.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageG0.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await pageG0.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageG0.route("https://api.open-meteo.com/v1/forecast**", route =>
    route.fulfill({ body: JSON.stringify(route.request().url().includes("models=") ? mmFixture : omFixture), contentType: "application/json" }));
  await pageG0.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageG0.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await pageG0.route("https://ensemble-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageG0.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageG0.route("https://nominatim.openstreetmap.org/**", route =>
    route.fulfill({ body: JSON.stringify({ address: { city: "Ostrava" } }), contentType: "application/json" }));
  // localStorage má JINÉ poslední místo — geolokace ho musí přebít
  await pageG0.addInitScript(() => localStorage.setItem("nowcast_last_location",
    JSON.stringify({ lat: 50.09, lon: 14.40, label: "StaréMísto" })));
  await pageG0.goto(`${base}/`, { waitUntil: "load" });
  await pageG0.waitForFunction(() => document.getElementById("place")?.textContent?.includes("Ostrava"), { timeout: 8000 });
  assertTrue(true, "start bez URL: geolokace nahradila placeholder aktuální polohou (Ostrava)");
  assertTrue(errG0.length === 0, `žádné JS chyby při auto-poloze (nalezeno ${errG0.length})`);
  await geoCtx.close();

  // Předchozí blok nechal stránku v embed módu, kde je půlka ovládání schovaná.
  // Vrátíme ji do normálního stavu, jinak by následující testy klikaly na to,
  // co není vidět.
  await page.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });

  // ── Pruh výstrah ──────────────────────────────────────────────────────────
  // Fixture má schválně devět výstrah, z toho tentýž jev na víc dní — přesně
  // jako ČHMÚ v horkém týdnu. Dřív z toho bylo devět štítků vedle sebe, flex
  // je smrskl na minimální šířku, text se zalomil a kulaté rohy z nich udělaly
  // kolečka přetékající z pruhu.
  {
    await page.waitForSelector("#alert-bar.show", { timeout: 8000 });
    const bar = await page.evaluate(() => {
      const b = document.getElementById("alert-bar");
      const chips = [...b.querySelectorAll(".warn-chip")];
      return {
        n: chips.length,
        texts: chips.map(c => c.textContent.trim()),
        heights: chips.map(c => Math.round(c.getBoundingClientRect().height)),
        widths: chips.map(c => Math.round(c.getBoundingClientRect().width)),
        barW: Math.round(b.getBoundingClientRect().width),
        barH: Math.round(b.getBoundingClientRect().height),
      };
    });
    assertTrue(bar.n <= 4, `pruh výstrah ukazuje nanejvýš 3 štítky + přetečení (je jich ${bar.n})`);
    assertTrue(bar.texts.some(t => /^\+\d+$/.test(t)),
      `zbytek výstrah je schovaný pod štítkem "+N" (${bar.texts.join(" | ")})`);
    // Jeden jev = jeden štítek, i když ho ČHMÚ vydalo na tři dny po sobě.
    // Ani počet opakování se nepíše — "3×" nic neříká, je to jedno vedro.
    const events = bar.texts.filter(t => !/^\+\d+$/.test(t));
    assertTrue(new Set(events).size === events.length,
      `žádný jev se v pruhu neopakuje (${events.join(" | ")})`);
    assertTrue(!bar.texts.some(t => t.includes("×")),
      `štítek nenese počet opakování (${bar.texts.join(" | ")})`);
    const spans = await page.evaluate(() =>
      [...document.querySelectorAll("#alert-bar .warn-chip")].map(c => c.title));
    assertTrue(spans.some(t => /platí .+ – .+/.test(t)),
      `platnost výstrahy je v nápovědě štítku (${spans.filter(Boolean).join(" | ")})`);

    // Stupně téhož jevu: "Silná zátěž teplem" vedle "Velmi silné" je jen ta
    // samá věc slabším písmem. Zůstat smí nejsilnější stupeň — a to i v
    // rozbaleném stavu, kde by se slabší jinak vrátila zadními vrátky.
    const all = await page.evaluate(() => {
      const b = document.getElementById("alert-bar");
      if (!b.classList.contains("expanded")) b.click();
      return [...b.querySelectorAll(".warn-chip")].map(c => c.textContent.trim());
    });
    await page.evaluate(() => document.getElementById("alert-bar").click());
    assertTrue(all.includes("Velmi silná zátěž teplem"),
      `nejsilnější stupeň zůstal (${all.join(" | ")})`);
    assertTrue(!all.includes("Silná zátěž teplem"),
      `slabší stupeň téhož jevu zmizel (${all.join(" | ")})`);
    assertTrue(all.includes("Velmi vysoké teploty") && !all.includes("Vysoké teploty"),
      `sloučení funguje i u teplot (${all.join(" | ")})`);
    // Pojistka proti přehnanému slučování: "Nízké teploty" nejsou slabší
    // verze "Vysokých teplot", je to opačný jev a musí přežít samostatně.
    assertTrue(all.includes("Nízké teploty"),
      `opačný jev se neslije do jedné rodiny (${all.join(" | ")})`);
    // Zalomený text = vysoký štítek. Jednořádkový štítek má do ~30 px.
    assertTrue(bar.heights.every(h => h <= 34),
      `žádný štítek se nezalomil do víc řádků (výšky ${bar.heights.join(",")})`);
    // Kolečko = šířka srovnatelná s výškou. Textový štítek je vždycky širší.
    assertTrue(bar.widths.every((w, i) => w > bar.heights[i]),
      `štítky jsou pilulky, ne kolečka (š×v ${bar.widths.map((w, i) => `${w}×${bar.heights[i]}`).join(" ")})`);
    const overflow = await page.evaluate(() => {
      const b = document.getElementById("alert-bar");
      const r = b.getBoundingClientRect();
      return [...b.querySelectorAll(".warn-chip")]
        .some(c => c.getBoundingClientRect().right > r.right + 1);
    });
    assertTrue(!overflow, "žádný štítek nepřetéká z pruhu ven");

    // Klepnutí rozbalí zbytek — role="button" tam byla, ale nic nedělala.
    await page.click("#alert-bar");
    const expanded = await page.evaluate(() => ({
      cls: document.getElementById("alert-bar").classList.contains("expanded"),
      n: document.querySelectorAll("#alert-bar .warn-chip").length,
    }));
    assertTrue(expanded.cls && expanded.n > bar.n,
      `klepnutí na pruh ukáže všechny výstrahy (${expanded.n} > ${bar.n})`);
    await page.click("#alert-bar");
    const collapsed = await page.evaluate(() =>
      document.querySelectorAll("#alert-bar .warn-chip").length);
    assertTrue(collapsed === bar.n, `druhé klepnutí zase sbalí (${collapsed})`);
  }

  // ── Sousedské sítě ────────────────────────────────────────────────────────
  // U hranic bývá zahraniční stanice blíž než česká — v Rychvaldu je polská
  // hranice pět kilometrů daleko. Fixture proto dává polskou stanici 1 km od
  // testovacího místa a ta musí vyhrát.
  {
    const euro = await page.evaluate(async () => {
      const { nearestFreshStation } = await import("./js/models.js");
      const { state } = await import("./js/state.js");
      // Bod pár kilometrů od polské stanice z fixture — musí vyhrát ona.
      const near = nearestFreshStation(50.59, 14.42);
      return {
        loaded: (state.EURO?.stations || []).length,
        name: near?.name, country: near?.country,
        dist: near ? Math.round(near.distKm) : null,
      };
    });
    assertTrue(euro.loaded >= 2, `euro_stations.json se načetl (${euro.loaded} stanic)`);
    assertTrue(euro.name === "Testowo" && euro.country === "PL",
      `zahraniční stanice může být referencí, když je blíž (${euro.name} ${euro.dist} km)`);
  }

  // ── Podkladová mapa v Nastavení ───────────────────────────────────────────
  // Výběr v HTML existoval, ale nikdo ho neposlouchal — přepnutí nic nedělalo.
  {
    await page.click("#btn-settings");
    const opts = await page.evaluate(() =>
      [...document.querySelectorAll("#set-basemap option")].map(o => o.value));
    assertTrue(opts.includes("satellite") && opts.length >= 3,
      `výběr mapy nabízí varianty z BASEMAPS (${opts.join(",")})`);
    const before = await page.evaluate(() => document.body.dataset.basemap);
    await page.selectOption("#set-basemap", "satellite");
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      body: document.body.dataset.basemap,
      stored: localStorage.getItem("nowcast_basemap"),
      busy: document.body.classList.contains("basemap-busy"),
    }));
    assertTrue(after.body === "satellite" && before !== "satellite",
      `přepnutí mapy se propsalo (${before} → ${after.body})`);
    assertTrue(after.stored === "satellite", `volba mapy přežije reload (${after.stored})`);
    assertTrue(after.busy, "nad satelitem se zapne vyšší kontrast radaru (basemap-busy)");
    await page.selectOption("#set-basemap", "voyager");
    await page.waitForTimeout(200);
    const back = await page.evaluate(() => document.body.dataset.basemap);
    assertTrue(back === "voyager", `návrat na barevnou mapu funguje (${back})`);
    await page.click("#settings-close");
  }

  // ── init() musí doběhnout celý ─────────────────────────────────────────────
  // Motivace je konkrétní: init registruje geolokaci, automatickou obnovu a
  // většinu tlačítek až na konci. Když cokoli před tím spadne, appka se
  // vykreslí, ale tyhle věci nefungují — což se navenek tváří jako "web jde,
  // jen neurčí polohu a data se neobnovují". Značka __nowcastInitDone tuhle
  // třídu chyb odhalí v testu, ne až u uživatele.
  {
    const okDone = await waitForAsync(page, () => window.__nowcastInitDone === true, 8000);
    assertTrue(okDone, "init() doběhl celý (window.__nowcastInitDone)");
    const fails = await page.evaluate(() => window.__nowcastInitFail || []);
    assertTrue(fails.length === 0, `žádný krok init() nespadl (${fails.join("; ") || "0"})`);
  }

  // ── Obnova po probuzení karty ─────────────────────────────────────────────
  // Prohlížeč na kartě v pozadí brzdí nebo úplně zastaví setInterval a uspaná
  // PWA po návratu pokračuje bez nového načtení. Bez reakce na návrat do
  // popředí zůstane na obrazovce, co se stáhlo naposled — třeba pět hodin staré.
  const wakeCtx = async (ageMin) => {
    const c = await browser.newContext({ serviceWorkers: "block" });
    const p = await c.newPage();
    await startInAllSections(p);
    let manifestHits = 0;
    await p.route("**/data/radar_manifest.json*", async route => {
      manifestHits++;
      const j = JSON.parse(fs.readFileSync(path.join(SERVE, "data", "radar_manifest.json"), "utf8"));
      j.generated_at_utc = new Date(Date.now() - ageMin * 60000).toISOString();
      await route.fulfill({ body: JSON.stringify(j), contentType: "application/json" });
    });
    await p.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
    await p.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
    await p.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
    await p.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
    await p.route("https://api.open-meteo.com/v1/forecast**", route => route.fulfill({ body: JSON.stringify(omFixture), contentType: "application/json" }));
    await p.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
    await p.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
    await p.route("https://ensemble-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
    await p.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
    await p.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });
    await waitForAsync(p, () => window.__nowcastInitDone === true, 8000);
    const before = manifestHits;
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await p.waitForTimeout(1200);
    const after = manifestHits;
    await c.close();
    return after - before;
  };
  assertTrue(await wakeCtx(45) > 0,
    "návrat do popředí s 45 min starými daty spustí obnovu");
  assertTrue(await wakeCtx(0) === 0,
    "návrat do popředí s čerstvými daty na server nesahá (žádné zbytečné dotazy)");

  // ── Geolokace: chyba musí říct DŮVOD ──────────────────────────────────────
  // Původní hláška byla vždycky "Polohu se nepodařilo zjistit." — z toho se
  // nedá poznat, jestli je zamítnuté oprávnění, nebo jen vypršel limit, takže
  // to nešlo ani opravit, ani poradit uživateli.
  {
    const denyCtx = await browser.newContext({ serviceWorkers: "block" }); // bez permission = zamítnuto
    const pd = await denyCtx.newPage();
  await startInAllSections(pd);
    await pd.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
    await pd.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
    await pd.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
    await pd.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
    await pd.route("https://api.open-meteo.com/v1/forecast**", route => route.fulfill({ body: JSON.stringify(omFixture), contentType: "application/json" }));
    await pd.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
    await pd.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
    await pd.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
    await pd.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });
    await waitForAsync(pd, () => window.__nowcastInitDone === true, 8000);
    await pd.click("#geo");
    const shown = await waitForAsync(pd, () =>
      document.getElementById("notif-text")?.textContent?.includes("zamítnut"), 8000);
    assertTrue(shown, "zamítnuté oprávnění k poloze hlásí konkrétní důvod, ne obecnou chybu");
    const last = await pd.evaluate(() => window.__nowcastGeoLast);
    assertTrue(last && last.ok === false && last.code === 1,
      `výsledek geolokace je k dispozici pro diagnostiku (${JSON.stringify(last)})`);
    const iconOk = await pd.evaluate(() => !!document.querySelector("#geo svg"));
    assertTrue(iconOk, "tlačítko polohy si po chybě nechalo svou ikonu (dřív ji přepsal text)");
    await denyCtx.close();
  }

  // ── Mobilní šířka ─────────────────────────────────────────────────────────
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const pageM = await mobile.newPage();
  await startInAllSections(pageM);
  const errorsM = [];
  pageM.on("pageerror", e => errorsM.push(e.message));
  await pageM.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await pageM.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageM.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await pageM.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageM.route("https://api.open-meteo.com/v1/forecast**", route => route.fulfill({ body: JSON.stringify(omFixture), contentType: "application/json" }));
  await pageM.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageM.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await pageM.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageM.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });
  await pageM.waitForSelector("#rain-countdown.show", { timeout: 8000 });
  const ctrlBox = await pageM.locator("#btn-play").boundingBox();
  assertTrue(ctrlBox && ctrlBox.height >= 40, `radar ovládací tlačítka mají dost velký dotykový cíl na mobilu (výška=${ctrlBox?.height})`);
  assertTrue(errorsM.length === 0, `žádné JS chyby na mobilní šířce (nalezeno ${errorsM.length})`);
  await mobile.close();

  // ── Modely pro tohle místo: panel + učící se verifikace ───────────────────
  const pageMod = await context.newPage();
  await startInAllSections(pageMod);
  const errorsMod = [];
  pageMod.on("pageerror", e => errorsMod.push(e.message));
  await pageMod.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await pageMod.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageMod.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await pageMod.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageMod.route("https://api.open-meteo.com/v1/forecast**", route =>
    route.fulfill({ body: JSON.stringify(route.request().url().includes("models=") ? mmFixture : omFixture), contentType: "application/json" }));
  await pageMod.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageMod.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await pageMod.route("https://ensemble-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageMod.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  // Před-nasetý 4 h starý snapshot: ICON sliboval na TUHLE hodinu 30 °C.
  // Stanice (fixture, přepsaná na čerstvý čas) měří 22 °C → po načtení musí
  // verifikace zapsat chybu 8.0 pro icon_seamless.
  await pageMod.addInitScript(() => {
    const s = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" });
    const nowHour = s.slice(0, 10) + "T" + s.slice(11, 14) + "00";
    localStorage.setItem("nowcast_model_scores_v1", JSON.stringify({
      "50.09,14.40": { t: Date.now() - 4 * 3600000, scores: {},
        snaps: [{ t: Date.now() - 4 * 3600000, h: { [nowHour]: { icon_seamless: 30 } }, done: [] }] },
    }));
  });
  await pageMod.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });
  await pageMod.waitForSelector("#models-panel.show", { timeout: 8000 });
  const mdlRows = await pageMod.locator("#models-panel .mdl-row").count();
  assertTrue(mdlRows >= 5, `panel modelů ukazuje ${mdlRows} modelů`);
  // ALADIN/ČHMÚ (z data/aladin.json, mimo Open-Meteo) se přidal jako model
  const mdlText = await pageMod.textContent("#models-panel");
  assertTrue(mdlText.includes("ALADIN"), "ALADIN/ČHMÚ je v panelu modelů");

  // Scénář "Rychvald": nejbližší stanice je 25 km daleko a o 600 m výš.
  // Se starým limitem 15 km se žebříček nikdy nerozjel (navždy "0/3"); nově
  // se stanice použije a její teplota se přepočte na výšku místa.
  const farSt = await pageMod.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const { nearestFreshStation } = await import("./js/models.js");
    const keepChmi = state.CHMI, keepWu = state.WU, keepMetar = state.METAR, keepEl = state.elevation;
    state.CHMI = { stations: [{ name: "Daleká", lat: 50.315, lon: 14.40, elev: 800,
      temp: 10, time_utc: new Date().toISOString() }] };
    state.WU = null; state.METAR = null;   // ať zbyde jen ta vzdálená stanice
    state.elevation = 200;
    const st = nearestFreshStation(50.09, 14.40);
    state.CHMI = keepChmi; state.WU = keepWu; state.METAR = keepMetar; state.elevation = keepEl;
    return st && { km: Math.round(st.distKm), tempAdj: st.tempAdj, raw: st.temp };
  });
  // 800 m → 200 m = +600 m níž ⇒ teplota +3,9 °C (gradient 0,65 °C/100 m)
  assertTrue(farSt && farSt.km >= 20 && farSt.km <= 30 && Math.abs(farSt.tempAdj - 13.9) < 0.2,
    `stanice ve 25 km se použije s výškovou korekcí (${farSt?.km} km, ${farSt?.raw}→${farSt?.tempAdj} °C)`);

  // Srážkoměrná síť ČHMÚ (436 stanic) — jiná logika než teplotní stanice:
  // dosah jen 25 km a zastaralé záznamy se musí zahodit, jinak by appka
  // ukazovala jako "naměřeno" hodnotu z předvčerejška.
  const rainSt = await pageMod.evaluate(async () => {
    const { nearestRainStation, renderRainMeasured } = await import("./js/extras.js");
    const { state } = await import("./js/state.js");
    const near = nearestRainStation(50.008, 14.447);
    renderRainMeasured();
    const el = document.getElementById("rain-measured");
    // stanice "Stará data" má stale:true a mm 9.9 — nesmí se nikdy vybrat
    const far = nearestRainStation(10.0, 10.0);   // Afrika → nic v 25 km
    return {
      name: near?.name, mm1: near?.mm_1h, km: near && Math.round(near.distKm),
      shown: el?.classList.contains("show"), wet: el?.classList.contains("rain-wet"),
      text: el?.textContent || "", far, count: state.CHMI_RAIN?.stations?.length,
    };
  });
  assertTrue(rainSt.count === 3, `chmi_rain.json se načetl (${rainSt.count} stanic)`);
  assertTrue(rainSt.name === "Praha, Libuš" && rainSt.mm1 === 1.4,
    `nejbližší čerstvý srážkoměr, ne ten zastaralý (${rainSt.name}, ${rainSt.mm1} mm/h)`);
  assertTrue(rainSt.shown && rainSt.wet && /1,4 mm/.test(rainSt.text),
    `řádka naměřených srážek se vykreslila ("${rainSt.text}")`);
  assertTrue(rainSt.far === null,
    `mimo dosah 25 km se srážkoměr nepoužije (${JSON.stringify(rainSt.far)})`);

  // ── Nové panely nad daty ČHMÚ ───────────────────────────────────────────
  // Ověřuje se hlavně párování mřížek: COTREC a echotop se na body napojují
  // přes INDEX, takže když se rozejde t0_utc nebo počet bodů, MUSÍ se panel
  // schovat, ne ukázat hodnotu z cizího místa.
  const chmiX = await page.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const m = await import("./js/chmidata.js");
    m.renderChmiExtras(26.0);   // dnešní maximum 26 °C proti normálu 25,2

    const grab = id => {
      const el = document.getElementById(id);
      return { shown: el?.classList.contains("show"), text: el?.textContent || "" };
    };
    const out = {
      cotrec: grab("cotrec-card"),
      convect: grab("convect-panel"),
      air: grab("air-panel"),
      normal: grab("normal-panel"),
      text: grab("chmitext-panel"),
      regional: grab("regional-panel"),
      cotrecLoaded: !!state.COTREC, etLoaded: !!state.ECHOTOP,
      airLoaded: !!state.CHMI_AIR, normLoaded: !!state.CHMI_NORMALS,
      nearAir: m.nearestAirStation(50.008, 14.447)?.name,
      farAir: m.nearestAirStation(10.0, 10.0),
      nearNorm: m.nearestNormalStation(50.09, 14.40)?.name,
      farNorm: m.nearestNormalStation(10.0, 10.0),
    };

    // Rozejití mřížek: podvrhneme jiné t0_utc → COTREC se musí schovat.
    const orig = state.COTREC.grid.t0_utc;
    state.COTREC.grid.t0_utc = "1999-01-01T00:00:00+00:00";
    m.renderCotrec();
    out.cotrecAfterMismatch = document.getElementById("cotrec-card")?.classList.contains("show");
    state.COTREC.grid.t0_utc = orig;

    // Rozejití počtu bodů u echotopu → hodnota PRO MÍSTO musí zmizet.
    // Celostátní maximum na párování bodů nezávisí, takže smí zůstat —
    // proto se tu netestuje skrytí celého panelu, ale konkrétní řádka.
    const origN = state.ECHOTOP.n_pts;
    state.ECHOTOP.n_pts = 999;
    const origAero = state.CHMI_AERO;
    state.CHMI_AERO = null;          // ať zbyde jen echotop jako zdroj řádků
    m.renderConvect();
    out.convectAfterMismatch = document.getElementById("convect-body")?.textContent || "";
    state.ECHOTOP.n_pts = origN;
    state.CHMI_AERO = origAero;
    m.renderChmiExtras(26.0);
    return out;
  });

  assertTrue(chmiX.cotrecLoaded && chmiX.etLoaded && chmiX.airLoaded && chmiX.normLoaded,
    "nová data ČHMÚ se načetla (chmi_fct, echotop, chmi_air, chmi_normals)");
  assertTrue(chmiX.cotrec.shown && /COTREC/.test(chmiX.cotrec.text),
    `karta druhého názoru se vykreslila ("${chmiX.cotrec.text.slice(0, 90)}")`);
  // fixture: COTREC dá déšť ve 4. kroku (40 min), forecast_grid hned → neshoda
  assertTrue(/liší se/.test(chmiX.cotrec.text),
    `rozdíl mezi metodami se pojmenoval ("${chmiX.cotrec.text.slice(0, 90)}")`);
  assertTrue(chmiX.cotrecAfterMismatch === false,
    "při rozejití t0_utc se COTREC schová místo čtení cizího bodu");
  assertTrue(!/u vás/.test(chmiX.convectAfterMismatch),
    `při rozejití mřížky zmizí hodnota pro místo ("${chmiX.convectAfterMismatch.slice(0, 70)}")`);
  assertTrue(/Nejvyšší nad ČR/.test(chmiX.convectAfterMismatch),
    "celostátní maximum na párování bodů nezávisí, takže zůstává");

  assertTrue(chmiX.convect.shown && /9,4 km/.test(chmiX.convect.text),
    `výška vrcholů u místa se vykreslila ("${chmiX.convect.text.slice(0, 90)}")`);
  assertTrue(/1450 J\/kg/.test(chmiX.convect.text) && /silná/.test(chmiX.convect.text),
    `CAPE z aerologie se vykreslil ("${chmiX.convect.text.slice(0, 140)}")`);
  assertTrue(/drží pokličku/.test(chmiX.convect.text),
    "silně záporný CIN se pojmenuje jako zábrana konvekce");

  assertTrue(chmiX.air.shown && /PM2,5/.test(chmiX.air.text) && /8,4/.test(chmiX.air.text),
    `měřené ovzduší se vykreslilo ("${chmiX.air.text.slice(0, 90)}")`);
  assertTrue(chmiX.nearAir === "Praha 4-Libuš" && chmiX.farAir === null,
    `stanice ovzduší se hledá v dosahu (${chmiX.nearAir}, daleko: ${JSON.stringify(chmiX.farAir)})`);

  assertTrue(chmiX.normal.shown && chmiX.nearNorm === "Praha-Ruzyně",
    `normál z nejbližší stanice (${chmiX.nearNorm})`);
  assertTrue(chmiX.farNorm === null,
    "mimo dosah 40 km se normál nepoužije");
  // ── Učení: bias korekce a vážený konsenzus ──────────────────────────────
  const learn = await page.evaluate(async () => {
    const { mergeScores, blendTemperature, MIN_BLEND_MODELS } =
      await import("./js/models.js");

    // Lokální chyby SE ZNAMÉNKEM: model A stabilně přestřeluje o 2 °C.
    const local = {
      A: { errs: [2, 2, 2, 2] },
      B: { errs: [-0.5, 0.5, -0.5, 0.5] },
    };
    const shared = {
      A: { n: 40, mae: 2.0, bias: 2.0 },
      C: { n: 20, mae: 1.0, bias: 0 },
    };
    const merged = mergeScores(local, shared);

    // Blend: A přestřeluje o 2, B je přesný, C přesný. Vážený průměr po
    // odečtení biasu musí být blíž pravdě než prostý průměr.
    const values = { A: 27, B: 25, C: 25 };
    const blend = blendTemperature(values, merged);
    const tooFew = blendTemperature({ A: 27 }, merged);

    return {
      ids: Object.keys(merged).sort(),
      biasA: merged.A?.bias, maeB: merged.B?.mae,
      // C je jen ze sdílených dat — musí projít i bez lokálních vzorků
      cShared: merged.C?.nShared, cLocal: merged.C?.n,
      blendValue: blend?.value, blendPlain: blend?.plain, blendUsed: blend?.used,
      tooFewValue: tooFew?.value, tooFewPlain: tooFew?.plain,
      minModels: MIN_BLEND_MODELS,
      noData: blendTemperature({}, {}),
    };
  });

  assertTrue(learn.ids.join(",") === "A,B,C",
    `sloučí se lokální i sdílené modely (${learn.ids.join(",")})`);
  assertTrue(learn.biasA === 2,
    `systematická odchylka se spočítá se znaménkem (${learn.biasA})`);
  assertTrue(learn.maeB === 0.5,
    `MAE se počítá z absolutních hodnot, i když se ukládá znaménko (${learn.maeB})`);
  assertTrue(learn.cShared === 20 && learn.cLocal === 0,
    `model jen ze sdílených dat projde bez lokálních vzorků (${learn.cShared}/${learn.cLocal})`);
  assertTrue(learn.blendValue != null && learn.blendUsed === 3,
    `konsenzus se spočítá ze všech tří modelů (${learn.blendValue}, n=${learn.blendUsed})`);
  // A slibuje 27, ale přestřeluje o 2 → po korekci 25; B i C dávají 25.
  // Prostý průměr by byl 25,7, vážený s korekcí musí být u 25.
  assertTrue(Math.abs(learn.blendValue - 25) < 0.4,
    `bias se od předpovědi odečte (${learn.blendValue} °C, prostý průměr ${learn.blendPlain})`);
  assertTrue(learn.blendPlain > learn.blendValue,
    `korigovaný konsenzus se liší od prostého průměru (${learn.blendValue} vs ${learn.blendPlain})`);
  assertTrue(learn.tooFewValue === null && learn.tooFewPlain === 27,
    `s jedním modelem se vážený konsenzus nedělá, ukáže se prostý průměr (${JSON.stringify(learn.tooFewValue)})`);
  assertTrue(learn.noData === null,
    "bez dat konsenzus nic nevymýšlí");

  // ── Prořezávání popisků podle zoomu ─────────────────────────────────────
  // Regrese, kterou to hlídá: české stanice se dřív kreslily VŠECHNY bez
  // ohledu na zoom, takže při oddálení byla mapa pod souvislou plochou štítků.
  const thin = await page.evaluate(async () => {
    const { thinByZoom, stationRank, cellSizeDeg, maxLabelsFor } =
      await import("./js/labelthin.js");
    // Umělá hustá síť: 200 stanic na malé ploše, jako je tomu v ČR.
    const mk = (i) => ({
      id: i % 10 === 0 ? `0-20000-0-11${400 + i}` : `0-203-0-${i}`,
      lat: 49 + (i % 20) * 0.1, lon: 14 + Math.floor(i / 20) * 0.1,
      temp: 20, time_utc: new Date().toISOString(),
    });
    const all = Array.from({ length: 200 }, (_, i) => mk(i));
    const out = {};
    for (const z of [5, 7, 9, 12]) out[z] = thinByZoom(all, z).length;
    return {
      counts: out,
      cellShrinks: cellSizeDeg(5) > cellSizeDeg(9),
      capGrows: maxLabelsFor(5) < maxLabelsFor(10),
      // hlavní síť musí mít přednost před národní
      wmoBeatsNational: stationRank({ id: "0-20000-0-11518" })
        > stationRank({ id: "0-203-0-41701105001" }),
      // Skutečný invariant: v každé obsazené buňce musí vyhrát stanice
      // s NEJVYŠŠÍ prioritou, jaká tam je. Tvrdit "vždycky jen hlavní síť"
      // by bylo špatně — v buňce, kde žádná hlavní stanice není, je národní
      // ta správná volba.
      violations: (() => {
        const z = 6;
        const cell = cellSizeDeg(z);
        const keyOf = (s) => {
          const lonCell = cell / Math.max(0.2, Math.cos(s.lat * Math.PI / 180));
          return `${Math.floor(s.lat / cell)}_${Math.floor(s.lon / lonCell)}`;
        };
        const bestInCell = new Map();
        for (const s of all) {
          const k = keyOf(s);
          const cur = bestInCell.get(k);
          if (!cur || stationRank(s) > stationRank(cur)) bestInCell.set(k, s);
        }
        const bad = [];
        for (const s of thinByZoom(all, z)) {
          const best = bestInCell.get(keyOf(s));
          if (best && stationRank(best) > stationRank(s)) bad.push(s.id);
        }
        return bad;
      })(),
      // preference se musí projevit: podíl hlavních stanic ve výběru je vyšší
      // než v celém vstupu (vstup má 10 %)
      wmoShareOut: (() => {
        const out = thinByZoom(all, 6);
        return out.filter(s => s.id.startsWith("0-20000")).length / out.length;
      })(),
    };
  });
  assertTrue(thin.counts[5] < thin.counts[9] && thin.counts[9] <= thin.counts[12],
    `přiblížení odkrývá víc popisků (z5=${thin.counts[5]}, z9=${thin.counts[9]}, z12=${thin.counts[12]})`);
  assertTrue(thin.counts[5] <= 18,
    `při oddálení zbyde jen hrstka popisků (${thin.counts[5]})`);
  assertTrue(thin.cellShrinks && thin.capGrows,
    "buňka se se zoomem zmenšuje a strop popisků roste");
  assertTrue(thin.wmoBeatsNational,
    "hlavní klimatologická stanice má přednost před národní");
  assertTrue(thin.violations.length === 0,
    `v buňce vždy vyhraje nejlepší dostupná stanice (porušení: ${JSON.stringify(thin.violations)})`);
  assertTrue(thin.wmoShareOut > 0.1,
    `hlavní stanice jsou ve výběru nadreprezentované (${Math.round(thin.wmoShareOut * 100)} % vs 10 % vstupu)`);

  // ── Shlukování blesků do bouřek ─────────────────────────────────────────
  const storms = await page.evaluate(async () => {
    const { clusterStrikes } = await import("./js/storms.js");
    const now = Date.now();
    const strikes = [];
    // Bouřka A: 40 úderů těsně u sebe (Praha)
    for (let i = 0; i < 40; i++) {
      strikes.push({ lat: 50.05 + Math.random() * 0.06, lon: 14.4 + Math.random() * 0.06,
        t: now - Math.random() * 8 * 60000 });
    }
    // Bouřka B: 8 úderů daleko (Brno)
    for (let i = 0; i < 8; i++) {
      strikes.push({ lat: 49.2 + Math.random() * 0.05, lon: 16.6 + Math.random() * 0.05,
        t: now - Math.random() * 5 * 60000 });
    }
    // Osamocený výboj — nesmí se stát "bouřkou"
    strikes.push({ lat: 48.9, lon: 18.2, t: now - 60000 });
    // Starý shluk mimo okno — musí vypadnout
    for (let i = 0; i < 20; i++) {
      strikes.push({ lat: 51.0, lon: 15.0, t: now - 90 * 60000 });
    }
    const out = clusterStrikes(strikes, now);
    return {
      n: out.length,
      biggest: out[0]?.count,
      near: out.map(s => ({ lat: Math.round(s.lat * 10) / 10, lon: Math.round(s.lon * 10) / 10,
        count: s.count, perMin: s.perMin, r: Math.round(s.radiusKm) })),
      empty: clusterStrikes([], now).length,
    };
  });
  assertTrue(storms.n === 2,
    `dvě bouřky, ne dvacet bodů ani nula (${storms.n}: ${JSON.stringify(storms.near)})`);
  assertTrue(storms.biggest === 40,
    `největší bouřka má všech 40 úderů (${storms.biggest})`);
  assertTrue(storms.near.some(s => s.lat === 50.1 || s.lat === 50),
    `bouřka sedí na Praze (${JSON.stringify(storms.near)})`);
  assertTrue(!storms.near.some(s => s.lat === 51),
    "shluk mimo časové okno se nepočítá");
  assertTrue(!storms.near.some(s => s.count < 3),
    "osamocený výboj se nevydává za bouřku");
  assertTrue(storms.empty === 0, "bez úderů nejsou žádné bouřky");
  assertTrue(storms.near.every(s => s.r >= 5 && s.r <= 60),
    `poloměr bouřky je v rozumných mezích (${JSON.stringify(storms.near.map(s => s.r))})`);

  assertTrue(chmiX.text.shown && /Teplá noc/.test(chmiX.text.text),
    `textová předpověď ČHMÚ se vykreslila ("${chmiX.text.text.slice(0, 70)}")`);

  // fixture: letošní měsíc 19,1 °C proti normálu 18,0 → +1,1
  assertTrue(chmiX.regional.shown && /\+1,1 °C/.test(chmiX.regional.text),
    `odchylka od normálu se spočítala ("${chmiX.regional.text.slice(0, 110)}")`);
  // srážky 40 z 80 mm = 50 % normálu
  assertTrue(/50 % normálu/.test(chmiX.regional.text),
    `srážky proti normálu v procentech ("${chmiX.regional.text.slice(0, 140)}")`);
  // poslední rok 8,8 proti ročnímu normálu 8,3 → +0,5
  assertTrue(/Rok 2025/.test(chmiX.regional.text) && /\+0,5 °C/.test(chmiX.regional.text),
    `poslední uzavřený rok proti ročnímu normálu ("${chmiX.regional.text.slice(0, 160)}")`);

  // Teploty na mapě: nativně zapnuté, tlačítko je skrývá (jako vrstva větru).
  const tempsOn = await pageMod.evaluate(async () => {
    const { renderWorldTemps, tempsEnabled, thinStations } = await import("./js/worldtemp.js");
    const { state } = await import("./js/state.js");
    await renderWorldTemps();
    const before = (state.worldTempMarkers || []).length;
    // Prořezání: 3 stanice v jedné buňce mřížky → zůstane jedna
    const thin = thinStations([
      { lat: 50.0, lon: 14.4, time_utc: new Date().toISOString() },
      { lat: 50.001, lon: 14.401, time_utc: new Date().toISOString() },
      { lat: 50.002, lon: 14.402, time_utc: new Date().toISOString() },
      { lat: 40.0, lon: -74.0, time_utc: new Date().toISOString() },
    ], 7).length;
    const chmiBefore = (state.chmiMarkers || []).length;
    document.getElementById("btn-temps").click();
    await new Promise(r => setTimeout(r, 150));
    const off = (state.worldTempMarkers || []).length;
    const chmiOff = (state.chmiMarkers || []).length;
    const offClass = document.getElementById("btn-temps").classList.contains("active");
    document.getElementById("btn-temps").click();
    await new Promise(r => setTimeout(r, 150));
    return { enabled: tempsEnabled(), before, thin, off, offClass, chmiBefore, chmiOff,
             chmiAfter: (state.chmiMarkers || []).length,
             onClass: document.getElementById("btn-temps").classList.contains("active"),
             after: (state.worldTempMarkers || []).length };
  });
  assertTrue(tempsOn.enabled === true, "teploty jsou nativně zapnuté (bez uloženého nastavení)");
  assertTrue(tempsOn.thin === 2, `prořezání nechá jednu stanici na buňku (${tempsOn.thin} ze 4)`);
  assertTrue(tempsOn.off === 0 && tempsOn.offClass === false,
    `tlačítko teploty schová (markerů ${tempsOn.off}, active=${tempsOn.offClass})`);
  assertTrue(tempsOn.onClass === true, "opětovný klik teploty zase zapne");
  // Regrese: tlačítko dřív schovalo jen letištní popisky a české stanice
  // svítily dál, takže "skrýt kvůli výhledu na mapu" nefungovalo.
  assertTrue(tempsOn.chmiBefore > 0 && tempsOn.chmiOff === 0,
    `tlačítko schová i české stanice (${tempsOn.chmiBefore} → ${tempsOn.chmiOff})`);
  assertTrue(tempsOn.chmiAfter > 0,
    `české stanice se po opětovném zapnutí vrátí (${tempsOn.chmiAfter})`);

  // Letištní METAR stanice zahušťují řídkou síť ČHMÚ — musí být v nabídce
  const metarSeen = await pageMod.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const { nearestFreshStation } = await import("./js/models.js");
    const keepChmi = state.CHMI, keepWu = state.WU;
    state.CHMI = null; state.WU = null;           // zbydou jen METAR stanice
    const st = nearestFreshStation(50.09, 14.40);
    state.CHMI = keepChmi; state.WU = keepWu;
    return st?.name || null;
  });
  assertTrue(/letiště/.test(metarSeen || ""), `METAR stanice se použije jako zdroj měření (${metarSeen})`);
  const mdlScore = await pageMod.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("nowcast_model_scores_v1") || "{}");
    return s["50.09,14.40"]?.scores?.icon_seamless?.errs || [];
  });
  assertTrue(mdlScore.length === 1 && Math.abs(mdlScore[0] - 8) < 0.61,
    `verifikace zapsala chybu ICONu proti stanici (errs=${JSON.stringify(mdlScore)})`);
  assertTrue(errorsMod.length === 0, `žádné JS chyby v panelu modelů (${errorsMod[0] || 0})`);
  await pageMod.close();

  // ── Světový režim — místo mimo pokrytí českého radaru (New York) ──────────
  const pageG = await context.newPage();
  await startInAllSections(pageG);
  const errorsG = [];
  pageG.on("pageerror", e => { errorsG.push(e.message); if (process.env.DEBUG) console.log("[pageG:pageerror]", e.message); });
  pageG.on("console", msg => {
    // Blitzortung WSS sandbox proxy blokuje — to není chyba aplikace
    if (msg.type() === "error" && !/blitzortung|WebSocket/i.test(msg.text())) errorsG.push(msg.text());
  });
  await pageG.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", route => route.fulfill({ path: path.join(FIXTURES, "leaflet-stub.js"), contentType: "text/javascript" }));
  await pageG.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageG.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js", route => route.fulfill({ path: path.join(FIXTURES, "chart-stub.js"), contentType: "text/javascript" }));
  await pageG.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }));
  await pageG.route("https://api.open-meteo.com/v1/forecast**", route => route.fulfill({ body: JSON.stringify(omFixture), contentType: "application/json" }));
  await pageG.route("https://air-quality-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageG.route("https://archive-api.open-meteo.com/**", route => route.fulfill({ body: JSON.stringify(buildArchiveFixture()), contentType: "application/json" }));
  await pageG.route("https://ensemble-api.open-meteo.com/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  await pageG.route("https://*.workers.dev/**", route => route.fulfill({ body: "{}", contentType: "application/json" }));
  const rvNow = Math.floor(Date.now() / 1000 / 600) * 600;
  await pageG.route("https://api.rainviewer.com/**", route =>
    route.fulfill({ body: JSON.stringify({
      host: "https://tilecache.rainviewer.com",
      radar: {
        past: [{ time: rvNow - 600, path: "/v2/radar/p1" }, { time: rvNow, path: "/v2/radar/t0" }],
        nowcast: [{ time: rvNow + 600, path: "/v2/radar/n1" }, { time: rvNow + 1200, path: "/v2/radar/n2" }],
      },
    }), contentType: "application/json" }));
  // 1×1 průhledný PNG = "radar bez ozvěny" — globalrain z něj přečte sucho
  // a odpočet srážek pak stojí na minutely_15 fixture (model)
  const dryTilePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==", "base64");
  await pageG.route("https://tilecache.rainviewer.com/**", route =>
    route.fulfill({ body: dryTilePng, contentType: "image/png" }));

  await pageG.goto(`${base}/?lat=40.7128&lon=-74.0060&q=New+York`, { waitUntil: "load" });
  await pageG.waitForFunction(() => document.getElementById("place")?.textContent?.includes("New York"), { timeout: 8000 });
  const globalState = await pageG.evaluate(async () => {
    const { state } = await import("./js/state.js");
    return { inCZ: state.inCZ, globalMode: state.globalMode,
      dist: document.getElementById("dist")?.textContent || "" };
  });
  assertTrue(globalState.inCZ === false, `New York je mimo český grid (inCZ=${globalState.inCZ})`);
  assertTrue(globalState.globalMode === true, `světový radar se zapnul automaticky (globalMode=${globalState.globalMode})`);
  assertTrue(globalState.dist.includes("Světový režim"), `hláška o světovém režimu (${globalState.dist})`);

  // Světové stanice: dlaždice 10° se dotáhne až po výběru místa mimo ČR a
  // nearestFreshStation ji musí vidět stejně jako ČHMÚ/WU doma. Bez toho by
  // žebříček přesnosti modelů fungoval jen v Česku.
  // POZOR: waitForFunction s ASYNC funkcí tady nefunguje — vrácená Promise je
  // truthy hned při prvním pollu, takže čekání skončí okamžitě a test závodí
  // s načítáním dlaždice. (Přesně na tohle upozorňuje i poznámka u gRadar níž
  // — a stejně jsem do toho spadl.) Proto se poll dělá v Node přes evaluate.
  await waitForAsync(pageG, async () => {
    const { state } = await import("./js/state.js");
    return (state.METAR_WORLD?.stations || []).length > 0;
  });
  const worldSt = await pageG.evaluate(async () => {
    const { state } = await import("./js/state.js");
    const { metarTileId } = await import("./js/worldstations.js");
    const { nearestFreshStation } = await import("./js/models.js");
    // Stanice ve fixture jsou z 17. 7. — na "čerstvost" je posuň na teď,
    // ať test neměří stáří fixture místo logiky hledání.
    (state.METAR_WORLD?.stations || []).forEach(s => { s.time_utc = new Date().toISOString(); });
    state.elevation = 10;
    const near = nearestFreshStation(40.7128, -74.0060);
    return {
      tile: metarTileId(40.7128, -74.0060),
      count: (state.METAR_WORLD?.stations || []).length,
      buoys: (state.METAR_WORLD?.stations || []).filter(s => s.source === "ndbc").length,
      near: near && { name: near.name, dist: Math.round(near.distKm), temp: near.tempAdj },
    };
  });
  assertTrue(worldSt.tile === "13_10", `dlaždice pro New York se počítá správně (${worldSt.tile})`);
  assertTrue(worldSt.count >= 2, `světová dlaždice se načetla (${worldSt.count} stanic)`);
  assertTrue(!!worldSt.near && /KJFK|KEWR/.test(worldSt.near.name),
    `nejbližší měřená stanice v New Yorku (${worldSt.near?.name} ${worldSt.near?.dist} km, ${worldSt.near?.temp} °C)`);
  // Ve fixture je bóje BLÍŽ než obě letiště. Na mapě být musí — kvůli ní se
  // NDBC tahá — ale referenční stanicí se stát nesmí: měří nad vodou a ten
  // rozdíl by se v hodnocení modelů projevil jako jejich chyba.
  assertTrue(!/bóje/.test(worldSt.near?.name || ""),
    `bóje se nestala referenční stanicí, i když je nejblíž (${worldSt.near?.name})`);
  assertTrue(worldSt.buoys >= 1,
    `bóje se načetla do světové dlaždice (${worldSt.buoys})`);

  // odpočet srážek jede z RainViewer vzorků (sucho) + minutely modelu
  await pageG.waitForFunction(() => {
    const el = document.getElementById("rain-countdown");
    const title = document.getElementById("rc-title")?.textContent || "";
    return el?.classList.contains("show") && title.length > 0;
  }, { timeout: 8000 });
  const gTitle = await pageG.evaluate(() => document.getElementById("rc-title")?.textContent || "");
  assertTrue(/Srážky možné|[Dd]éšť|Mrholení|bez srážek/.test(gTitle), `countdown ve světovém režimu funguje ("${gTitle}")`);

  // vzorkování RainViewer dlaždic doběhlo (t0 + 2 nowcast snímky, vše suché).
  // POZOR: waitForFunction s async funkcí tu nejde použít — vrácená Promise je
  // truthy okamžitě, takže by čekání prošlo i bez dat. Polluje se přes evaluate.
  let gRadar = null;
  for (let i = 0; i < 40 && !gRadar; i++) {
    gRadar = await pageG.evaluate(async () => {
      const { state } = await import("./js/state.js");
      if (!state._globalRadar) return null;
      return { n: state._globalRadar.frames.length,
        allDry: state._globalRadar.frames.every(f => f.dbzNear < 10) };
    });
    if (!gRadar) await pageG.waitForTimeout(200);
  }
  assertTrue(gRadar && gRadar.n === 3 && gRadar.allDry,
    `RainViewer dlaždice navzorkované (${gRadar?.n ?? 0} snímků, sucho=${gRadar?.allDry})`);

  // Strop intenzity z dBZ — pixel 255 (95.5 dBZ, servisní hodnota) dřív dával
  // "34 000 mm/h" (scénář Bratislava); fyzikální strop 70 dBZ / 150 mm/h
  const mmhVals = await pageG.evaluate(async () => {
    const { dbzToMmh } = await import("./js/globalrain.js");
    return [dbzToMmh(95.5), dbzToMmh(200), dbzToMmh(30)];
  });
  assertTrue(mmhVals[0] <= 150 && mmhVals[1] <= 150 && mmhVals[2] > 2 && mmhVals[2] < 4,
    `dbzToMmh má fyzikální strop (95.5→${mmhVals[0]}, 200→${mmhVals[1]}, 30→${mmhVals[2]} mm/h)`);

  // Dekódování BW pixelu dle RainViewer spec: dBZ = (R & 127) − 32, bit 128 = sníh.
  // Regrese "každý mrak lije 150 mm/h": R=190 je 30 dBZ sněhu, ne 63 dBZ průtrže.
  const dec = await pageG.evaluate(async () => {
    const { decodeDbz } = await import("./js/globalrain.js");
    return [decodeDbz(62, 255), decodeDbz(190, 255), decodeDbz(255, 255), decodeDbz(120, 0)];
  });
  assertTrue(
    dec[0].dbz === 30 && dec[0].snow === false
    && dec[1].dbz === 30 && dec[1].snow === true
    && dec[2].dbz === -32               // (255&127)−32 = 95 > fyzikální strop → neplatný
    && dec[3].dbz === -32,              // průhledný pixel = bez ozvěny
    `decodeDbz odpovídá RainViewer spec (62→${dec[0].dbz}, 190→${dec[1].dbz}+sníh=${dec[1].snow}, 255→${dec[2].dbz}, alpha0→${dec[3].dbz})`);

  // Slovník intenzit — 0.3 mm/h je mrholení, ne "Déšť" (scénář Těšín)
  const intWords = await pageG.evaluate(async () => {
    const { precipDescr } = await import("./js/verdict.js");
    return [precipDescr(0.3, "rain").fut, precipDescr(1.2, "rain").fut,
      precipDescr(5, "rain").fut, precipDescr(22, "rain").fut, precipDescr(0.3, "snow").fut];
  });
  assertTrue(
    intWords[0] === "Mrholení" && intWords[1] === "Slabý déšť" && intWords[2] === "Déšť"
    && intWords[3] === "Přívalový déšť" && intWords[4] === "Slabé sněžení",
    `slovník intenzit odpovídá mm/h (${intWords.join(" / ")})`);

  const accShownG = await pageG.evaluate(() =>
    document.getElementById("accuracy-line")?.classList.contains("show") ?? false);
  assertTrue(!accShownG, "statistika přesnosti CZ nowcastu je mimo ČR skrytá");
  assertTrue(errorsG.length === 0, `žádné JS chyby ve světovém režimu (nalezeno ${errorsG.length}: ${errorsG[0] || ""})`);
  await pageG.close();

  await browser.close();
  server.close();
  rmrf(SERVE);

  console.log(`\n${failures === 0 ? "✅ VŠECHNY TESTY PROŠLY" : `❌ ${failures} SELHÁNÍ`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("Smoke test spadl s výjimkou:", e);
  process.exit(1);
});
