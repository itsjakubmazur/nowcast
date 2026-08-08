// Doplňkové panely v2.0 — minutový graf srážek, aktivitní indexy,
// "včera vs. dnes", astro a zimní podmínky. Všechno počítané z dat,
// která už stahujeme (grid série + Open-Meteo hourly/daily).

import { state } from "./state.js";
import { esc, num, revealSwap, nowLocStr, haversine, ageMinutes } from "./utils.js";
import { moonIconImg, wImg, wcIconSvg, mostSevere } from "./icons.js";
import { uiIcon } from "./uiicons.js";
import { computeNight } from "./stargaze.js";
import { nearestFreshStation } from "./models.js";
import { precipBarsHtml, precipAxisHtml, precipSummary, WET_RATE } from "./precipbars.js";

function locMonth() {
  return +new Date().toLocaleString("sv-SE", { timeZone: state.tz }).slice(5, 7);
}

// ── Minutový graf srážek 0–120 min ───────────────────────────────────────────
// Primárně z naší radarové extrapolace (grid.series per bod, krok 10 min),
// fallback na Open-Meteo minutely_15 (krok 15 min, přemapovaný na 10min sloty).
// ── Sdílený panel srážek (2 h / 12 h) ──────────────────────────────────────
// Dvě těla, dva zdroje dat, jeden panel. Viditelnost proto nemůže řešit každá
// vykreslovací funkce sama — musely by o sobě vědět. Každá jen označí své tělo
// příznakem a tenhle koordinátor rozhodne za obě.

export // Výchozí měřítko a poslední volba uživatele. Bez zapamatování by sync po
// každém překreslení vracel panel na 2 h a přepnutí na 12 h by "nedrželo".
const PREFERRED_SCALE = "2h";
let _userScale = null;

export function markPrecipBody(scale, hasData) {
  const body = document.querySelector(`#precip-panel .pp-body[data-scale="${scale}"]`);
  if (body) body.dataset.has = hasData ? "1" : "0";
  syncPrecipPanel();
}

export function syncPrecipPanel() {
  const panel = document.getElementById("precip-panel");
  const track = document.getElementById("pp-track");
  if (!panel || !track) return;
  const bodies = [...track.querySelectorAll(".pp-body")];
  const withData = bodies.filter(b => b.dataset.has === "1");
  // Karta se ukáže i tehdy, když má co říct jen odpočet. Po sloučení je
  // odpočet její hlavou, takže skrytí panelu kvůli prázdnému grafu by
  // umlčelo i větu "Právě lije" — což je ta nejdůležitější informace v appce.
  const headSpeaks = document.getElementById("rain-countdown")?.classList.contains("show");
  panel.classList.toggle("show", withData.length > 0 || !!headSpeaks);

  // Prázdné měřítko z dráhy úplně zmizí — jinak by šlo přejet na prázdno.
  bodies.forEach(b => { b.hidden = b.dataset.has !== "1"; });
  panel.querySelectorAll(".pp-tab").forEach(tab => {
    const body = track.querySelector(`.pp-body[data-scale="${tab.dataset.scale}"]`);
    tab.disabled = body?.dataset.has !== "1";
  });
  // Přejíždět jde jen když jsou obě měřítka k dispozici.
  panel.classList.toggle("pp-single", withData.length < 2);
  if (!withData.length) return;

  // Výběr měřítka NESMÍ záviset na tom, které tělo se vykreslí dřív.
  // renderOutlookWindows běží před renderMinutely, takže při prvním průchodu
  // mělo data jen 12h tělo — 2h dráha byla dočasně prázdná a panel se
  // "zasekl" na 12 h, i když se 2h data o chvíli později doplnila.
  // Pořadí je proto dané: volba uživatele → 2 h → cokoli, co má data.
  const enabled = sc => {
    const t = panel.querySelector(`.pp-tab[data-scale="${sc}"]`);
    return t && !t.disabled ? t : null;
  };
  const target = (_userScale && enabled(_userScale))
    || enabled(PREFERRED_SCALE)
    || panel.querySelector(".pp-tab:not(:disabled)");
  if (!target) return;
  setPrecipScale(target.dataset.scale, { animate: false });
}

