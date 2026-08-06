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

// ICON-EPS: pár členů kolem stejné křivky, ať má vějíř co kreslit.
function buildEnsembleFixture(members = 6, hours = 48) {
  const nowHour = pragueNowAsNaive();
  nowHour.setUTCMinutes(0, 0, 0);
  const hourly = { time: [] };
  for (let m = 0; m < members; m++) {
    hourly[m === 0 ? "temperature_2m" : `temperature_2m_member${String(m).padStart(2, "0")}`] = [];
    hourly[m === 0 ? "precipitation" : `precipitation_member${String(m).padStart(2, "0")}`] = [];
  }
  const tKeys = Object.keys(hourly).filter(k => k.startsWith("temperature_2m"));
  const pKeys = Object.keys(hourly).filter(k => k.startsWith("precipitation"));
  for (let i = 0; i < hours; i++) {
    hourly.time.push(fmtDateTime(new Date(nowHour.getTime() + i * 3600000)));
    tKeys.forEach((k, m) => hourly[k].push(20 + Math.sin(i / 4) * 4 + (m - members / 2) * 0.7));
    pKeys.forEach((k, m) => hourly[k].push(i >= 3 && i < 6 ? 1.2 + m * 0.3 : 0));
  }
  return { hourly };
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
  // Ensemble se stahuje JEDNOU a slouží dvěma věcem: vějíři u dní v týdnu
  // a záložce Ensemble v grafu dne. Fixture proto musí mít opravdové členy —
  // s prázdnou odpovědí by se ta cesta vůbec neprošla.
  const ensFixture = buildEnsembleFixture();
  await page.route("https://ensemble-api.open-meteo.com/**", route =>
    route.fulfill({ body: JSON.stringify(ensFixture), contentType: "application/json" }));
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

  // ── Předpověď: JEDEN panel (týden + rozbalený detail dne) ────────────────
  // Proužek "Dnes" a samostatný meteogram tady stávaly jako dva další panely
  // nad týdnem a počítaly se z týchž hodin. Test proto hlídá i to, že už
  // NEEXISTUJÍ — jinak by se mohly tiše vrátit.
  await page.waitForSelector("#fc7-detail .fc7d-hour", { timeout: 8000 });
  const zbytky = await page.evaluate(() => ({
    fc24: !!document.getElementById("fc24"),
    meteo: !!document.getElementById("meteo-block"),
    hodin: document.querySelectorAll("#fc7-detail .fc7d-hour").length,
    graf: document.querySelectorAll("#fc7-detail canvas").length,
    pretekaHodina: [...document.querySelectorAll(".fc7d-hour")]
      .some(c => c.scrollWidth > c.clientWidth + 1),
  }));
  assertTrue(!zbytky.fc24 && !zbytky.meteo,
    `proužek Dnes ani meteogram už nejsou samostatné panely (fc24=${zbytky.fc24}, meteo=${zbytky.meteo})`);
  assertTrue(zbytky.hodin >= 6, `detail dne nese hodiny (${zbytky.hodin})`);
  assertTrue(zbytky.graf === 1, `detail dne má vlastní graf (${zbytky.graf})`);
  // Chytilo reálný bug: obsah sloupce (vítr+srážky) přetékal mimo úzký
  // sloupec a překrýval sousední hodiny.
  assertTrue(!zbytky.pretekaHodina, "obsah hodinových sloupců nepřetéká mimo sloupec");

  await page.waitForSelector(".fc7-day", { timeout: 5000 });
  const fc7days = await page.locator(".fc7-day").count();
  assertTrue(fc7days === 7, `7denní výhled má 7 dní (má ${fc7days})`);

  await page.waitForSelector("#aq-panel.show", { timeout: 5000 });
  const aqText = await page.textContent("#aq-panel");
  // PM2,5 s čárkou — panel měřených imisí to tak psal odjakživa (viz test
  // níž), modelový panel psal PM2.5. Dva panely nad sebou, dva zápisy téže
  // látky.
  assertTrue(aqText.includes("PM2,5"), "panel kvality ovzduší se vykreslil");

  // ── Navigace sekcí — skáče, NESKRÝVÁ ─────────────────────────────────────
  // Regrese, kterou tenhle blok hlídá, je ta nejdražší z celé appky: první
  // verze navigace obsah filtrovala a jedno klepnutí palcem schovalo nowcast
  // i předpověď. Test proto neověřuje jen skok, ale hlavně to, že po přepnutí
  // je pořád všechno vidět.
  {
    const secs = await page.evaluate(() =>
      [...document.querySelectorAll("#secnav button")].map(b => b.dataset.sec));
    assertTrue(secs.join(",") === "now,today,week,data",
      `navigace nabízí čtyři sekce (${secs.join(",")})`);

    await page.click('#secnav button[data-sec="data"]');
    await page.waitForTimeout(400);
    const stillVisible = await page.evaluate(() => {
      const vis = id => {
        const el = document.getElementById(id);
        return !!el && getComputedStyle(el).display !== "none";
      };
      return { fc7: vis("fc7"), precip: vis("precip-panel"),
               forecast: vis("forecast-panel"), aq: vis("aq-panel") };
    });
    assertTrue(Object.values(stillVisible).every(Boolean),
      `po přepnutí na Data zůstalo VŠECHNO viditelné (${JSON.stringify(stillVisible)})`);

    const pressed = await page.evaluate(() =>
      document.querySelector('#secnav button[data-sec="data"]').getAttribute("aria-pressed"));
    assertTrue(pressed === "true", "aktivní tlačítko hlásí aria-pressed");

    // Skok musí cíl DOSTAT NAHORU. Dřív to měřil ujetý počet pixelů, ale to
    // je vlastnost rozvržení, ne navigace: jak se appka zhušťovala, vzdálenost
    // klesala, až test začal padat na prahu, i když skok fungoval správně.
    // Testuje se proto to, co navigace slibuje — po klepnutí je začátek sekce
    // na obrazovce nahoře.
    // Výchozí stav je schválně "úplně dole ve všech svitcích" — jinak by
    // sedmidenní výhled mohl na startu náhodou už nahoře být a skok by se
    // nedal odlišit od nicnedělání.
    await page.evaluate(() => {
      window.scrollTo({ top: 99999 });
      for (const id of ["left-card", "right-panel"]) {
        const el = document.getElementById(id);
        if (el) el.scrollTop = 99999;
      }
    });
    await page.waitForTimeout(200);
    const topOf = id => page.evaluate(
      i => document.getElementById(i).getBoundingClientRect().top, id);
    const before = await topOf("fc7");
    await page.click('#secnav button[data-sec="week"]');
    await page.waitForTimeout(700);
    // Počkej, až doběhnou animace. Panely nabíhají přes transform, a ten se
    // do getBoundingClientRect počítá — měření uprostřed náběhu je posunuté
    // o celou dráhu animace (tady o 10 px, což stačilo na spadlý test).
    await page.waitForFunction(
      () => document.getAnimations().every(a => a.playState !== "running"),
      null, { timeout: 4000 }).catch(() => {});
    const after = await topOf("fc7");
    assertTrue(Math.abs(after - before) > 20 && after >= -8 && after < 160,
      `klepnutí na sekci vytáhne její začátek nahoru (${Math.round(before)} → ${Math.round(after)} px od horní hrany)`);
  }

  // ── Přepínač sekcí se musí vykreslit jako pilulka ────────────────────────
  // Konkrétní chyba, kterou tenhle blok hlídá: lišta byla potomkem #left-card,
  // ta má backdrop-filter, a ten podle spec zakládá containing block pro
  // position:fixed. Lišta se proto nepřilepila k oknu, ale ke kartě, přistála
  // přes tlačítka Sdílet/Embed a její sklo se rozmazalo proti sklu rodiče,
  // takže z ní zbyl holý text bez pozadí. Test kontroluje příčinu (žádný
  // filtrující předek) i následek (opravdové pozadí, jezdec na správném
  // segmentu, na mobilu přilepení k dolní hraně okna).
  {
    const noFilteredAncestor = await page.evaluate(() => {
      const bad = [];
      for (let n = document.getElementById("secnav")?.parentElement;
           n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        const props = [s.filter, s.backdropFilter, s.webkitBackdropFilter,
                       s.transform, s.perspective];
        if (props.some(v => v && v !== "none")) bad.push(n.id || n.tagName);
      }
      return bad;
    });
    assertTrue(noFilteredAncestor.length === 0,
      `přepínač nemá předka s filtrem/transformem (${noFilteredAncestor.join(",") || "žádný"})`);

    const skin = await page.evaluate(() => {
      const nav = document.getElementById("secnav");
      const s = getComputedStyle(nav);
      const r = nav.getBoundingClientRect();
      return { bg: s.backgroundColor, radius: parseFloat(s.borderRadius),
               shadow: s.boxShadow, w: r.width, h: r.height };
    });
    assertTrue(!/rgba\(0, 0, 0, 0\)|transparent/.test(skin.bg),
      `přepínač má vlastní pozadí (${skin.bg})`);
    assertTrue(skin.radius >= 12 && skin.h > 24 && skin.w > 160,
      `přepínač má tvar pilulky (r=${skin.radius}, ${Math.round(skin.w)}×${Math.round(skin.h)})`);

    // Jezdec: --sec-i musí sedět na pořadí aktivního tlačítka.
    for (const [sec, idx] of [["now", 0], ["today", 1], ["week", 2], ["data", 3]]) {
      await page.click(`#secnav button[data-sec="${sec}"]`);
      const i = await page.evaluate(() =>
        getComputedStyle(document.getElementById("secnav")).getPropertyValue("--sec-i").trim());
      assertTrue(Number(i) === idx, `jezdec stojí na sekci ${sec} (--sec-i=${i})`);
    }

    // Na mobilu je z přepínače spodní lišta — musí být přilepená k oknu
    // a nesmí ležet přes obsah karty.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const mob = await page.evaluate(() => {
      const r = document.getElementById("secnav").getBoundingClientRect();
      const s = getComputedStyle(document.getElementById("secnav"));
      return { bottomGap: window.innerHeight - r.bottom, left: r.left,
               width: r.width, pos: s.position, vw: window.innerWidth };
    });
    assertTrue(mob.pos === "fixed" && mob.bottomGap >= 0 && mob.bottomGap < 60,
      `na mobilu je přepínač přilepený dole (${Math.round(mob.bottomGap)} px nad hranou)`);
    assertTrue(mob.width > mob.vw * 0.8,
      `spodní lišta jde přes celou šířku (${Math.round(mob.width)} z ${mob.vw} px)`);

    // Po odrolování dolů musí být pořád čitelná: kdyby byla průsvitná jako
    // desktopové sklo, text pod ní by prosvítal a lišta by opticky zmizela.
    // Pozor na formát: color-mix() se nepočítá do rgba(), ale do
    // "color(srgb r g b / a)". Když se alfa nedá přečíst, test PADÁ — jinak
    // by fallback na 1 tvrdil, že je všechno v pořádku, aniž by cokoli změřil.
    const alpha = await page.evaluate(() => {
      const bg = getComputedStyle(document.getElementById("secnav")).backgroundColor;
      let m = bg.match(/^rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(/[,/]/).map(v => parseFloat(v));
        return p.length > 3 ? p[3] : 1;          // rgb() bez alfy = krycí
      }
      m = bg.match(/^color\([^/)]+\/\s*([\d.]+)\s*\)/);
      if (m) return parseFloat(m[1]);
      if (/^color\(/.test(bg)) return 1;         // color() bez lomítka = krycí
      return NaN;                                 // neznámý formát → pád
    });
    assertTrue(Number.isFinite(alpha) && alpha > 0.85,
      `spodní lišta je krycí, ne průsvitná (alfa ${alpha})`);

    // SHOT=<adresář> uloží obě podoby lišty k očnímu srovnání. Geometrii
    // ověří asserty, ale jestli to vypadá jako pilulka, rozhodne jen oko.
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/secnav-mobil.png` });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/secnav-desktop.png` });

    // Na desktopu lišta visí NAD kartou, ne přes ni.
    const stack = await page.evaluate(() => {
      const n = document.getElementById("secnav").getBoundingClientRect();
      const c = document.getElementById("left-card").getBoundingClientRect();
      return { navBottom: n.bottom, cardTop: c.top };
    });
    assertTrue(stack.navBottom <= stack.cardTop + 1,
      `přepínač nepřekrývá levou kartu (${Math.round(stack.navBottom)} ≤ ${Math.round(stack.cardTop)})`);
  }

  // ── Hlavičky panelů mluví jedním hlasem ──────────────────────────────────
  // "Průběh dne" a "Trefili jsme se?" se sázely jako věta tučně a bíle, tedy
  // o dva stupně hlasitěji než ostatní hlavičky (verzálky, prostrkání, šedá).
  // Ve svitku to nevypadá jako důraz, ale jako že tam ty panely nepatří.
  {
    const heads = await page.evaluate(() => {
      const sel = ".fc7-title, .aq-title, .meteo-title, .astro-title,"
        + " .mdl-title, .pp-title, .vf-title";
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent === null) continue;
        const s = getComputedStyle(el);
        out.push({ t: el.className, size: s.fontSize, w: s.fontWeight,
                   up: s.textTransform, c: s.color });
      }
      return out;
    });
    assertTrue(heads.length >= 4, `hlavičky panelů se našly (${heads.length})`);
    const odd = heads.filter(h => h.up !== "uppercase" || h.size !== heads[0].size
                                  || h.c !== heads[0].c);
    assertTrue(odd.length === 0,
      `všechny hlavičky panelů mají stejný zápis (výjimky: ${odd.map(o => o.t).join(", ") || "0"})`);
  }

  // ── Čísla se píšou česky, tedy s čárkou ──────────────────────────────────
  // V pravém sloupci stály pod sebou "NORMÁL · 18,8 °C" a "TENTO DEN
  // V HISTORII · 30.4 °C". Stejný typ čísla, dva zápisy, dva centimetry od
  // sebe. Test čte VYKRESLENÝ text, ne zdroj — jen tak pozná, co uživatel
  // opravdu uvidí, ať už to číslo prošlo jakoukoli cestou.
  {
    const dots = await page.evaluate(() => {
      const bad = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const p = n.parentElement;
        if (!p || p.offsetParent === null) continue;
        if (p.closest("script, style, #settings-log, .leaflet-control-attribution")) continue;
        // Desetinná tečka mezi číslicemi. Verze, IP a souřadnice v appce
        // nejsou, takže každý takový výskyt je číslo pro čtenáře.
        const m = n.nodeValue.match(/\d+\.\d+/g);
        if (m) bad.push(`${p.className || p.tagName}: ${m.slice(0, 2).join(",")}`);
      }
      return [...new Set(bad)];
    });
    assertTrue(dots.length === 0,
      `žádné desetinné číslo s tečkou (${dots.slice(0, 4).join(" | ") || "0"})`);

    // Mezera před procentem — česky se píše "5 %". Appka to střídala i uvnitř
    // jednoho pole: "srážky 62%" hned vedle "vlhkost ~55 %".
    const pct = await page.evaluate(() => {
      const bad = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const p = n.parentElement;
        if (!p || p.offsetParent === null) continue;
        if (p.closest("script, style, .leaflet-control-attribution")) continue;
        const m = n.nodeValue.match(/\d%/g);
        if (m) bad.push(`${p.className || p.tagName}: …${m[0]}`);
      }
      return [...new Set(bad)];
    });
    assertTrue(pct.length === 0,
      `procento má před sebou mezeru (${pct.slice(0, 4).join(" | ") || "0"})`);
  }

  // ── Dlaždice: jedna gramatika a nic uříznutého ───────────────────────────
  // Dlaždice jsou v levé kartě široké ~114 px (dvousloupcová mřížka), takže
  // dlouhý popisek se uřízne třemi tečkami. "v nárazech 18 k…" nikomu
  // nepomůže, a protože je to nowrap + ellipsis, nikde to jinak nekřikne —
  // test je jediné místo, které si toho všimne.
  {
    const tiles = await page.evaluate(() => {
      const clipped = [];
      for (const el of document.querySelectorAll(".tile-l, .tile-v, .tile-s, .aq-item-label, .aq-item-val")) {
        if (el.scrollWidth > el.clientWidth + 1) clipped.push(el.textContent.trim().slice(0, 24));
      }
      // Ovzduší a pyl musí mluvit stejnou gramatikou jako vítr nebo tlak:
      // popisek verzálkami a jednotka menší než hodnota.
      const l = document.querySelector(".aq-item-label");
      const u = document.querySelector(".aq-item-val .u");
      const ls = l ? getComputedStyle(l) : null;
      return {
        clipped,
        aqUpper: ls?.textTransform === "uppercase",
        aqUnitSmaller: !!u && parseFloat(getComputedStyle(u).fontSize)
                            < parseFloat(getComputedStyle(u.parentElement).fontSize),
      };
    });
    assertTrue(tiles.clipped.length === 0,
      `žádný text v dlaždici není uříznutý (${tiles.clipped.slice(0, 3).join(" | ") || "0"})`);
    assertTrue(tiles.aqUpper, "dlaždice ovzduší mají popisek verzálkami jako ostatní");
    assertTrue(tiles.aqUnitSmaller, "jednotka je menší než hodnota i v dlaždicích ovzduší");
  }

  // ── Nikde žádná emoji ────────────────────────────────────────────────────
  // Appka má DVĚ legitimní ikonografie: barevné Meteocons pro stav počasí
  // (img.wicon) a tenké jednobarevné glyfy pro ovládání (svg.uicon). Emoji
  // byla třetí, nezvaná: kreslí se na každé platformě jinak, je barevná
  // uprostřed monochromního UI a nedá se obarvit podle motivu.
  //
  // Typografické značky (šipky, ✕, ✓, ▲▼, ▶) emoji NEJSOU a zůstávají —
  // jsou jednobarevné a chovají se jako písmo.
  {
    const found = await page.evaluate(() => {
      // Extended_Pictographic je ta správná vlastnost — ✕ ✓ ↺ ↵ ★ ▲ ▼ pod ni
      // nespadnou, protože to nejsou piktogramy, ale typografické značky.
      // Šipky (U+2190–U+21FF) a geometrické tvary (U+25A0–U+25FF) se vyjímají
      // ručně, stejně jako © a ®: Unicode je za piktogramy považuje, protože
      // k nim existují emoji varianty,
      // ale my je sázíme jako písmo a chovají se tak.
      const RE = /(?=\p{Extended_Pictographic})[^\u00A9\u00AE\u2190-\u21FF\u25A0-\u25FF]/u;
      const hits = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const p = n.parentElement;
        if (!p || p.closest("script, style")) continue;
        const m = n.nodeValue.match(RE);
        if (m) hits.push(`${p.id || p.className || p.tagName}: ${m[0]}`);
      }
      return [...new Set(hits)];
    });
    assertTrue(found.length === 0,
      `žádná emoji ve vykresleném UI (${found.slice(0, 5).join(" | ") || "0"})`);

    // A totéž ve zdrojích, ať se nová emoji nedostane do větve, kterou
    // fixtura zrovna nevykreslí (bouřky, upozornění, rekordy stanic…).
    const srcHits = [];
    const RE_SRC = /(?=\p{Extended_Pictographic})[^\u00A9\u00AE\u2190-\u21FF\u25A0-\u25FF]/u;
    const files = ["web/index.html", ...fs.readdirSync(path.join(__dirname, "..", "web", "js"))
      .filter(n => n.endsWith(".js")).map(n => `web/js/${n}`)];
    for (const f of files) {
      const t = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      t.split("\n").forEach((line, i) => {
        // Komentáře pryč — popisují i to, co se odstranilo ("dřív tu bylo 🔕").
        const t2 = line.trim();
        if (t2.startsWith("//") || t2.startsWith("*") || t2.startsWith("/*")) return;
        const code = line.replace(/\/\/.*$/, "").replace(/<!--[\s\S]*?-->/g, "");
        const m = code.match(RE_SRC);
        if (m) srcHits.push(`${f}:${i + 1} ${m[0]}`);
      });
    }
    assertTrue(srcHits.length === 0,
      `žádná emoji ve zdrojích (${srcHits.slice(0, 5).join(" | ") || "0"})`);
  }

  // ── Barevná plocha musí být zaoblená ─────────────────────────────────────
  // Odpočet měl v základu border-radius:0, protože je HLAVOU srážkové karty
  // (žádné vlastní sklo, jen dělicí linka). Stavy .clear/.imminent ale to
  // rozhodnutí obcházely a přikreslily celý box — jenže nulový poloměr
  // a nulové boční odsazení po hlavě zůstaly. Vznikl ostrohranný obdélník
  // zaražený do zaoblené karty, s ikonou nalepenou na rámeček.
  //
  // Pravidlo, které z toho plyne: co má vlastní barevnou plochu, má i tvar.
  // Průhledné prvky (řádky, oddělovače) se netýkají — ty žádnou plochu
  // nekreslí. Výjimka jsou dílky uvnitř zaobleného ořezaného obalu: tvar
  // za ně drží obal (např. úseky pásu 12h výhledu).
  {
    for (const st of ["clear", "imminent"]) {
      const geo = await page.evaluate(cls => {
        const el = document.getElementById("rain-countdown");
        el.classList.remove("clear", "imminent");
        el.classList.add("show", cls);
        const c = getComputedStyle(el);
        return { r: parseFloat(c.borderRadius), pl: parseFloat(c.paddingLeft),
                 pr: parseFloat(c.paddingRight) };
      }, st);
      assertTrue(geo.r >= 12 && geo.pl > 4 && geo.pr > 4,
        `odpočet ve stavu ${st} je zaoblený a odsazený (r=${geo.r}, p=${geo.pl}/${geo.pr})`);
    }

    const square = await page.evaluate(() => {
      const bad = [];
      const rgba = v => (v.match(/[\d.]+/g) || []).map(Number);
      for (const el of document.querySelectorAll("#left-card *, #right-panel *")) {
        if (el.offsetParent === null) continue;
        const c = getComputedStyle(el);
        const bg = rgba(c.backgroundColor);
        if ((bg[3] ?? 1) < 0.04) continue;                 // nic nekreslí
        if (parseFloat(c.borderRadius) > 0) continue;      // má tvar
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 14) continue;       // proužky a tečky
        // Dílek uvnitř zaobleného ořezaného obalu — tvar drží obal.
        let p = el.parentElement, clipped = false;
        for (let i = 0; p && i < 3; p = p.parentElement, i++) {
          const pc = getComputedStyle(p);
          if (pc.overflow === "hidden" && parseFloat(pc.borderRadius) > 0) { clipped = true; break; }
        }
        if (clipped) continue;
        bad.push(el.id || el.className || el.tagName);
      }
      return [...new Set(bad)];
    });
    assertTrue(square.length === 0,
      `žádná barevná plocha bez zaoblení (${square.slice(0, 5).join(" | ") || "0"})`);
  }

  // ── Obě měřítka srážek mluví JEDNÍM jazykem ──────────────────────────────
  // 2 h se kreslilo jako sloupce s výškou podle intenzity, 12 h jako plochá
  // stuha, kde intenzitu nesl jen tón. Byly to původně dvě karty nad sebou,
  // takže mělo smysl je odlišit; jako dvě záložky JEDNOHO panelu se ale
  // nikdy neukážou naráz a rozdíl jen nutí učit se dvakrát totéž.
  // Součástí je i kontrast: suché dílky měly kdysi natvrdo bílou na 9 %,
  // což je ve světlém motivu bílá na bílé, a prostě zmizely.
  {
    const zmer = async scale => {
      await page.evaluate(sc => document.querySelector(`.pp-tab[data-scale="${sc}"]`)?.click(), scale);
      await page.waitForTimeout(250);
      return page.evaluate(sc => {
        const body = document.querySelector(`.pp-body[data-scale="${sc}"]`);
        const b = body?.querySelector(".pbars");
        const osa = body?.querySelector(".pp-axis");
        if (!b || !b.children.length) return null;
        const kids = [...b.children];
        const rgb = v => (v.match(/[\d.]+/g) || []).map(Number);
        // Porovnává se proti KARTĚ za sloupci, ne proti dráze: hledá se
        // první předek se skutečným (neprůhledným) pozadím.
        let host = b.parentElement, bg = [0, 0, 0, 0];
        while (host && (bg[3] ?? 1) < 0.5) {
          bg = rgb(getComputedStyle(host).backgroundColor);
          if ((bg[3] ?? 1) >= 0.5) break;
          host = host.parentElement;
        }
        // Poloprůhledný dílek se s pozadím SMÍCHÁ — test proto míchá stejně.
        const mix = c => {
          const a = c[3] ?? 1;
          return [0, 1, 2].map(i => c[i] * a + bg[i] * (1 - a));
        };
        const minDelta = Math.min(...kids.map(k => {
          const st = getComputedStyle(k);
          const m = mix(rgb(st.backgroundColor));
          const opa = parseFloat(st.opacity);
          const d = Math.abs(m[0] - bg[0]) + Math.abs(m[1] - bg[1]) + Math.abs(m[2] - bg[2]);
          return d * (Number.isFinite(opa) ? opa : 1);
        }));
        const cs = getComputedStyle(b);
        const prvni = getComputedStyle(kids[0]);
        return {
          trida: b.className,
          gap: cs.gap, vyska: cs.height, zarovnani: cs.alignItems,
          radius: prvni.borderRadius,
          popisku: osa ? osa.children.length : 0,
          prvniPopisek: osa?.children[0]?.textContent?.trim() || "",
          dilku: kids.length,
          minDelta,
        };
      }, scale);
    };
    const a2 = await zmer("2h");
    const a12 = await zmer("12h");
    assertTrue(a2 && a12, "obě měřítka srážek se vykreslila");
    for (const [jmeno, v] of [["2 h", a2], ["12 h", a12]]) {
      assertTrue(v.trida.includes("pbars"), `${jmeno} používá společnou třídu .pbars (${v.trida})`);
      assertTrue(v.dilku >= 6, `${jmeno} má sloupce (${v.dilku})`);
      assertTrue(v.minDelta > 8,
        `${jmeno}: každý sloupec je odlišitelný od podkladu i ve světlém motivu (${Math.round(v.minDelta)})`);
    }
    assertTrue(a2.gap === a12.gap && a2.vyska === a12.vyska
      && a2.zarovnani === a12.zarovnani && a2.radius === a12.radius,
      `obě měřítka mají stejnou geometrii sloupců (${a2.gap}/${a2.vyska}/${a2.radius}`
      + ` vs ${a12.gap}/${a12.vyska}/${a12.radius})`);
    assertTrue(a2.popisku === a12.popisku && a2.popisku >= 3,
      `obě osy mají stejný počet popisků (${a2.popisku} vs ${a12.popisku})`);
    assertTrue(a2.prvniPopisek === "teď" && a12.prvniPopisek === "teď",
      `obě osy začínají "teď" (${a2.prvniPopisek} / ${a12.prvniPopisek})`);
  }

  // ── Každý název ikony musí v sadě existovat ──────────────────────────────
  // uiIcon() u neznámého názvu vrátí prázdný řetězec. Překlep se tedy
  // neprojeví chybou, ale TICHÝM zmizením ikony — a všimne si ho leda ten,
  // kdo zrovna kouká na ten jeden panel. Test je jediná spolehlivá pojistka.
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "web", "js", "uiicons.js"), "utf8");
    const names = new Set();
    for (const line of src.split("\n")) {
      const m = line.match(/^\s*(?:'([a-zA-Z-]+)'|([a-zA-Z-]+))\s*:\s*'</);
      if (m) names.add(m[1] || m[2]);
    }
    const used = new Map();
    const files = ["web/index.html", ...fs.readdirSync(path.join(__dirname, "..", "web", "js"))
      .filter(n => n.endsWith(".js")).map(n => `web/js/${n}`)];
    for (const f of files) {
      const t = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      for (const m of t.matchAll(/uiIcon\(\s*"([a-zA-Z-]+)"/g)) used.set(m[1], f);
      for (const m of t.matchAll(/data-icon="([a-zA-Z-]+)"/g)) used.set(m[1], f);
    }
    const missing = [...used].filter(([n]) => !names.has(n)).map(([n, f]) => `${n} (${f})`);
    assertTrue(names.size > 20 && used.size > 10,
      `sada ikon i jejich použití se načetly (${names.size} / ${used.size})`);
    assertTrue(missing.length === 0,
      `každý název ikony existuje v sadě (${missing.join(", ") || "0"})`);

    // A že se opravdu vykreslily — prázdné <svg> by testem výš prošlo.
    const drawn = await page.evaluate(() => {
      const all = [...document.querySelectorAll("svg.uicon")];
      return { n: all.length, prazdne: all.filter(s => !s.children.length).length };
    });
    assertTrue(drawn.n > 5 && drawn.prazdne === 0,
      `glyfy se vykreslily a žádný není prázdný (${drawn.n}, prázdných ${drawn.prazdne})`);
  }

  // ── Akce v kartě mají jeden tvar ─────────────────────────────────────────
  // Pět tlačítek dělá totéž (Porovnat, Uložit, Zapnout upozornění, Zkušební,
  // Sdílet/Embed) a každé mělo vlastní poloměr, velikost písma, barvu textu
  // i minimální výšku. Rozdíly nic neznamenaly, jen se nasčítaly.
  {
    const acts = await page.evaluate(() => {
      const ids = ["btn-compare", "btn-fav", "btn-push", "btn-test-push", "btn-share-2", "btn-embed"];
      return ids.map(id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const s = getComputedStyle(el);
        return { id, r: s.borderRadius, fs: s.fontSize, fw: s.fontWeight, c: s.color,
                 h: Math.round(el.getBoundingClientRect().height),
                 emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(el.textContent) };
      }).filter(Boolean);
    });
    assertTrue(acts.length >= 5, `akční tlačítka se našla (${acts.length})`);
    const ref = acts[0];
    const diff = acts.filter(a => a.r !== ref.r || a.fs !== ref.fs || a.c !== ref.c);
    assertTrue(diff.length === 0,
      `akce v kartě mají jeden tvar (liší se: ${diff.map(d => d.id).join(", ") || "0"})`);
    const withEmoji = acts.filter(a => a.emoji).map(a => a.id);
    assertTrue(withEmoji.length === 0,
      `akce používají glyfy, ne emoji (${withEmoji.join(", ") || "0"})`);
  }

  // ── Dvě řady pilulek se nesmí plést ──────────────────────────────────────
  // Nad sebou byly dvě skoro identické řady: výběr veličiny u stanic
  // (Teplota · Rosný bod · …, vybíráš JEDNU) a přepínače vrstev mapy
  // (Teploty · Bouřky · …, zapínáš KOLIK CHCEŠ). Stejný tvar, stejná barva,
  // skoro stejná slova. Rozdíl teď nese tvar, a tenhle blok hlídá, že ho
  // někdo zpátky nesrovná do jedné podoby.
  {
    const shapes = await page.evaluate(() => {
      const sel = document.getElementById("layer-selector");
      const selS = getComputedStyle(sel);
      const opt = sel.querySelector(".layer-btn:not(.active)");
      const act = sel.querySelector(".layer-btn.active");
      const ctrl = document.querySelector("#radar-bar button.ctrl[data-layer], #radar-bar #btn-temps");
      const ctrlS = ctrl ? getComputedStyle(ctrl) : null;
      const opaque = v => !!v && !/rgba\(0, 0, 0, 0\)|transparent/.test(v);
      return {
        trackHasGlass: opaque(selS.backgroundColor) && selS.backdropFilter !== "none",
        optionBare: !opaque(getComputedStyle(opt).backgroundColor)
                    && getComputedStyle(opt).boxShadow === "none",
        activeFilled: opaque(getComputedStyle(act).backgroundColor),
        ctrlOwnGlass: !!ctrlS && opaque(ctrlS.backgroundColor),
        label: sel.querySelector(".ls-label")?.textContent?.trim() || null,
      };
    });
    assertTrue(shapes.trackHasGlass,
      "výběr veličiny je JEDNA spojitá dráha se společným sklem");
    assertTrue(shapes.optionBare,
      "jednotlivé volby v dráze nemají vlastní sklo (jinak vypadají jako vypínače)");
    assertTrue(shapes.activeFilled,
      "vybraná veličina je vyplněná — v dráze je právě jedna");
    assertTrue(shapes.ctrlOwnGlass,
      "přepínače vrstev naopak zůstávají volné pilulky s vlastním sklem");
    assertTrue(shapes.label === "Stanice",
      `dráha má popisek, čeho se výběr týká (${shapes.label})`);

    // A hlavně: aktivní stav obou rodin nesmí vypadat stejně.
    const same = await page.evaluate(() => {
      const a = document.querySelector("#layer-selector .layer-btn.active");
      const b = document.querySelector("#radar-bar button.ctrl.active");
      if (!b) return null;
      const ga = getComputedStyle(a), gb = getComputedStyle(b);
      return ga.backgroundColor === gb.backgroundColor && ga.color === gb.color;
    });
    assertTrue(same === false,
      "vybraná veličina a zapnutá vrstva se od sebe liší (výplň vs. prstenec)");

    if (process.env.SHOT) {
      const box = await page.locator("#layer-selector").boundingBox();
      const bar = await page.locator("#radar-bar").boundingBox();
      await page.screenshot({
        path: `${process.env.SHOT}/dve-rady.png`,
        clip: { x: box.x - 8, y: box.y - 8, width: Math.max(box.width, bar.width) + 16,
                height: (bar.y + bar.height) - box.y + 16 },
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.locator("#layer-selector").scrollIntoViewIfNeeded();
      await page.locator("#layer-selector").screenshot({ path: `${process.env.SHOT}/dve-rady-mobil.png` });
      // Odpočet v obou zabarvených stavech — tvar musí sedět v obou.
      for (const st of ["clear", "imminent"]) {
        await page.evaluate(cls => {
          const el = document.getElementById("rain-countdown");
          el.classList.remove("clear", "imminent");
          el.classList.add("show", cls);
          el.scrollIntoView();
          window.scrollBy(0, -130);   // ať nezůstane schovaný pod topbarem
        }, st);
        await page.waitForTimeout(300);
        const rc = await page.locator("#rain-countdown").boundingBox();
        if (rc) await page.screenshot({ path: `${process.env.SHOT}/rc-${st}.png`,
          clip: { x: rc.x - 14, y: rc.y - 14, width: rc.width + 28, height: rc.height + 28 } });
      }

      // Pás 12h výhledu — přepni na měřítko 12 h a vyfoť ho.
      await page.evaluate(() => {
        document.querySelector('.pp-tab[data-scale="12h"]')?.click();
        document.getElementById("precip-panel")?.scrollIntoView();
      });
      await page.waitForTimeout(400);
      const owb = await page.locator("#ow-bars").boundingBox();
      if (owb) await page.screenshot({ path: `${process.env.SHOT}/ow.png`,
        clip: { x: owb.x - 12, y: owb.y - 40, width: owb.width + 24, height: owb.height + 70 } });
      // Celá stránka na mobilu i desktopu — na jednotnost formátování se
      // nedá ptát po kouscích, musí se vidět všechno pod sebou.
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      await page.screenshot({ path: `${process.env.SHOT}/audit-mobil.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${process.env.SHOT}/audit-desktop.png`, fullPage: true });
    }
  }

  // ── Pohyb: jen první objevení a akce uživatele ───────────────────────────
  // Animace v meteo appce může snadno škodit víc, než pomůže. Data se obnovují
  // co pět minut — kdyby se u každého obnovení něco hýbalo, stránka by trhala
  // sama od sebe. A napočítávání čísel je u naměřených hodnot přímo špatně:
  // než teplota "dojede" na 22, appka dvě vteřiny ukazuje hodnoty, které nikdo
  // nenaměřil.
  {
    const m = await page.evaluate(async () => {
      const mot = await import("./js/motion.js");
      const pred = document.querySelectorAll(".rise-in").length;
      // Druhé zavolání musí být no-op — přesně to je "jen první objevení".
      const znovu = mot.riseIn();
      return {
        nabehlo: pred,
        podruhe: znovu,
        maRozestup: [...document.querySelectorAll(".rise-in")]
          .some(el => el.style.getPropertyValue("--rise-i") !== "0"),
        // Animace grafu taky jen poprvé.
        grafPoprve: !!mot.chartAnim("test-klic"),
        grafPodruhe: mot.chartAnim("test-klic"),
      };
    });
    assertTrue(m.nabehlo > 3, `panely při prvním vykreslení nabíhají (${m.nabehlo})`);
    assertTrue(m.podruhe === 0,
      `obnovení dat už nic nerozhýbe (druhé volání přidalo ${m.podruhe} panelů)`);
    assertTrue(m.maRozestup, "panely nabíhají po sobě, ne všechny naráz");
    assertTrue(m.grafPoprve && m.grafPodruhe === false,
      "graf se animuje jen při prvním vykreslení");

    // Napočítávání čísel v appce být nesmí — hodnota se objeví hotová.
    const hero = await page.evaluate(() => {
      const el = document.querySelector(".fc-temp-big, .tile-v");
      return el ? el.textContent.trim() : null;
    });
    assertTrue(hero && !/^0[°\s]*$/.test(hero),
      `číslo se objeví hotové, ne odpočítané od nuly ("${hero}")`);

    // A při zapnutém prefers-reduced-motion se nesmí hýbat nic.
    const rm = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block" });
    const prm = await rm.newPage();
    const bezPohybu = await prm.evaluate(async () => true).catch(() => true);
    await prm.goto(`${base}/?lat=50.09&lon=14.40&q=TestObec`, { waitUntil: "load" });
    await prm.waitForTimeout(1200);
    const klid = await prm.evaluate(async () => {
      const mot = await import("./js/motion.js");
      return {
        redukce: mot.reducedMotion(),
        nabehlo: document.querySelectorAll(".rise-in").length,
        graf: mot.chartAnim("cokoli"),
      };
    });
    assertTrue(klid.redukce, "prefers-reduced-motion se rozpozná");
    assertTrue(klid.nabehlo === 0 && klid.graf === false,
      `při prefers-reduced-motion se nehýbe nic (${klid.nabehlo} panelů, graf ${klid.graf})`);
    void bezPohybu;
    await rm.close();
  }

  // ── Rozklik dne v týdnu ─────────────────────────────────────────────────
  // První verze přepínala HORNÍ proužek hodin a meteogram. Vypadalo to čistě,
  // ale při skutečném použití se ukázalo, proč to nefunguje: týden je na konci
  // svitku, takže se klepne dole a jediné, co se změní, je o dvě obrazovky
  // výš. Výsledek vlastního kliknutí nebyl vidět a muselo se rolovat zpátky.
  // Detail se proto rozbaluje PŘÍMO POD ŘÁDKEM — a když to umí, není proč
  // mít proužek a meteogram zvlášť: dnešek je prostě první rozbalený den.
  {
    const zaklad = await page.evaluate(() => {
      const dnes = new Date().toLocaleString("sv-SE").slice(0, 10);
      const otevreny = document.querySelector("#fc7-grid .fc7-day.fc7-open");
      return {
        radku: document.querySelectorAll("#fc7-grid .fc7-day").length,
        klikatelne: [...document.querySelectorAll("#fc7-grid .fc7-day")]
          .every(d => d.getAttribute("role") === "button" && d.dataset.date),
        detailOtevren: !!document.getElementById("fc7-detail"),
        otevrenyDen: otevreny?.dataset.date || "",
        dnes,
        zalozek: document.querySelectorAll("#fc7d-tabs .mtab").length,
        vetruUHodin: document.querySelectorAll("#fc7-detail .fc7d-hw").length,
        shrnuti: document.querySelector("#fc7-detail .fc7d-meta")?.textContent?.trim() || "",
      };
    });
    assertTrue(zaklad.radku >= 5, `týden má řádky (${zaklad.radku})`);
    assertTrue(zaklad.klikatelne, "každý den v týdnu je tlačítko s datem");
    // Bez proužku "Dnes" nad týdnem je tohle JEDINÉ místo s hodinovou
    // předpovědí — nesmí se na ni čekat s klikáním.
    assertTrue(zaklad.detailOtevren && zaklad.otevrenyDen === zaklad.dnes,
      `dnešek je rozbalený hned po načtení (${zaklad.otevrenyDen} vs ${zaklad.dnes})`);
    // Detail musí umět všechno po zrušeném meteogramu, jinak by sloučení
    // znamenalo ztrátu funkcí.
    assertTrue(zaklad.zalozek === 5,
      `graf dne má všechny záložky meteogramu (${zaklad.zalozek})`);
    assertTrue(zaklad.vetruUHodin >= 6,
      `hodiny nesou i vítr, jako dřív proužek Dnes (${zaklad.vetruUHodin})`);
    assertTrue(/°C/.test(zaklad.shrnuti) && /\d/.test(zaklad.shrnuti),
      `detail má shrnutí dne (${zaklad.shrnuti})`);

    const po = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fc7-grid .fc7-day")];
      const cil = rows.find(r => r.dataset.date !== rows[0].dataset.date);
      cil.click();
      await new Promise(r => setTimeout(r, 500));
      const box = document.getElementById("fc7-detail");
      return {
        cilDatum: cil.dataset.date,
        jeTam: !!box,
        // Klíčová vlastnost: detail musí být HNED POD tím řádkem, na který se
        // klepnulo — ne někde jinde na stránce.
        hnedPod: box ? cil.nextElementSibling === box : false,
        fazi: box ? box.querySelectorAll(".fc7d-phase").length : 0,
        hodin: box ? box.querySelectorAll(".fc7d-hour").length : 0,
        graf: box ? box.querySelectorAll("canvas").length : 0,
        nadpisDetailu: box?.querySelector(".fc7d-title")?.textContent?.trim() || "",
        oteviraJeden: document.querySelectorAll(".fc7-day.fc7-open").length,
        aria: cil.getAttribute("aria-expanded"),
      };
    });
    assertTrue(po.jeTam && po.hnedPod,
      "detail se rozbalí HNED POD řádkem, na který se klepnulo");
    assertTrue(po.fazi >= 2, `detail nese fáze dne (${po.fazi})`);
    assertTrue(po.hodin >= 12, `detail nese hodiny celého dne (${po.hodin})`);
    assertTrue(po.graf === 1, `detail má vlastní graf (${po.graf})`);
    assertTrue(/\d/.test(po.nadpisDetailu), `detail je pojmenovaný (${po.nadpisDetailu})`);
    assertTrue(po.oteviraJeden === 1, `rozbalený je právě jeden den (${po.oteviraJeden})`);
    assertTrue(po.aria === "true", "rozbalený řádek to hlásí přes aria-expanded");

    // Záložky grafu musí graf opravdu překreslit — jinak by z meteogramu
    // zbyly jen ozdobné knoflíky.
    const zalozka = await page.evaluate(async () => {
      const btn = document.querySelector('#fc7d-tabs .mtab[data-mode="wind"]');
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const { openDayDetail } = await import("./js/forecast.js");
      return {
        aktivni: document.querySelector("#fc7d-tabs .mtab.active")?.dataset.mode,
        graf: document.querySelectorAll("#fc7-detail canvas").length,
        denZustal: openDayDetail(),
      };
    });
    assertTrue(zalozka.aktivni === "wind" && zalozka.graf === 1,
      `přepnutí záložky grafu funguje (${zalozka.aktivni}, pláten ${zalozka.graf})`);
    assertTrue(zalozka.denZustal === po.cilDatum,
      `přepnutí záložky nezavře den (${zalozka.denZustal})`);

    // Ensemble se dřív stahoval DVAKRÁT: jednou pro vějíř v týdnu (7 dní)
    // a podruhé při kliknutí na záložku meteogramu (2 dny). Stejná data,
    // kratší horizont, druhá cesta po drátě. Teď je to jedno stažení, takže
    // vějíř musí jít vykreslit i pro den, na který dřív nedosáhl.
    const ens = await page.evaluate(async () => {
      document.querySelector('#fc7d-tabs .mtab[data-mode="ensemble"]').click();
      await new Promise(r => setTimeout(r, 500));
      return {
        graf: document.querySelectorAll("#fc7-detail canvas").length,
        ceka: !!document.getElementById("fc7d-note"),
      };
    });
    assertTrue(ens.graf === 1 && !ens.ceka,
      `vějíř ensemble se vykreslí bez druhého stažení (pláten ${ens.graf}, čeká=${ens.ceka})`);

    // Segment "Dnes" musí dnešek doopravdy ukázat. Po zrušení proužku "Dnes"
    // je jeho jediné bydliště rozbalený detail dneška — kdyby zůstal
    // rozbalený pátek, odskočila by navigace na cizí den.
    const naDnes = await page.evaluate(async () => {
      document.querySelector('#secnav button[data-sec="today"]').click();
      await new Promise(r => setTimeout(r, 500));
      const otevreny = document.querySelector("#fc7-grid .fc7-day.fc7-open");
      return {
        den: otevreny?.dataset.date || "",
        dnes: new Date().toLocaleString("sv-SE").slice(0, 10),
      };
    });
    assertTrue(naDnes.den === naDnes.dnes,
      `segment Dnes rozbalí dnešek (${naDnes.den} vs ${naDnes.dnes})`);

    // Druhé klepnutí zavírá, klepnutí na jiný den přepíná (harmonika).
    const prepnuti = await page.evaluate(async () => {
      const rows = [...document.querySelectorAll("#fc7-grid .fc7-day")];
      const prvni = rows.find(r => r.classList.contains("fc7-open"));
      const jiny = rows.find(r => !r.classList.contains("fc7-open") && r.dataset.date);
      jiny.click();
      await new Promise(r => setTimeout(r, 400));
      const poPrepnuti = {
        otevrenych: document.querySelectorAll(".fc7-day.fc7-open").length,
        hnedPod: document.getElementById("fc7-detail")
          ? jiny.nextElementSibling === document.getElementById("fc7-detail") : false,
      };
      jiny.click();   // druhé klepnutí na týž den = zavřít
      await new Promise(r => setTimeout(r, 300));
      return { ...poPrepnuti, poZavreni: !!document.getElementById("fc7-detail"), void: !!prvni };
    });
    assertTrue(prepnuti.otevrenych === 1 && prepnuti.hnedPod,
      `klepnutí na jiný den detail přesune, neotevře druhý (${prepnuti.otevrenych})`);
    assertTrue(!prepnuti.poZavreni, "druhé klepnutí na týž den detail zavře");
  }

  // ── Historie měsíce v detailu stanice ────────────────────────────────────
  // Modul chmi_stats.py si měsíční soubory ČHMÚ za celé období měření stahoval
  // odjakživa, ale dělal z nich jen rekordy a 30letý normál — samotnou řadu
  // zahodil. Normál řekne, jaký je srpen průměrně; neřekne, že posledních
  // deset srpnů bylo nad ním. Tenhle blok hlídá, že se řada opravdu dostane
  // až na obrazovku a že věta nad grafem odpovídá datům.
  {
    const st = await page.evaluate(async id => {
      const { openChmiDetail } = await import("./js/stations.js");
      await openChmiDetail(id);
      // přepni na záložku Historie
      const btn = [...document.querySelectorAll(".chmi-tab-btn")]
        .find(b => b.dataset.tab === "historie");
      btn?.click();
      await new Promise(r => setTimeout(r, 600));
      const body = document.getElementById("chmi-tab-content");
      const sel = document.getElementById("hist-month");
      return {
        tabIsThere: !!btn,
        mesicu: sel ? sel.options.length : 0,
        vybrano: sel ? Number(sel.value) : null,
        rozsah: body.querySelector(".hist-range")?.textContent?.trim() || "",
        velicin: document.getElementById("hist-key")?.options.length || 0,
        velicinyText: [...(document.getElementById("hist-key")?.options || [])]
          .map(o => o.textContent).join(" | "),
        rekord: body.querySelector(".hist-rec")?.textContent?.replace(/\s+/g, " ").trim() || "",
        veta: body.querySelector(".hist-verdict")?.textContent?.replace(/\s+/g, " ").trim() || "",
        grafu: body.querySelectorAll("canvas").length,
      };
    }, "0-20000-0-11518");

    assertTrue(st.tabIsThere, "detail stanice má záložku Historie měsíce");
    assertTrue(st.mesicu === 12, `dá se vybrat kterýkoli měsíc (${st.mesicu})`);
    assertTrue(st.vybrano === new Date().getMonth() + 1,
      `nativně je vybraný aktuální měsíc (${st.vybrano})`);
    assertTrue(/1961–2025 · 65 let/.test(st.rozsah),
      `ukazuje rozsah řady (${st.rozsah})`);
    assertTrue(st.grafu >= 1, `vykreslil se graf (${st.grafu})`);
    // Stanice měří až deset veličin — dřív se ukládaly a kreslily jen dvě.
    assertTrue(st.velicin >= 6, `dají se vybrat všechny měřené veličiny (${st.velicin})`);
    assertTrue(/Absolutní maximum/.test(st.velicinyText)
      && /Sluneční svit/.test(st.velicinyText),
      `v nabídce jsou i extrémy a svit, ne jen průměry (${st.velicinyText.slice(0, 70)})`);
    assertTrue(/v roce \d{4}/.test(st.rekord),
      `ukazuje rekord řady i s rokem ("${st.rekord.slice(0, 70)}")`);
    // Věta je to jediné, co z grafu udělá odpověď — musí říct o kolik a kam.
    assertTrue(/°C (nad|pod)/.test(st.veta) && /průměrem let/.test(st.veta),
      `věta říká odchylku od dlouhodobého průměru ("${st.veta.slice(0, 90)}")`);
    assertTrue(!/\d+\.\d+/.test(st.veta), `čísla ve větě jsou s čárkou ("${st.veta.slice(0, 60)}")`);

    // Přepnutí měsíce musí řadu opravdu přepočítat, ne jen přebarvit popisek.
    const jiny = await page.evaluate(async () => {
      const sel = document.getElementById("hist-month");
      const pred = document.querySelector(".hist-verdict")?.textContent;
      sel.value = String(((Number(sel.value) + 5) % 12) + 1);
      sel.dispatchEvent(new Event("change"));
      await new Promise(r => setTimeout(r, 500));
      return { pred, po: document.querySelector(".hist-verdict")?.textContent };
    });
    assertTrue(jiny.pred && jiny.po && jiny.pred !== jiny.po,
      "přepnutí měsíce přepočítá řadu i větu");

    const jinaVel = await page.evaluate(async () => {
      const sel = document.getElementById("hist-key");
      const pred = document.querySelector(".hist-verdict")?.textContent;
      sel.value = "precip_SUM";
      sel.dispatchEvent(new Event("change"));
      await new Promise(r => setTimeout(r, 500));
      return { pred, po: document.querySelector(".hist-verdict")?.textContent,
               nadpis: document.querySelector(".chmi-chart-block h4")?.textContent || "" };
    });
    assertTrue(jinaVel.pred !== jinaVel.po && /mm/.test(jinaVel.po || ""),
      `přepnutí veličiny přepočítá řadu i jednotku ("${(jinaVel.po || "").slice(0, 60)}")`);
    assertTrue(/Úhrn srážek/.test(jinaVel.nadpis),
      `nadpis grafu jde za vybranou veličinou (${jinaVel.nadpis})`);

    if (process.env.SHOT) {
      await page.evaluate(async () => {
        const sel = document.getElementById("hist-month");
        sel.value = "8"; sel.dispatchEvent(new Event("change"));
        await new Promise(r => setTimeout(r, 600));
      });
      await page.locator("#chmi-detail").screenshot({ path: `${process.env.SHOT}/historie.png` });
    }

    await page.evaluate(async () => {
      const { closeChmiDetail } = await import("./js/stations.js");
      closeChmiDetail();
    });
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

  // ── Ovládání mapy nesmí ukrojit půlku mobilu ─────────────────────────────
  // Dok zabíral s přepínači vrstev a výběrem veličiny skoro třetinu obrazovky:
  // osa na vlastním řádku, pod ní přehrávání a pod tím sedm vrstev zalomených
  // do dvou až tří řad po 44 px. Je to ovládání mapy, ne obsah — nesmí
  // soutěžit s tím, kvůli čemu je appka otevřená.
  {
    const dockUp = await waitForAsync(pageM, () => {
      const el = document.getElementById("radar-bar");
      return !!el && getComputedStyle(el).display !== "none"
             && el.getBoundingClientRect().height > 20;
    }, 8000);
    assertTrue(dockUp, "dok radaru se na mobilu vykreslil");

    const dock = await pageM.evaluate(() => {
      const h = id => {
        const el = document.getElementById(id);
        if (!el || getComputedStyle(el).display === "none") return 0;
        return el.getBoundingClientRect().height;
      };
      const rows = [...document.querySelectorAll("#radar-bar .radar-row")]
        .filter(r => getComputedStyle(r).display !== "none");
      const lay = document.getElementById("radar-row-layers");
      return {
        total: h("radar-bar") + h("layer-selector") + h("radar-legend"),
        vh: window.innerHeight,
        playRow: rows[0] ? rows[0].getBoundingClientRect().height : 0,
        layH: lay ? lay.getBoundingClientRect().height : 0,
        layScrolls: !!lay && lay.scrollWidth > lay.clientWidth + 4,
      };
    });
    assertTrue(dock.total > 0 && dock.total < dock.vh * 0.22,
      `ovládání mapy zabírá pod pětinu obrazovky (${Math.round(dock.total)} z ${dock.vh} px)`);
    assertTrue(dock.playRow > 0 && dock.playRow < 60,
      `řádek přehrávače se nezalamuje — osa se smrskne (${Math.round(dock.playRow)} px)`);
    assertTrue(dock.layScrolls && dock.layH < 60,
      `vrstvy jsou JEDNA vodorovná dráha (${Math.round(dock.layH)} px, roluje=${dock.layScrolls})`);
  }

  // ── Obnova nesmí sežrat vyhledávací pole ─────────────────────────────────
  // #btn-refresh si po dokončení přepsal textContent na "↺ Aktualizovat".
  // V topbaru je sedm prvků a jediný pružný je vyhledávací pole, takže se
  // o tu šířku připravilo ono — na mobilu z něj zbylo "Hle". Obnovu spouští
  // i návrat do popředí, takže se to dělo prakticky při každém použití; jen
  // ne při čerstvém načtení, což je přesně to, co testy uměly.
  {
    const w = () => pageM.evaluate(() =>
      document.getElementById("search").getBoundingClientRect().width);
    const before = await w();
    await pageM.click("#btn-refresh");
    await pageM.waitForFunction(
      () => !document.getElementById("btn-refresh").classList.contains("spinning"),
      null, { timeout: 8000 });
    await pageM.waitForTimeout(200);
    const after = await w();
    const btnText = await pageM.evaluate(() =>
      document.getElementById("btn-refresh").textContent.trim());
    assertTrue(after >= before - 1,
      `vyhledávací pole po obnově nezúžilo (${Math.round(before)} → ${Math.round(after)} px)`);
    assertTrue(after > 90, `vyhledávací pole má použitelnou šířku (${Math.round(after)} px)`);
    assertTrue(btnText === "↺",
      `tlačítko obnovy zůstalo ikonou, nezměnilo se v text ("${btnText}")`);
  }

  assertTrue(errorsM.length === 0, `žádné JS chyby na mobilní šířce (nalezeno ${errorsM.length})`);
  await mobile.close();

  // ── Modely pro tohle místo: panel + učící se verifikace ───────────────────
  const pageMod = await context.newPage();
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
    const { thinByZoom, stationRank, cellSizeDeg, capForBounds } =
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
      // Strop teď rozhoduje PLOCHA výřezu, ne zoom. Dřív to byla tabulka
      // podle zoomu a při zoomu 5 dávala 18 popisků — jenže zoom 5 je pohled
      // na Rakousko i na půlku zeměkoule, takže na světové mapě z šesti tisíc
      // stanic zbylo osmnáct a vypadalo to jako chybějící data.
      capBySize: {
        malyVyrez: capForBounds(49, 14, 51, 19, 7),
        velkyVyrez: capForBounds(-60, -180, 75, 180, 3),
        // Stejný zoom, větší plocha → víc popisků. (Porovnávat výřezy při
        // RŮZNÉM zoomu nemá smysl: s přiblížením se zmenší i buňka, takže
        // počet buněk na obrazovku zůstává zhruba stejný — a to je správně.)
        stejnyZoomVetsiPlocha: capForBounds(35, -10, 60, 30, 7),
        strop: capForBounds(-89, -180, 89, 180, 12),
      },
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
  assertTrue(thin.cellShrinks, "buňka se se zoomem zmenšuje");
  assertTrue(thin.capBySize.velkyVyrez > thin.capBySize.malyVyrez,
    `větší výřez dovolí víc popisků než menší (svět ${thin.capBySize.velkyVyrez} > ČR ${thin.capBySize.malyVyrez})`);
  assertTrue(thin.capBySize.velkyVyrez >= 200,
    `na světové mapě není strop hrstka (${thin.capBySize.velkyVyrez})`);
  assertTrue(thin.capBySize.stejnyZoomVetsiPlocha > thin.capBySize.malyVyrez,
    `při stejném zoomu dostane větší plocha vyšší strop (${thin.capBySize.stejnyZoomVetsiPlocha} > ${thin.capBySize.malyVyrez})`);
  assertTrue(thin.capBySize.strop <= 400,
    `tvrdý strop drží i pro nesmyslně velký výřez (${thin.capBySize.strop})`);
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

  // ── Jednotné formátování — hlídá stupnice, ne konkrétní čísla ────────────
  // Appka měla 48 různých velikostí písma mezi .52rem a 3.7rem a sedm
  // poloměrů mezi 8 a 18 px. Vzniklo to poctivě: každý panel se ladil zvlášť
  // a pokaždé se trefil "skoro" jako sousedi. Rozdíl dvou setin rem ale oko
  // nepřečte jako záměr, jen jako nepořádek. Tenhle test drží stupnici —
  // nová velikost se musí přidat jako token, ne jako výjimka v jednom
  // pravidle. Čte se přímo zdroj, prohlížeč k tomu není potřeba.
  {
    const cssPath = path.join(__dirname, "..", "web", "css", "app.css");
    const css = fs.readFileSync(cssPath, "utf8");
    // Komentáře pryč: popisují i to, co se ODSTRANILO ("dřív tu bylo
    // var(--glass-border)"), a scan by na tom zůstal viset navždy.
    const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, "");
    const body = strip(css.slice(css.indexOf("--r-pill: 999px;")));   // za definicí tokenů

    const rawFs = [...body.matchAll(/font-size:\s*([\d.]+)(rem|px|em)\b/g)].map(m => m[0]);
    assertTrue(rawFs.length === 0,
      `žádná velikost písma mimo stupnici (${rawFs.slice(0, 4).join(", ") || "0"})`);

    // Poloměry: povolené jsou tokeny, pilulka a proužky do 4 px (tam je
    // poloměr prostě půlka výšky, ne rozhodnutí o tvaru).
    const rawR = [...body.matchAll(/border-radius:\s*([\d.]+)px/g)]
      .map(m => parseFloat(m[1])).filter(v => v > 4 && v !== 999);
    assertTrue(rawR.length === 0,
      `žádný poloměr mimo stupnici (${rawR.slice(0, 5).join(", ") || "0"})`);

    // Natvrdo zapsaná bílá/černá jako POZADÍ funguje jen v jednom motivu.
    // Přesně na tom zmizel suchý konec pásu 12h výhledu: rgba(255,255,255,.09)
    // je ve tmě decentní šeď, ve světlém motivu bílá na bílé. Pět z šestnácti
    // úseků nebylo vidět a vypadalo to jako chybějící data. Barvy pozadí proto
    // musí jít přes tokeny, které mají obě varianty. Výjimka: clona pod
    // modálním oknem má ztmavovat vždy.
    {
      const bad = [];
      for (const m of body.matchAll(/background(?:-color)?:\s*([^;}]*rgba?\(\s*(?:255,\s*255,\s*255|0,\s*0,\s*0)[^)]*\)[^;}]*)/g)) {
        if (/inset\s*:\s*0/.test(body.slice(Math.max(0, m.index - 160), m.index))) continue;  // clona modálu
        bad.push(m[1].trim().slice(0, 60));
      }
      assertTrue(bad.length === 0,
        `žádné pozadí natvrdo bílé/černé mimo clonu modálu (${bad.join(" | ") || "0"})`);
    }

    // Proměnná, která neexistuje, tiše shodí celou deklaraci. Tři panely tak
    // přišly o ohraničení kvůli `var(--glass-border)` (prstenec se jmenuje
    // --gring) a nikde to nekřičelo — jen vypadaly jinak než sousedi.
    const defined = new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
    for (const m of strip(css).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
    const ghosts = [...new Set([...body.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)]
      .map(m => m[1]).filter(v => !defined.has(v)))];
    assertTrue(ghosts.length === 0,
      `žádná CSS proměnná bez definice (${ghosts.join(", ") || "0"})`);

    // A totéž v šablonách — inline styl je jen jiné místo pro stejný nepořádek.
    const inlineHits = [];
    for (const f of ["web/index.html", ...fs.readdirSync(path.join(__dirname, "..", "web", "js"))
        .filter(n => n.endsWith(".js")).map(n => `web/js/${n}`)]) {
      const t = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      for (const m of t.matchAll(/font-size:\s*([\d.]+)(rem|px|em)\b/g)) inlineHits.push(`${f}: ${m[0]}`);
    }
    assertTrue(inlineHits.length === 0,
      `žádná velikost písma napevno v šablonách (${inlineHits.slice(0, 3).join("; ") || "0"})`);
  }

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
