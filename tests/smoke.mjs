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
  const ids = ["icon_seamless", "ecmwf_ifs025", "gfs_seamless", "meteofrance_seamless", "ukmo_seamless"];
  const hourly = { time: [...om.hourly.time] };
  ids.forEach((id, k) => {
    hourly[`temperature_2m_${id}`] = om.hourly.temperature_2m.map(t => t + (k - 2) * 0.7);
    hourly[`precipitation_${id}`] = om.hourly.precipitation.map(p => p * (1 + k * 0.1));
  });
  return { hourly, timezone: "Europe/Prague" };
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

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
  for (const name of ["chmi_stations.json", "wu_stations.json"]) {
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
  await page.route("https://ensemble-api.open-meteo.com/**", route =>
    route.fulfill({ body: "{}", contentType: "application/json" }));
  // leaflet-velocity je self-hosted (web/vendor/) — reálná knihovna potřebuje
  // plný Leaflet, který stub neposkytuje; pro test stačí minimální náhrada.
  await page.route("**/vendor/leaflet-velocity.min.js", route =>
    route.fulfill({ path: path.join(FIXTURES, "velocity-stub.js"), contentType: "text/javascript" }));
  await page.route("https://*.workers.dev/vapid-public-key**", route =>
    route.fulfill({ body: JSON.stringify({ publicKey: "BM60k6heLK2a7KNELX05p5_Wpv1zhUbB2JFLMLVz13uirAVfjkCtoksQ7bdQIMd5hqvwUTwPUWUGfhFm0KkhF3Y" }), contentType: "application/json" }));
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
  const chipText = await page.textContent(".warn-chip");
  assertTrue(chipText.includes("Bouřky"), `výstražný chip "Bouřky" se zobrazil (obsah: "${chipText}")`);

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