// Nastaví měřítko: posune dráhu a srovná indikátor. `data-active` na panelu
// je jediný zdroj pravdy o tom, co je vidět — čte ho i test, protože poloha
// scrollu je v headless prohlížeči nespolehlivá.
function setPrecipScale(scale, { animate = true, fromScroll = false } = {}) {
  const panel = document.getElementById("precip-panel");
  const track = document.getElementById("pp-track");
  if (!panel || !track) return;
  const body = track.querySelector(`.pp-body[data-scale="${scale}"]:not([hidden])`);
  if (!body) return;

  panel.dataset.active = scale;
  panel.querySelectorAll(".pp-tab").forEach(t => {
    const on = t.dataset.scale === scale;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });

  if (fromScroll) return;   // uživatel už tam přejel sám, nepřetahuj mu to
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  try {
    track.scrollTo({ left: body.offsetLeft, behavior: animate && !reduce ? "smooth" : "auto" });
  } catch {
    track.scrollLeft = body.offsetLeft;   // starší prohlížeče bez options
  }
}

export function initPrecipTabs() {
  const panel = document.getElementById("precip-panel");
  const tabs = document.getElementById("pp-tabs");
  const track = document.getElementById("pp-track");
  if (!panel || !tabs || !track || tabs.dataset.wired) return;
  tabs.dataset.wired = "1";

  tabs.addEventListener("click", e => {
    const btn = e.target.closest(".pp-tab");
    if (!btn || btn.disabled) return;
    _userScale = btn.dataset.scale;
    setPrecipScale(_userScale);
  });

  // Přejetí prstem: indikátor se dotahuje podle toho, co je opravdu vidět.
  // Počítá se v rAF, protože scroll umí střílet desítky událostí za vteřinu.
  let raf = 0;
  track.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const bodies = [...track.querySelectorAll(".pp-body:not([hidden])")];
      if (bodies.length < 2) return;
      const mid = track.scrollLeft + track.clientWidth / 2;
      let best = null, bd = Infinity;
      for (const b of bodies) {
        const c = b.offsetLeft + b.offsetWidth / 2;
        const d = Math.abs(c - mid);
        if (d < bd) { bd = d; best = b; }
      }
      if (!best || panel.dataset.active === best.dataset.scale) return;
      _userScale = best.dataset.scale;
      setPrecipScale(_userScale, { fromScroll: true });
    });
  }, { passive: true });

  // Klávesnice: šipky přepínají měřítko, aby to nešlo jen prstem.
  panel.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (!e.target.closest?.(".pp-tabs")) return;
    const order = ["2h", "12h"];
    const i = order.indexOf(panel.dataset.active || PREFERRED_SCALE);
    const next = order[i + (e.key === "ArrowRight" ? 1 : -1)];
    const btn = next && panel.querySelector(`.pp-tab[data-scale="${next}"]:not(:disabled)`);
    if (!btn) return;
    e.preventDefault();
    _userScale = next;
    setPrecipScale(next);
    btn.focus();
  });
}

