// Sonda na NASAZENÝ web. Odpovídá na dvě konkrétní stížnosti:
//   1) "web píše, že poslední aktualizace dat byla před 5 hodinami"
//   2) "nechce určit mou polohu ani na mobilu ani na desktopu"
//
// Proč Playwright a ne curl: první stížnost může být daty (server publikuje
// staré) NEBO kódem (appka se nepřekresluje). Druhá je čistě běhová — geolokaci
// nejde ověřit stažením souboru. Sonda proto spustí opravdový prohlížeč proti
// opravdovému nasazení, povolí geolokaci a vypíše, co appka udělá.
//
// Spouští se z .github/workflows/probe-live.yml (z runneru je Pages dosažitelné,
// z mého sandboxu ne).

import { chromium } from "playwright";

const SITE = process.env.SITE || "https://itsjakubmazur.github.io/nowcast/";
const LAT = 49.86, LON = 18.36; // Rychvald

function age(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: LAT, longitude: LON },
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
  });
  const page = await ctx.newPage();

  const errors = [];
  const failed = [];
  page.on("pageerror", e => errors.push(`${e.message}\n    ${(e.stack || "").split("\n")[1] || ""}`));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("requestfailed", r => failed.push(`${r.url()} — ${r.failure()?.errorText}`));
  page.on("response", r => {
    if (r.status() >= 400 && new URL(r.url()).host.includes("github.io")) {
      failed.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  console.log(`=== Sonda nasazeného webu — ${new Date().toISOString()} ===`);
  console.log(`URL: ${SITE}\n`);

  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(12000); // ať doběhnou fetche a vykreslení

  // ── 1. Stáří dat: co je v manifestu vs. co appka ukazuje ───────────────────
  const data = await page.evaluate(async () => {
    const r = await fetch(`data/radar_manifest.json?probe=${Date.now()}`, { cache: "no-store" });
    const m = await r.json();
    return {
      generated: m.generated_at_utc,
      observed: m.observed_utc || m.frames?.find(f => f.kind === "maxz")?.time_utc || null,
      etag: r.headers.get("etag"),
      cacheControl: r.headers.get("cache-control"),
      served: r.headers.get("date"),
    };
  });
  console.log("--- publikovaná data ---");
  console.log(`  generated_at_utc: ${data.generated}  → stáří ${age(data.generated)?.toFixed(0)} min`);
  console.log(`  pozorování:       ${data.observed}  → stáří ${age(data.observed)?.toFixed(0)} min`);
  console.log(`  cache-control:    ${data.cacheControl}`);
  console.log(`  etag:             ${data.etag}`);
  console.log(`  Date hlavička:    ${data.served}`);
  if ((age(data.generated) ?? 0) > 20) {
    console.log("  ✗ SERVER publikuje stará data → chyba je v pipeline/deployi, ne v appce");
  } else {
    console.log("  ✓ server publikuje čerstvá data");
  }

  const shown = await page.evaluate(() => ({
    refresh: document.getElementById("refresh-time")?.textContent?.trim(),
    place: document.getElementById("place")?.textContent?.trim(),
    dist: document.getElementById("dist")?.textContent?.trim(),
  }));
  console.log("\n--- co appka ukazuje ---");
  console.log(`  #refresh-time: ${shown.refresh}`);
  console.log(`  #place:        ${shown.place}`);
  console.log(`  #dist:         ${shown.dist}`);

  // ── 2. Geolokace ──────────────────────────────────────────────────────────
  // Nejdřív, jestli init() vůbec došel na konec. Kdyby po vykreslení dat něco
  // spadlo, tlačítka za tím místem by zůstala nezapojená — a přesně to by
  // vypadalo jako "appka jde, ale polohu neurčí".
  const wiring = await page.evaluate(() => ({
    hasGeo: !!document.getElementById("geo"),
    geoDisabled: document.getElementById("geo")?.disabled,
    geoText: document.getElementById("geo")?.textContent?.trim(),
    hasSecureContext: window.isSecureContext,
    hasGeolocation: !!navigator.geolocation,
    initDone: !!window.__nowcastInitDone,   // značka z app.js (může chybět u starší verze)
  }));
  console.log("\n--- prostředí pro geolokaci ---");
  console.log(JSON.stringify(wiring, null, 2));

  // Přímý dotaz na Geolocation API, obejde appku — odpoví, jestli je problém
  // v prohlížeči/prostředí, nebo v našem kódu.
  const raw = await page.evaluate(() => new Promise(res => {
    const t0 = Date.now();
    navigator.geolocation.getCurrentPosition(
      p => res({ ok: true, ms: Date.now() - t0, lat: p.coords.latitude, lon: p.coords.longitude }),
      e => res({ ok: false, ms: Date.now() - t0, code: e.code, message: e.message }),
      { timeout: 10000 },
    );
  }));
  console.log("\n--- navigator.geolocation napřímo ---");
  console.log(JSON.stringify(raw));

  // A teď přes tlačítko, jak to dělá uživatel.
  const before = await page.evaluate(() => document.getElementById("place")?.textContent);
  await page.click("#geo").catch(e => console.log("  klik na #geo selhal: " + e.message));
  await page.waitForTimeout(8000);
  const after = await page.evaluate(() => ({
    place: document.getElementById("place")?.textContent?.trim(),
    dist: document.getElementById("dist")?.textContent?.trim(),
    geoText: document.getElementById("geo")?.textContent?.trim(),
    toast: document.getElementById("toast")?.textContent?.trim(),
    toastShown: document.getElementById("toast")?.classList.contains("show"),
  }));
  console.log("\n--- po kliknutí na 📍 ---");
  console.log(`  #place před: ${before?.trim()}`);
  console.log(`  #place po:   ${after.place}`);
  console.log(`  #dist:       ${after.dist}`);
  console.log(`  tlačítko:    ${after.geoText}`);
  console.log(`  toast:       ${after.toastShown ? after.toast : "(žádný)"}`);
  if (after.place === before?.trim()) {
    console.log("  ✗ poloha se NEPROJEVILA — tady je ta chyba");
  } else {
    console.log("  ✓ poloha se projevila");
  }

  // ── 3. Chyby a 404 ───────────────────────────────────────────────────────
  console.log("\n--- chyby v konzoli ---");
  const real = errors.filter(e => !/favicon|blitzortung|rainviewer/i.test(e));
  if (!real.length) console.log("  (žádné)");
  real.forEach(e => console.log("  ✗ " + e));

  console.log("\n--- neúspěšné requesty ---");
  if (!failed.length) console.log("  (žádné)");
  [...new Set(failed)].slice(0, 25).forEach(f => console.log("  ✗ " + f));

  // ── 4. Verze nasazeného kódu ─────────────────────────────────────────────
  // Když se stáří dat neshoduje s tím, co pipeline vyrobila, je otázka, jestli
  // Pages neservíruje starší build. Hash app.js to rozhodne.
  const jsHash = await page.evaluate(async () => {
    const r = await fetch(`js/app.js?probe=${Date.now()}`, { cache: "no-store" });
    const buf = await r.arrayBuffer();
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  });
  console.log(`\n--- nasazený kód ---\n  sha256(js/app.js) = ${jsHash}`);

  await browser.close();
}

main().catch(e => { console.error("Sonda spadla:", e); process.exit(1); });