export function renderMinutely(ptId, minutely) {
  const panel = document.getElementById("precip-panel");
  const barsEl = document.getElementById("minutely-bars");
  const srcEl = document.getElementById("minutely-src");
  if (!panel || !barsEl) return;

  const SLOTS = 12; // 12 × 10 min
  let vals = null, src = null;

  const series = state.GRID?.series?.[String(ptId)];
  const stepMin = state.GRID?.step_min || 10;
  // Hodnota modelu (minutely_15) pro minutu t — pro blend i fallback.
  const modelAt = t => {
    if (!minutely?.length) return null;
    const idx = Math.min(Math.floor(t / 15), minutely.length - 1);
    return minutely[idx]?.precip ?? null;
  };
  if (series?.length) {
    // Seamless blending: do 30 min věříme radarové extrapolaci naplno,
    // pak její váha lineárně klesá k nule ve 120. minutě — přesně tam,
    // kde extrapolace ztrácí smysl a NWP model ji přebírá. Žádný skok
    // mezi zdroji, plynulý přechod.
    vals = [];
    let blended = false;
    for (let i = 0; i < SLOTS; i++) {
      const t = i * 10; // minuta slotu
      const idx = Math.floor(t / stepMin);
      const radar = idx < series.length ? series[idx] : null;
      const model = modelAt(t);
      if (radar == null) { vals.push(model); continue; }
      if (model == null) { vals.push(radar); continue; }
      const w = t <= 30 ? 1 : Math.max(0, (120 - t) / 90);
      if (w < 1) blended = true;
      vals.push(w * radar + (1 - w) * model);
    }
    src = blended ? "radar → model" : "radarová extrapolace";
  } else if (minutely?.length) {
    vals = [];
    for (let i = 0; i < SLOTS; i++) {
      const idx = Math.min(Math.floor(i * 10 / 15), minutely.length - 1);
      vals.push(minutely[idx]?.precip ?? null);
    }
    src = "model (15min)";
  }

  if (!vals || !vals.some(v => v != null)) { markPrecipBody("2h", false); return; }

  // P(déšť) z ensemble perturbované advekce (grid.prob, % po 10min krocích)
  const prob = state.GRID?.prob?.[String(ptId)] || null;
  const probAt = i => {
    if (!prob) return null;
    const idx = Math.floor(i * 10 / stepMin);
    return idx < prob.length ? prob[idx] : null;
  };

  const known = vals.filter(v => v != null);
  const maxProb = prob ? Math.max(...prob) : 0;
  // Když je celých 120 minut sucho, graf nic neříká — countdown karta
  // ("Nejbližší 2 h bez srážek") to komunikuje líp. Ukazuj jen když prší,
  // NEBO když ensemble vidí aspoň 30% šanci (deterministicky sucho ≠ jistota).
  if (Math.max(...known) < WET_RATE && maxProb < 30) { markPrecipBody("2h", false); return; }

  // Sloupce i osa jsou společné s 12h záložkou — viz precipbars.js.
  const t0 = Date.now();
  const slots = vals.map((v, i) => ({ rate: v, prob: probAt(i), ms: t0 + i * 10 * 60000 }));
  revealSwap(barsEl, precipBarsHtml(slots));
  // Věta i popisek pro odečítač vychází ze STEJNÝCH slotů jako sloupce nad
  // nimi — viz precipSummary(). Dřív tady žádná věta nebyla a nad dráhou
  // visela jediná, počítaná z 12h výhledu, takže si s grafem uměla odporovat.
  const sum = precipSummary(slots, "příští 2 h");
  const msgEl = document.getElementById("minutely-msg");
  if (msgEl) msgEl.innerHTML = sum.html;
  barsEl.setAttribute("role", "img");
  barsEl.setAttribute("aria-label", sum.text);
  const axisEl = document.getElementById("minutely-axis");
  if (axisEl) axisEl.innerHTML = precipAxisHtml(slots.map(s => s.ms));
  if (srcEl) {
    srcEl.textContent = prob ? `${src} · ens.` : src;
    srcEl.title = prob ? `Průhlednost sloupců = P(déšť) z ensemble ${state.GRID.prob_members || 7} členů perturbované advekce` : "";
  }
  markPrecipBody("2h", true);
}

// ── Aktivitní indexy (0–10) ──────────────────────────────────────────────────
function clamp10(v) { return Math.max(0, Math.min(10, Math.round(v))); }

/**
 * Barva skóre — a jedna výjimka, která odhalila chybu v pravidle.
 *
 * Barva v appce znamená STAV ("takhle na tom jsi"), ne potřebu akce. Skóre
 * aktivit to porušovalo v jednom případě: zalévání dostane při vydatném dešti
 * 2/10 a svítilo červeně — s podtitulem "příroda zalije sama". Červená
 * u dobré zprávy. U ostatních aktivit nízké skóre opravdu znamená "dnes to
 * nevyjde", u zalévání znamená "nemusíš", což je úleva, ne problém.
 *
 * Řešení není barvu obrátit (to by bylo jen jiné pravidlo pro jednu dlaždici),
 * ale přiznat, že tu existují TŘI stavy, ne dva: dobré, špatné a netýká se.
 * Třetí je tlumený a nekřičí ani jedním směrem.
 */
function scoreClass(s, nizkeJeUleva) {
  if (nizkeJeUleva && s < 4) return "none";
  return s >= 7 ? "good" : s >= 4 ? "mid" : "bad";
}

export function renderActivities(fc, data) {
  const panel = document.getElementById("activities-panel");
  const grid = document.getElementById("act-grid");
  if (!panel || !grid) return;
  const all = fc.hourlyFull || [];
  if (!all.length) { panel.classList.remove("show"); return; }

  // denní okno (dnešních příštích ~12 h) a večerní/noční okno
  const day = all.slice(0, 12).filter(h => { const hr = +h.t.slice(0, 2); return hr >= 7 && hr <= 21; });
  const evening = all.filter(h => { const hr = +h.t.slice(0, 2); return hr >= 17 && hr <= 21; });
  const night = all.filter(h => { const hr = +h.t.slice(0, 2); return hr >= 22 || hr <= 2; }).slice(0, 5);
  if (!day.length) { panel.classList.remove("show"); return; }

  const mx = (arr, k) => arr.length ? Math.max(...arr.map(h => h[k] ?? 0)) : 0;
  const mean = (arr, k) => arr.length ? arr.reduce((s, h) => s + (h[k] ?? 0), 0) / arr.length : 0;

  const feelsMax = mx(day, "feelsRaw") || mx(day, "tempRaw");
  const probMax = mx(day, "prob");
  const precSum = day.reduce((s, h) => s + (h.precip || 0), 0);
  const gustMax = mx(day, "gust");
  const uvMax = mx(day, "uv");
  const humMean = mean(day, "humidity");

  const run = clamp10(10 - Math.max(0, feelsMax - 20) * 0.55 - (probMax > 50 ? 3 : probMax > 25 ? 1 : 0) - (gustMax > 40 ? 2 : 0));
  const bike = clamp10(10 - Math.max(0, feelsMax - 24) * 0.45 - (probMax > 50 ? 3 : 0) - Math.max(0, gustMax - 28) * 0.12);
  const water = clamp10(precSum > 3 ? 2 : 8 + (feelsMax >= 26 ? 2 : 0) - (probMax > 60 ? 4 : 0));
  const laundry = clamp10(9 - (probMax > 30 ? probMax / 12 : 0) - (humMean > 75 ? 2 : 0) + (gustMax >= 10 && gustMax <= 35 ? 1 : 0));
  const grill = clamp10(9 - (mx(evening, "prob") > 40 ? 4 : 0) - Math.max(0, mx(evening, "gust") - 30) * 0.15 - (mean(evening, "tempRaw") < 14 ? 3 : 0));
  const nightCloud = night.length ? mean(night, "cloud") : 60;
  const stars = clamp10(10 * (1 - nightCloud / 100) - ((state._moonIllum ?? 0.5) * 3));

  // Páté pole: nízké skóre je ÚLEVA, ne špatná zpráva — viz scoreClass().
  const items = [
    ["run", "Běhání", run, `pocitově až ${Math.round(feelsMax)} °C, srážky ${probMax} %`],
    ["bike", "Kolo", bike, `nárazy až ${Math.round(gustMax)} km/h`],
    ["watering", "Zalévání", water, precSum > 1 ? `spadne ~${num(precSum)} mm — příroda zalije sama` : "beze srážek, zalij", true],
    ["laundry", "Prádlo", laundry, `vlhkost ~${Math.round(humMean)} %`],
    ["grill", "Gril", grill, `večer srážky ${Math.round(mx(evening, "prob"))} %`],
    ["telescope", "Hvězdy", stars, `oblačnost v noci ~${Math.round(nightCloud)} %`],
  ];
  revealSwap(grid, items.map(([icon, n, s, why, uleva]) => {
    const cls = scoreClass(s, uleva);
    // "2/10" u zalévání se čte jako selhání. Když je nízké skóre úleva,
    // číslo mate a slovo ne.
    const hodnota = cls === "none" ? "netřeba" : `${s}/10`;
    return `<span class="act" title="${esc(why)}">${uiIcon(icon, "uicon a-e")}`
      + `<span class="a-n">${esc(n)}</span>`
      + `<span class="a-s ${cls}">${hodnota}</span></span>`;
  }).join(""));
  panel.classList.add("show");
  void uvMax; void data;
}

// ── Včera vs. dnes + (později) odchylka od normálu ───────────────────────────
export function renderDeltaLine(data) {
  const el = document.getElementById("delta-line");
  if (!el) return;
  const h = data.hourly || {};
  const times = h.time || [];
  const temp = h.temperature_2m || [];
  const nowP = nowLocStr();
  let i = times.findIndex(t => t >= nowP);
  if (i < 0 || i - 24 < 0 || temp[i] == null || temp[i - 24] == null) { el.classList.remove("show"); el.innerHTML = ""; return; }

  const diff = temp[i] - temp[i - 24];
  let html = "";
  if (Math.abs(diff) >= 1.5) {
    const up = diff > 0;
    html += `<span class="${up ? "d-up" : "d-down"}">${up ? "▲" : "▼"} o ${Math.abs(Math.round(diff))}° ${up ? "tepleji" : "chladněji"} než včera</span>`;
  }
  // #delta-anomaly plní asynchronně climate.js (odchylka od normálu) — když
  // dorazí, sám řádek zviditelní; tady ho ukazujeme jen s reálným obsahem
  html += `<span id="delta-anomaly"></span>`;
  el.innerHTML = html;
  el.classList.toggle("show", html !== `<span id="delta-anomaly"></span>`);
}

// ── Astro — měsíc, zlatá hodina, kvalita noci ────────────────────────────────
const SYNODIC = 29.530588853;
function moonAge(d = new Date()) {
  const ref = Date.UTC(2000, 0, 6, 18, 14); // nov 6. 1. 2000
  const days = (d.getTime() - ref) / 86400000;
  return ((days % SYNODIC) + SYNODIC) % SYNODIC;
}
function moonInfo() {
  const age = moonAge();
  const illum = (1 - Math.cos(2 * Math.PI * age / SYNODIC)) / 2;
  const idx = Math.round(age / SYNODIC * 8) % 8;
  const name = ["nov", "dorůstající srpek", "první čtvrť", "dorůstající", "úplněk", "couvající", "poslední čtvrť", "couvající srpek"][idx];
  return { age, illum, frac: age / SYNODIC, name };
}
function addMin(hm, mins) {
  if (!hm) return null;
  const [H, M] = hm.split(":").map(Number);
  const t = H * 60 + M + mins;
  const hh = Math.floor(((t % 1440) + 1440) % 1440 / 60), mm = ((t % 60) + 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function renderAstro(data, fc) {
  const panel = document.getElementById("astro-panel");
  const body = document.getElementById("astro-body");
  if (!panel || !body) return;
  const d = data.daily || {};
  const rise = d.sunrise?.[0]?.slice(11, 16);
  const set_ = d.sunset?.[0]?.slice(11, 16);
  if (!rise || !set_) { panel.classList.remove("show"); return; }

  const [rh, rm] = rise.split(":").map(Number);
  const [sh, sm] = set_.split(":").map(Number);
  const dayMin = (sh * 60 + sm) - (rh * 60 + rm);
  const dayLen = `${Math.floor(dayMin / 60)} h ${String(dayMin % 60).padStart(2, "0")} min`;

  const moon = moonInfo();
  state._moonIllum = moon.illum; // pro index hvězdaření

  // hodinová oblačnost přes noc (21→05) — pro pásek i pro kvalitu noci
  const nightHours = (fc?.hourlyFull || []).filter(h => { const hr = +h.t.slice(0, 2); return hr >= 21 || hr <= 5; }).slice(0, 9);
  const nightCloud = nightHours.length ? nightHours.reduce((s, h) => s + (h.cloud ?? 50), 0) / nightHours.length : null;
  const nightHumMax = nightHours.length ? Math.max(...nightHours.map(h => h.humidity ?? 0)) : null;
  const bestHour = nightHours.length
    ? nightHours.reduce((best, h) => (h.cloud ?? 100) < (best.cloud ?? 100) ? h : best)
    : null;

  // astronomický výpočet noci (tmavé okno, Měsíc, planety, roje)
  let sg = null;
  try {
    sg = computeNight(state.currentLat ?? 50.08, state.currentLon ?? 14.42);
  } catch (e) { console.warn("stargaze:", e); }
  const hm = dt => dt ? dt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: state.tz }) : null;

  let nightQ = null;
  if (nightCloud != null) {
    let q = 10 * (1 - nightCloud / 100) - moon.illum * 3;
    if (sg && !sg.duskAstro) q -= 1.5;             // bez astronomické noci (léto)
    if (nightHumMax != null && nightHumMax >= 92) q -= 1; // mlha/rosa
    nightQ = q >= 6.5 ? "výborná" : q >= 4 ? "průměrná" : "špatná";
  }

  // pásek oblačnosti: jeden sloupec za hodinu, tmavší = jasněji
  const strip = nightHours.length ? `<div class="astro-row"><span class="a-k">Oblačnost</span>
    <span class="a-v nstrip" role="img" aria-label="Oblačnost po hodinách ${esc(nightHours[0].t)}–${esc(nightHours[nightHours.length - 1].t)}, průměrně ${Math.round(nightHours.reduce((a, h) => a + (h.cloud ?? 50), 0) / nightHours.length)} %" title="oblačnost po hodinách ${esc(nightHours[0].t)}–${esc(nightHours[nightHours.length - 1].t)}">
      ${nightHours.map(h => `<i style="opacity:${(0.15 + 0.85 * (h.cloud ?? 50) / 100).toFixed(2)}" title="${esc(h.t)} · ${h.cloud ?? "?"} %" aria-hidden="true"></i>`).join("")}
    </span>
    ${bestHour && (bestHour.cloud ?? 100) <= 40 ? `<span class="a-d">nejjasněji ~${esc(bestHour.t)}</span>` : ""}</div>` : "";

  const showers = (sg?.showers || []).slice(0, 2);
  const showerStr = showers.length
    ? showers.map(s => `${s.name}${s.isPeak ? " · MAXIMUM" : ""} (ZHR ${s.zhr})`).join(", ")
    : null;
  const moonWarns = moon.illum > 0.6 && showers.length ? " · ruší Měsíc" : "";

  revealSwap(body, `
    <div class="astro-row"><span class="a-k">Slunce</span><span class="a-v">${wImg("sunrise", "wicon winline")} ${esc(rise)} → ${wImg("sunset", "wicon winline")} ${esc(set_)}</span><span class="a-d">den ${esc(dayLen)}</span></div>
    <div class="astro-row"><span class="a-k">Zlatá h.</span><span class="a-v">${esc(addMin(set_, -45))}–${esc(set_)}</span><span class="a-d">ráno ${esc(rise)}–${esc(addMin(rise, 45))}</span></div>
    <div class="astro-row"><span class="a-k">Měsíc</span><span class="a-v">${moonIconImg(moon.frac).replace("wicon", "wicon winline")} ${esc(moon.name)}</span><span class="a-d">svit ${Math.round(moon.illum * 100)} %${sg?.moonRise ? ` · ↑${hm(sg.moonRise)}` : ""}${sg?.moonSet ? ` ↓${hm(sg.moonSet)}` : ""}</span></div>
    ${nightQ ? `<div class="astro-row"><span class="a-k">Noc</span><span class="a-v">pozorování: ${esc(nightQ)}</span><span class="a-d">oblačnost ~${Math.round(nightCloud)} %${nightHumMax >= 92 ? " · riziko mlhy" : ""}</span></div>` : ""}
    <div class="astro-sub">${uiIcon("sparkle")}Pozorování dnes v noci</div>
    ${sg?.duskAstro && sg?.dawnAstro
      ? `<div class="astro-row"><span class="a-k">Astro noc</span><span class="a-v">${hm(sg.duskAstro)}–${hm(sg.dawnAstro)}</span><span class="a-d">slunce pod −18°</span></div>`
      : `<div class="astro-row"><span class="a-k">Astro noc</span><span class="a-v" style="color:var(--muted)">nenastává</span><span class="a-d">letní světlé noci</span></div>`}
    ${sg?.darkStart && sg?.darkEnd
      ? `<div class="astro-row"><span class="a-k">Tmavé okno</span><span class="a-v" style="color:var(--green)">${hm(sg.darkStart)}–${hm(sg.darkEnd)}</span><span class="a-d">bez Slunce i Měsíce</span></div>` : ""}
    ${strip}
    ${sg?.planets?.length ? `<div class="astro-row"><span class="a-k">Planety</span><span class="a-v">${sg.planets.map(p => `${esc(p.name)} <span style="color:var(--muted);font-weight:400">(${esc(p.when)})</span>`).join(" · ")}</span></div>` : ""}
    ${showerStr ? `<div class="astro-row"><span class="a-k">Met. roj</span><span class="a-v">${esc(showerStr)}</span><span class="a-d">radiant po půlnoci${moonWarns}</span></div>` : ""}`);
  panel.classList.add("show");
}

// ── Zimní podmínky — jen když je co hlásit ───────────────────────────────────
export function renderWinter(fc, data) {
  const panel = document.getElementById("winter-panel");
  const body = document.getElementById("winter-body");
  if (!panel || !body) return;
  const all = fc.hourlyFull || [];
  const h = data.hourly || {};
  const snowArr = h.snowfall || [];
  const times = h.time || [];
  const nowP = nowLocStr();
  let si = times.findIndex(t => t >= nowP);
  if (si < 0) si = 0;

  const next48snow = snowArr.slice(si, si + 48).reduce((s, v) => s + (v || 0), 0);
  const frostHours = all.filter(x => (x.tempRaw ?? 99) <= 0).length;
  const iceRisk = all.some(x => (x.tempRaw ?? 99) <= 1 && (x.precip || 0) > 0);
  const inSeason = [11, 12, 1, 2, 3].includes(locMonth());

  if (!inSeason && next48snow < 0.2 && !iceRisk) { panel.classList.remove("show"); return; }
  if (next48snow < 0.2 && frostHours === 0 && !iceRisk) { panel.classList.remove("show"); return; }

  const rows = [];
  if (next48snow >= 0.2) rows.push(`<div class="astro-row"><span class="a-k">Sněžení</span><span class="a-v">~${num(next48snow)} cm / 48 h</span></div>`);
  if (frostHours > 0) rows.push(`<div class="astro-row"><span class="a-k">Mráz</span><span class="a-v">${frostHours} h pod 0 °C</span><span class="a-d">z příštích 24 h</span></div>`);
  if (iceRisk) rows.push(`<div class="astro-row"><span class="a-k">Náledí</span><span class="a-v" style="color:var(--red)">riziko</span><span class="a-d">srážky při teplotě ≤ 1 °C</span></div>`);
  revealSwap(body, rows.join(""));
  panel.classList.add("show");
}

// Průběh dne TADY BYL a je pryč. Byl to druhý panel počítaný ze stejných
// hodin jako druhá půlka proužku "24 hodin": ten řezal zbytek dne na okna po
// třech hodinách ("14:00–17:00"), tenhle na pojmenované fáze ("Odpoledne").
// Stejná agregace, stejná pole — jen jiný štítek. Zůstaly fáze, protože se
// čtou líp, a bydlí v forecast.js (dayPhases) jako součást proužku.

// ── Kontrola proti nejbližší meteostanici — hyperlokální bias modelu ────────
// "U tebe je reálně o 2 °C chladněji, než říká model." Porovnání aktuální
// teploty modelu s nejbližší stanicí ČHMÚ/WU do 15 km s čerstvým měřením.
export function renderStationCheck(fc) {
  const el = document.getElementById("station-check");
  if (!el) return;
  el.classList.remove("show");
  const lat = state.currentLat, lon = state.currentLon;
  const modelT = fc?.hourlyFull?.[0]?.tempRaw;
  if (lat == null || modelT == null) return;

  // Stejný výběr stanice jako žebříček modelů (dosah 40 km + přepočet na
  // nadmořskou výšku místa) — dřív tu byla duplicitní kopie s limitem 15 km.
  const st = nearestFreshStation(lat, lon);
  if (!st) return;

  const measured = st.tempAdj ?? st.temp;
  const diff = Math.round((measured - modelT) * 10) / 10;
  const absD = Math.abs(diff);
  const diffStr = absD >= 1
    ? ` — o <b>${num(absD)} °C ${diff > 0 ? "tepleji" : "chladněji"}</b> než model`
    : " — model sedí";
  // Přiznáme jen skutečně provedený přepočet — dřív se hláška řídila
  // vlastním prahem 100 m, takže mohla tvrdit něco jiného, než se stalo.
  const adjStr = st.lapseApplied ? " (přepočteno na výšku)" : "";
  el.innerHTML = `Stanice <b>${esc(st.name)}</b> (${st.distKm.toFixed(0)} km) hlásí `
    + `<b>${num(measured)} °C</b>${adjStr}${diffStr}.`;
  el.classList.toggle("station-off", absD >= 2);
  el.classList.add("show");
}

// ── Naměřené srážky ze srážkoměrné sítě ČHMÚ ────────────────────────────────
// Proč zvlášť od renderStationCheck: tohle NENÍ kontrola modelu proti teplotě,
// ale skutečně naměřený úhrn. Srážkoměrů je 436 (rozestup ~15 km) proti 40
// klimatologickým stanicím (~50 km), takže "kolik u nás spadlo" je tady
// mnohem blíž pravdě než cokoliv, co umíme dopočítat.
const RAIN_STATION_MAX_KM = 25;   // srážky jsou prostorově mnohem členitější
                                  // než teplota, takže dosah držíme krátký

export function nearestRainStation(lat, lon) {
  const all = state.CHMI_RAIN?.stations || [];
  let best = null, bd = Infinity;
  for (const s of all) {
    if (s.stale || s.lat == null || s.mm_1h == null) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= RAIN_STATION_MAX_KM ? { ...best, distKm: bd } : null;
}

const mm = v => v.toFixed(1).replace(".", ",");

export function renderRainMeasured() {
  const el = document.getElementById("rain-measured");
  if (!el) return;
  el.classList.remove("show", "rain-wet");
  if (!state.inCZ) return;              // síť je jen česká
  const st = nearestRainStation(state.currentLat, state.currentLon);
  if (!st) return;

  const wet = st.mm_1h > 0;
  // Když neprší, nemá cenu vypisovat čtyři nuly — stačí 24h kontext.
  const body = wet
    ? `naměřil <b>${mm(st.mm_1h)} mm</b> za hodinu, <b>${mm(st.mm_24h)} mm</b> za 24 h`
    : (st.mm_24h > 0
      ? `za 24 h naměřil <b>${mm(st.mm_24h)} mm</b>, teď nesrší`
      : `za 24 h <b>nic nenaměřil</b>`);
  el.innerHTML = `Srážkoměr <b>${esc(st.name)}</b> (${st.distKm.toFixed(0)} km) ${body}.`;
  el.classList.toggle("rain-wet", wet);
  el.classList.add("show");
}
