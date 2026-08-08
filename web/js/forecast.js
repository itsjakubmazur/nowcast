import { state } from "./state.js";
import { wcIconSvg, wcLabel, mostSevere, wImg } from "./icons.js";
import { chartAnim, reducedMotion } from "./motion.js";
import { uvClass, esc, num, revealSwap, nowLocStr, locDateStr } from "./utils.js";
import { isDarkTheme } from "./theme.js";
import { panelError } from "./emptystate.js";

const N_HOURLY = 6;
const CZ_DAY_FULL = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];

/** "Čtvrtek 7. 8." — nadpis proužku, když je vybraný jiný den než dnešek. */
function dayLabel(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  const n = CZ_DAY_FULL[d.getDay()];
  return `${n[0].toUpperCase()}${n.slice(1)} ${d.getDate()}. ${d.getMonth() + 1}.`;
}

function _nn(v, def = 0) { return v != null ? v : def; }

export function parseHourly(data) {
  const nowLoc = nowLocStr();
  const h = data.hourly || {};
  const times = h.time || [];
  const wc = h.weather_code || [];
  const temp = h.temperature_2m || [];
  const feels = h.apparent_temperature || [];
  const prec = h.precipitation || [];
  const prob = h.precipitation_probability || [];
  const wind = h.wind_speed_10m || [];
  const gust = h.wind_gusts_10m || [];
  const wdir = h.wind_direction_10m || [];
  const uv = h.uv_index || [];
  const cape = h.cape || [];
  const hum = h.relative_humidity_2m || [];
  const pres = h.surface_pressure || [];
  const cloud = h.cloud_cover || [];
  const snow = h.snowfall || [];

  let si = times.findIndex(t => t >= nowLoc);
  if (si < 0) si = 0;

  // Dřív se braly jen hodiny od teď do +24. Pro výběr dne v týdnu je potřeba
  // celá odpověď — čtvrteční odpoledne v ní je, jen se zahazovalo.
  const hourly = [];
  for (let i = 0; i < times.length; i++) {
    const t = temp[i], f = feels[i];
    const feelsDiff = (t != null && f != null) ? Math.round(f) - Math.round(t) : null;
    hourly.push({
      t: times[i].slice(11, 16),
      iso: times[i],
      wc: wc[i] ?? null,
      temp: t != null ? Math.round(t) : null,
      tempRaw: t,
      feelsDiff,
      feelsRaw: f,
      precip: Math.round(_nn(prec[i]) * 10) / 10,
      prob: Math.round(_nn(prob[i])),
      wind: Math.round(_nn(wind[i])),
      gust: gust[i] != null ? Math.round(gust[i]) : null,
      wind_dir: wdir[i] != null ? Math.round(wdir[i]) : null,
      uv: uv[i] != null ? Math.round(uv[i] * 10) / 10 : null,
      cape: cape[i] != null ? Math.round(cape[i]) : null,
      humidity: hum[i] != null ? Math.round(hum[i]) : null,
      pressure: pres[i] != null ? Math.round(pres[i]) : null,
      cloud: cloud[i] != null ? Math.round(cloud[i]) : null,
      snow: snow[i] != null ? Math.round(snow[i] * 10) / 10 : null,
    });
  }

  const nowIso = times[si] || (hourly[0]?.iso ?? "");
  return { all: hourly, nowIso, ...viewFields(hourly, nowIso, null) };
}

/**
 * Odečte změřenou systematickou odchylku od ZOBRAZENÝCH teplot.
 *
 * Tohle je to místo, kde se celý aparát měření přesnosti konečně dotkne
 * čísla, které je vidět. Dřív appka pečlivě počítala, o kolik který model
 * u tvojí stanice přestřeluje, a hlavní teplota si mezitím jela dál
 * nedotčená — hodnocení bylo vedle předpovědi, ne v ní.
 *
 * Aplikuje se JEN bias, ne váhy: vážený průměr modelů by v hlavním čísle
 * ukazoval teplotu, kterou netvrdí žádný model, a při málo vzorcích by
 * skákal. Odečíst změřenou odchylku je oprava téhož čísla, ne jeho výměna.
 *
 * Posouvá se i pocitová teplota — nemáme pro ni vlastní měření, ale rozdíl
 * proti skutečné teplotě je to, co uživatel čte, a ten musí zůstat sedět.
 *
 * Vrací popis korekce (nebo null), ať se dá pod hero napsat, co se stalo.
 * Tichá úprava naměřených čísel by byla to poslední, co appka smí dělat.
 *
 * ZPĚTNÁ VAZBA TU NEHROZÍ, a to je důležité: bias se měří v models.js proti
 * SUROVÉ řadě z modelového fetche, ne proti tomuhle upravenému výstupu.
 * Kdyby se učil z už opraveného čísla, korekce by se sama sebou potvrzovala
 * a ujížděla by donekonečna.
 */
export function applyTempCorrection(fc, daily, corr) {
  if (!corr?.bias || !fc?.all?.length) return null;
  const b = corr.bias;
  for (const h of fc.all) {
    if (h.tempRaw != null) { h.tempRaw -= b; h.temp = Math.round(h.tempRaw); }
    if (h.feelsRaw != null) h.feelsRaw -= b;
  }
  // Denní extrémy jedou ze samostatného pole daily, ne z hodinovky —
  // bez tohohle by řádky týdne zůstaly nezkorigované a rozešly by se
  // s detailem dne o desetiny stupně.
  for (const k of ["temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
    "apparent_temperature_min"]) {
    const arr = daily?.[k];
    if (Array.isArray(arr)) daily[k] = arr.map(v => (v == null ? v : v - b));
  }
  return corr;
}

// ── Fáze dne ────────────────────────────────────────────────────────────────
// Tohle nahradilo tříhodinové bloky. Byly to DVA panely nad sebou počítané
// ze stejných dat: fc24 řezal zbytek dne na okna po třech hodinách
// ("14:00–17:00") a Průběh dne tytéž hodiny na pojmenované fáze
// ("Odpoledne"). Stejná agregace, stejná pole, jen jiný štítek — a člověk
// čte "odpoledne" líp než "13:00–16:00", takže zůstaly fáze.
// Druhý štítek je zkratka do úzkého pruhu fází: šest sloupců na 360px displeji
// dá na jeden asi 55px a "Dopoledne" se v nich uřízlo na "Dopoled…". Plné
// jméno zůstává v title, zkratka se vykresluje.
const DAY_PHASES = [
  [0, 6, "Noc", "Noc"], [6, 10, "Ráno", "Ráno"], [10, 13, "Dopoledne", "Dopol."],
  [13, 17, "Odpoledne", "Odpol."], [17, 21, "Večer", "Večer"], [21, 24, "Noc", "Noc"],
];

export function dayPhases(hours) {
  const segs = [];
  for (const h of hours) {
    const hr = +h.t.slice(0, 2);
    const phase = DAY_PHASES.find(([a, b]) => hr >= a && hr < b);
    if (!phase) continue;
    const last = segs[segs.length - 1];
    if (last && last.name === phase[2] && last.hours.length < 12) last.hours.push(h);
    else segs.push({ name: phase[2], short: phase[3], hours: [h] });
  }
  // Fáze o jediné hodině není fáze, je to zbytek předchozí — a v pruhu by
  // vypadala jako plnohodnotný úsek dne.
  return segs.filter(s => s.hours.length >= 2).map(s => {
    const temps = s.hours.map(h => h.tempRaw).filter(v => v != null);
    const precs = s.hours.map(h => h.precip || 0);
    return {
      name: s.name,
      short: s.short || s.name,
      from: s.hours[0].t,
      to: s.hours[s.hours.length - 1].t,
      wc: mostSevere(s.hours.map(h => h.wc).filter(v => v != null)),
      hr: +s.hours[Math.floor(s.hours.length / 2)].t.slice(0, 2),
      tmin: temps.length ? Math.round(Math.min(...temps)) : null,
      tmax: temps.length ? Math.round(Math.max(...temps)) : null,
      precip: Math.round(precs.reduce((a, b) => a + b, 0) * 10) / 10,
      prob: Math.max(0, ...s.hours.map(h => h.prob || 0)),
    };
  });
}

// Hodiny + fáze pro JEDEN den. Pro dnešek se počítá od aktuální hodiny,
// pro ostatní dny od půlnoci — jinak by u čtvrtka chybělo ráno.
function viewFields(all, nowIso, dateStr) {
  const today = nowIso.slice(0, 10);
  const isToday = !dateStr || dateStr === today;
  const hrs = isToday
    ? all.filter(h => h.iso >= nowIso).slice(0, 24)
    : all.filter(h => h.iso.slice(0, 10) === dateStr);
  return {
    day: dateStr || today,
    isToday,
    hourly: hrs.slice(0, N_HOURLY),
    hourlyFull: hrs,
    phases: dayPhases(hrs.slice(N_HOURLY)),
  };
}

/** Pohled na jeden den — stejný tvar jako parseHourly, jiný výřez. */
export function forecastView(fc, dateStr) {
  if (!fc?.all?.length) return fc;
  return { ...fc, ...viewFields(fc.all, fc.nowIso, dateStr) };
}

export function parseMinutely15(data) {
  const m = data.minutely_15 || {};
  const times = m.time || [];
  const nowLoc = nowLocStr();
  let si = times.findIndex(t => t >= nowLoc);
  if (si < 0) si = 0;
  const out = [];
  for (let k = 0; k < 16 && si + k < times.length; k++) {
    const i = si + k;
    out.push({
      t: times[i].slice(11, 16),
      precip: m.precipitation?.[i] ?? null,
      gust: m.windgusts_10m?.[i] ?? null,
      wind: m.windspeed_10m?.[i] ?? null,
      wind_dir: m.winddirection_10m?.[i] ?? null,
      cape: m.cape?.[i] ?? null,
    });
  }
  return out;
}

export function renderFcHero(fc) {
  const now = fc.hourly[0];
  const hero = document.getElementById("fc-hero");
  if (!now || now.temp == null) { hero.style.display = "none"; return; }
  const tempEl = document.getElementById("fc-temp-big");
  const iconEl = document.getElementById("fc-hero-icon");
  const descEl = document.getElementById("fc-desc");
  const feelsEl = document.getElementById("fc-feels");

  tempEl.textContent = now.temp + "°";
  tempEl.className = "fc-temp-big" + (now.temp < 5 ? " cold" : "");
  const hour = parseInt(now.t);
  if (iconEl) iconEl.innerHTML = now.wc != null ? wcIconSvg(now.wc, hour) : "";
  descEl.textContent = now.wc != null ? wcLabel(now.wc) : "";
  feelsEl.textContent = now.feels != null && Math.abs(now.feelsRaw - now.tempRaw) >= 2
    ? `Pocitová ${Math.round(now.feelsRaw)}°` : "";
  hero.style.display = "flex";
  renderBiasNote();
}

// Korekce se NESMÍ dít potichu. Číslo, které appka ukazuje, je po úpravě
// podle měření — a je poctivé říct o kolik a z čeho, ne to vydávat za
// surový výstup modelu.
let _corr = null;
export function setDisplayCorrection(c) { _corr = c; }

function renderBiasNote() {
  const el = document.getElementById("fc-bias");
  if (!el) return;
  if (!_corr?.bias) { el.style.display = "none"; el.textContent = ""; return; }
  const smer = _corr.bias > 0 ? "níž" : "výš";
  el.textContent = `upraveno o ${num(Math.abs(_corr.bias))} °C ${smer} podle měření stanice`;
  el.title = `Model pro tohle místo systematicky ${_corr.bias > 0 ? "přestřeluje" : "podstřeluje"}`
    + ` o ${num(Math.abs(_corr.bias))} °C (${_corr.n} porovnání`
    + `${_corr.shared ? `, z toho ${_corr.shared} sdílených` : ""}). Odchylka je odečtená.`;
  el.style.display = "block";
}

// ── Shrnutí dne jednou větou (at a glance) ──────────────────────────────────
// Syntetizuje příštích ~24 h do jedné čitelné věty: rozsah teplot + hlavní
// jev (kdy déšť / jak zataženo) + případně silný vítr. To je ten "hero
// moment" — než uživatel začne studovat grafy, ví, na čem je.
const PHASE_WORD = hr => hr < 6 ? "v noci" : hr < 10 ? "ráno" : hr < 13 ? "dopoledne"
  : hr < 17 ? "odpoledne" : hr < 21 ? "večer" : "v noci";

export function renderDayHeadline(fc) {
  const el = document.getElementById("fc-headline");
  if (!el) return;
  const h = fc.hourlyFull || [];
  const temps = h.map(x => x.tempRaw).filter(v => v != null);
  if (temps.length < 4) { el.style.display = "none"; return; }

  const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps));
  const parts = [lo === hi ? `${hi} °C` : `${lo}–${hi} °C`];

  const rainIdx = h.findIndex(x => (x.precip || 0) >= 0.2);
  if (rainIdx >= 0) {
    const peak = Math.max(...h.map(x => x.precip || 0));
    const word = peak >= 7.5 ? "vydatný déšť" : peak >= 2.5 ? "déšť" : "přeháňky";
    parts.push(`${PHASE_WORD(+h[rainIdx].t.slice(0, 2))} ${word}`);
    if (h.slice(rainIdx + 1).some(x => (x.precip || 0) < 0.1 && (x.cloud ?? 100) < 40))
      parts.push("pak jasněji");
  } else {
    const win = h.slice(0, 12);
    const cloud = win.reduce((s, x) => s + (x.cloud ?? 50), 0) / win.length;
    parts.push(cloud < 30 ? "převážně jasno" : cloud < 70 ? "polojasno" : "zataženo, beze srážek");
  }

  const gust = Math.max(...h.slice(0, 12).map(x => x.gust || 0));
  if (gust >= 45) parts.push(`nárazy až ${Math.round(gust)} km/h`);

  el.textContent = parts.join(" · ");
  el.style.display = "block";
}

export function renderFcNow(fc, minutely) {
  const el = document.getElementById("fc-now");
  const now = fc.hourly[0];
  if (!now) { el.style.display = "none"; return; }

  const windDir = now.wind_dir != null ? degCompass(now.wind_dir) : "";
  const windVal = now.wind != null
    ? `${now.wind}${now.gust != null ? "·" + now.gust : ""} km/h${windDir ? " " + windDir : ""}`
    : "—";

  const humPct = now.humidity != null ? now.humidity : null;
  const windPct = now.wind != null ? Math.min(now.wind / 120 * 100, 100) : null;
  const precipPct = (now.precip ?? 0) > 0 ? Math.min(now.precip / 20 * 100, 100) : 0;
  const pressPct = now.pressure != null ? Math.min(Math.max((now.pressure - 960) / (1040 - 960) * 100, 0), 100) : null;

  // Nejbližší 15min krok s nejvyšším nárazem — jemnější detail než hodinové maximum
  const nearGust = minutely?.length ? Math.max(...minutely.map(m => m.gust ?? 0)) : null;

  // Hodnota a jednotka jsou oddělené schválně: jednotka patří k popisku, ne
  // k číslu. Když se sází stejně velká jako hodnota, ukrádá jí pozornost a
  // sloupec čísel přestane lícovat.
  // Popisky i kontextové řádky jsou schválně krátké. Mřížka .tiles je v levé
  // kartě dvousloupcová (auto-fit od 106 px), takže dlaždice je široká ~114 px:
  // vejde se asi dvanáct znaků verzálek a osmnáct malých. Delší text se uřízne
  // třemi tečkami a přestane být k něčemu — "v nárazech 18 k…" nikomu nepomůže.
  const stats = [
    { label: "Vítr", val: now.wind != null ? String(now.wind) : "—",
      unit: now.wind != null ? `km/h${windDir ? " " + windDir : ""}` : "",
      sub: now.gust != null ? `nárazy ${now.gust} km/h` : "", color: "var(--teal)", pct: windPct },
    { label: "Vlhkost", val: now.humidity != null ? String(now.humidity) : "—", unit: "%",
      sub: "", color: "var(--green)", pct: humPct },
    { label: "Tlak", val: now.pressure != null ? String(now.pressure) : "—", unit: "hPa",
      sub: "", color: "var(--purple)", pct: pressPct },
    { label: "Srážky/h", val: num(now.precip ?? 0), unit: "mm",
      sub: now.prob != null ? `šance ${now.prob} %` : "", color: "var(--blue)", pct: precipPct },
    ...(now.uv != null ? [{ label: "UV index", val: num(now.uv), unit: "",
      sub: uvWord(now.uv), color: "var(--orange)", pct: Math.min(now.uv / 11 * 100, 100) }] : []),
    ...(now.cape != null && now.cape >= 200 ? [{ label: "CAPE", val: String(now.cape), unit: "J/kg",
      sub: "energie bouřek", color: "var(--red)", pct: Math.min(now.cape / 3000 * 100, 100) }] : []),
    ...(nearGust != null && nearGust >= 25 ? [{ label: "Náraz 15 min", val: String(Math.round(nearGust)),
      unit: "km/h", sub: "", color: "var(--blue)", pct: Math.min(nearGust / 120 * 100, 100) }] : []),
  ];

  el.style.display = "block";
  el.innerHTML = `<div class="tiles">
    ${stats.map(s => `<div class="tile">
      <div class="tile-l"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}</div>
      <div class="tile-v">${esc(s.val)}${s.unit ? `<span class="u">${esc(s.unit)}</span>` : ""}</div>
      ${s.sub ? `<div class="tile-s">${esc(s.sub)}</div>` : ""}
      ${s.pct != null ? `<div class="fc-stat-bar"><div class="fc-stat-bar-fill" style="width:${s.pct.toFixed(0)}%;background:${s.color}"></div></div>` : ""}
    </div>`).join("")}
  </div>`;
}

// Slovní popis UV — číslo samo o sobě nikomu nic neříká.
//
// Malými písmeny, a to schválně. Kontextový řádek dlaždice se dřív sázel
// verzálkami stejně jako popisek nad hodnotou, takže každá dlaždice křičela
// dvakrát. Navíc české verzálky s háčky se při .68rem rozpadaly — Figtree
// nechává nad Ď tak široký akcent, že se "PRAVDĚPODOBNOST" četlo jako
// "PRAV DĚPO DOBNOST". Verzálky drží popisek, kontext mluví normálně.
function uvWord(uv) {
  if (uv < 3) return "nízký";
  if (uv < 6) return "střední";
  if (uv < 8) return "vysoký";
  if (uv < 11) return "velmi vysoký";
  return "extrémní";
}

function degCompass(deg) {
  const dirs = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── Rozklik dne v týdnu = JEDINÝ pohled na předpověď ────────────────────────
//
// Dvě zjednodušení po sobě, obě vynucená vlastním používáním.
//
// 1. Detail dne se rozbaluje PŘÍMO POD ŘÁDKEM. První verze přepínala horní
//    proužek: klepneš na neděli dole a hodiny s meteogramem se přepnou o dvě
//    obrazovky výš, takže výsledek vlastního kliknutí nebyl vidět.
//
// 2. Proužek "Dnes" a samostatný meteogram ZMIZELY. Když detail dne umí
//    hodiny, fáze i přepínatelný graf, jsou to nad ním jen tytéž hodnoty
//    potřetí — dnešek je prostě první rozbalený den. Detail proto musel
//    převzít všechno, co uměly: vítr u každé hodiny, záložky Přehled /
//    Srážky / Vítr / Tlak / Ensemble, noční pásmo a rozptyl modelů.
//
// Dnešek je rozbalený hned po načtení, takže se nowcastem pořád začíná bez
// jediného klepnutí.
let _fc = null;          // poslední rozparsovaná předpověď (má .all)
let _fcLabel = "";
let _daily = null;       // daily blok Open-Meteo (východ/západ, UV, úhrny)
let _openDay = null;     // rozbalený den (YYYY-MM-DD) nebo null
let _dayChart = null;
let _dayMode = "overview";   // záložka grafu — drží se napříč dny i překreslením

// Rozptyl modelů a ensemble se stahují asynchronně a platí pro celou
// předpověď, ne pro jeden den. Klíčem je ISO čas hodiny, takže se dají
// promítnout do libovolného denního výřezu.
let _spread = null;      // Map(iso → { ic, ec, gf })
let _ensH = null;        // Map(iso → { p10..p90, prec50, prec90 }) + _ensMembers
let _ensMembers = 0;

const DAY_TABS = [
  ["overview", "Přehled", ""],
  ["precip", "Srážky", ""],
  ["wind", "Vítr", ""],
  ["pressure", "Tlak", ""],
  ["ensemble", "Ens.", "ICON ensemble — vějíř 40 členů"],
];

export function openDayDetail() { return _openDay; }

function closeDayDetail() {
  _dayChart?.destroy();
  _dayChart = null;
  document.getElementById("fc7-detail")?.remove();
  document.querySelectorAll("#fc7-grid .fc7-day").forEach(el => {
    el.classList.remove("fc7-open");
    el.setAttribute("aria-expanded", "false");
  });
  _openDay = null;
}

/** Shrnutí dne do jednoho řádku pod nadpisem detailu. */
function dayMetaLine(dateStr, hodiny) {
  const i = (_daily?.time || []).indexOf(dateStr);
  const bits = [];
  const temps = hodiny.map(h => h.tempRaw).filter(v => v != null);
  if (temps.length) {
    const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps));
    bits.push(lo === hi ? `${hi} °C` : `${lo}–${hi} °C`);
  }
  const sum = hodiny.reduce((a, h) => a + (h.precip || 0), 0);
  const prob = Math.max(0, ...hodiny.map(h => h.prob || 0));
  if (sum >= 0.1) bits.push(`${num(sum)} mm${prob ? ` · ${prob} %` : ""}`);
  else if (prob >= 20) bits.push(`${prob} % srážek`);
  else bits.push("beze srážek");
  const gust = Math.max(0, ...hodiny.map(h => h.gust || 0));
  if (gust >= 35) bits.push(`nárazy ${Math.round(gust)} km/h`);
  if (i >= 0) {
    const uv = _daily.uv_index_max?.[i];
    if (uv != null && uv >= 3) bits.push(`UV ${Math.round(uv)}`);
    const rise = _daily.sunrise?.[i]?.slice(11, 16);
    const set_ = _daily.sunset?.[i]?.slice(11, 16);
    if (rise && set_) bits.push(`den ${rise}–${set_}`);
  }
  return bits.join(" · ");
}

/**
 * Hodiny seskupené po fázích dne — JEDEN pruh místo dvou.
 *
 * Detail měl nad hodinami ještě řádek fází (Ráno / Dopol. / Odpol. …). Byla
 * to ale tatáž čísla podruhé, jen zhuštěná — přesně ta duplikace, kvůli které
 * předtím zmizel proužek "Dnes" a karta "Průběh dne". Jméno fáze je jediné,
 * co ten řádek uměl navíc ("odpoledne" se čte líp než "14, 15, 16"), takže
 * z něj zbyl štítek nad skupinou hodin.
 *
 * Na rozdíl od dayPhases() se tady NEFILTRUJE na dvě a víc hodin: tohle není
 * shrnutí, ale rozdělení — každá hodina musí někam patřit, i ta poslední
 * osamocená.
 */
function hoursByPhase(hours) {
  const out = [];
  for (const h of hours) {
    const hr = +h.t.slice(0, 2);
    const phase = DAY_PHASES.find(([a, b]) => hr >= a && hr < b);
    if (!phase) continue;
    const last = out[out.length - 1];
    if (last && last.name === phase[2]) last.hours.push(h);
    else out.push({ name: phase[2], short: phase[3], hours: [h] });
  }
  return out;
}

export function toggleDayDetail(dateStr) {
  if (!_fc || !dateStr) return;
  if (_openDay === dateStr) { closeDayDetail(); return; }
  closeDayDetail();

  const row = document.querySelector(`#fc7-grid .fc7-day[data-date="${CSS.escape(dateStr)}"]`);
  if (!row) return;
  const view = forecastView(_fc, dateStr);
  const hodiny = view.hourlyFull || [];
  if (!hodiny.length) return;

  _openDay = dateStr;
  row.classList.add("fc7-open");
  row.setAttribute("aria-expanded", "true");

  const box = document.createElement("div");
  box.id = "fc7-detail";
  box.className = "fc7-detail";
  const skupiny = hoursByPhase(hodiny);
  const maxP = Math.max(0.4, ...hodiny.map(h => h.precip || 0));
  // Noc má tmavší podklad, ať je vidět bez čtení času (dřív to uměl proužek
  // "Dnes" přes .fc24-night). Hranice bere východ/západ TOHO dne.
  const di = (_daily?.time || []).indexOf(dateStr);
  const rise = di >= 0 ? _daily.sunrise?.[di]?.slice(11, 16) : null;
  const set_ = di >= 0 ? _daily.sunset?.[di]?.slice(11, 16) : null;
  const jeNoc = t => rise && set_ ? (t < rise || t >= set_) : false;

  const hodinaHtml = h => {
    // Šipka ukazuje, KAM vítr fouká (meteorologický směr + 180°) — "odkud"
    // si člověk musí přepočítat v hlavě a stejně to splete.
    const vitr = h.wind != null
      ? `<span class="fc7d-arrow" style="transform:rotate(${(h.wind_dir ?? 0) + 180}deg)">↑</span>${h.wind}`
      : "";
    const srazky = h.precip > 0 ? `${num(h.precip)} mm` : h.prob >= 25 ? `${h.prob} %` : "";
    return `
      <div class="fc7d-hour${jeNoc(h.t) ? " fc7d-night" : ""}">
        <div class="fc7d-ht">${esc(h.t.slice(0, 2))}</div>
        <div class="fc7d-hi">${wcIconSvg(h.wc, parseInt(h.t, 10))}</div>
        <div class="fc7d-hv">${h.temp != null ? h.temp + "°" : "—"}</div>
        <div class="fc7d-hw">${vitr}</div>
        <div class="fc7d-hb"><i style="height:${h.precip > 0
          ? Math.max(10, Math.round(h.precip / maxP * 100)) : 0}%"></i></div>
        <div class="fc7d-hp">${esc(srazky)}</div>
      </div>`;
  };

  box.innerHTML = `
    <div class="fc7d-inner">
    <div class="fc7d-head">
      <div class="fc7d-title">${esc(dayLabel(dateStr))}</div>
      <div class="fc7d-meta">${esc(dayMetaLine(dateStr, hodiny))}</div>
    </div>
    <div class="fc7d-hours">${skupiny.map(g => `
      <div class="fc7d-group">
        <div class="fc7d-gname">${esc(g.short || g.name)}</div>
        <div class="fc7d-grow">${g.hours.map(hodinaHtml).join("")}</div>
      </div>`).join("")}</div>
    <div class="meteo-head">
      <div class="meteo-title">Meteogram</div>
      <div class="meteo-tabs" id="fc7d-tabs">${DAY_TABS.map(([m, lbl, tip]) => `
        <button type="button" class="mtab${m === _dayMode ? " active" : ""}" data-mode="${m}"${
          tip ? ` title="${esc(tip)}"` : ""}>${esc(lbl)}</button>`).join("")}</div>
    </div>
    <div class="fc7d-chart"><canvas id="fc7d-canvas"></canvas></div>
    </div>`;

  row.insertAdjacentElement("afterend", box);

  box.querySelector("#fc7d-tabs")?.addEventListener("click", e => {
    const btn = e.target.closest(".mtab");
    if (!btn || btn.dataset.mode === _dayMode) return;
    _dayMode = btn.dataset.mode;
    box.querySelectorAll(".mtab").forEach(b => b.classList.toggle("active", b === btn));
    drawDayChart(hodiny);
  });

  // ── Rozbalení: odvine se, ne vyskočí ──────────────────────────────────────
  // Detail se dřív objevil celý naráz — jen krátký fade, takže mezi "klepl
  // jsem" a "je tu obsah na dvě obrazovky" nebyl žádný pohyb, který by ty dvě
  // věci spojil.
  //
  // Výška se animuje přes grid-template-rows 0fr → 1fr. Je to jediný způsob,
  // jak plynule dojet na "tak vysoké, jak to zrovna vyjde", aniž by se výška
  // musela dopředu měřit v JS — max-height by se muselo hádat a u dne s málo
  // hodinami by konec animace uťal nebo naopak čekal naprázdno.
  //
  // Vnitřek se skládá po částech (hlavička → hodiny → graf) s rozestupem
  // 60 ms; to je stejná gramatika jako riseIn() u panelů.
  const rychle = reducedMotion();
  if (!rychle) {
    box.querySelectorAll(".fc7d-inner > *").forEach((el, i) => {
      el.style.setProperty("--fc7d-i", String(i));
      el.classList.add("fc7d-part");
    });
  }
  // Graf se kreslí AŽ po odvinutí. Během animace má obal nulovou výšku a
  // Chart.js si při vzniku měří kontejner — nakreslil by se do ničeho.
  const dokresli = () => { if (_openDay === dateStr) drawDayChart(hodiny); dorovnej(); };

  // Rozbalení nesmí utéct pod spodní lištu sekcí — když se detail nevejde,
  // dorovnej pohled tak, aby byl vidět celý. Při automatickém otevření
  // dneška po načtení se ale scrollovat NESMÍ: uživatel by přišel o nowcast
  // nahoře, aniž by o něco požádal.
  const dorovnej = () => {
    if (!_userOpened) return;
    const r = box.getBoundingClientRect();
    const spodek = window.innerHeight - 90;
    if (r.bottom <= spodek) return;
    const o = Math.min(r.top - 80, r.bottom - spodek);
    if (o > 0) window.scrollBy({ top: o, behavior: rychle ? "auto" : "smooth" });
  };

  if (rychle) {
    box.classList.add("fc7d-shown");
    dokresli();
  } else {
    // Reflow MUSÍ být tady, mezi vložením a třídou. Bez něj prohlížeč
    // spočítá styl až jednou, to už s cílovou třídou, výchozí 0fr nikdy
    // neuvidí a přechod se nespustí — detail vyskočí. (Přidávat třídu
    // v requestAnimationFrame nestačí: rAF běží PŘED výpočtem stylu daného
    // snímku, takže se stane přesně totéž. Stejný trik má slideSwap().)
    void box.offsetHeight;
    box.classList.add("fc7d-shown");
    // transitionend chodí za každou animovanou vlastnost i za potomky —
    // ber jen dojezd výšky na samotném boxu, jinak by se graf kreslil
    // několikrát.
    box.addEventListener("transitionend", e => {
      if (e.target === box && e.propertyName === "grid-template-rows") dokresli();
    }, { once: true });
    // Pojistka, kdyby přechod neproběhl (skrytá záložka prohlížeče apod.) —
    // bez ní by graf nevznikl vůbec.
    setTimeout(() => { if (!_dayChart && _openDay === dateStr) dokresli(); }, 700);
  }
}

// Rozliší klepnutí od automatického otevření dneška po načtení.
let _userOpened = false;
function userToggleDay(dateStr) {
  _userOpened = true;
  try { toggleDayDetail(dateStr); } finally { _userOpened = false; }
}

// ── Graf dne — datasety podle záložky ───────────────────────────────────────
// Pochází z bývalého meteogramu; parametrem jsou hodiny JEDNOHO dne, takže
// tentýž kód obslouží dnešek i příští neděli.
function dayModeConfig(hourly, textColor, gridColor) {
  const precip = hourly.map(h => h.precip ?? 0);
  const prob = hourly.map(h => h.prob ?? 0);
  const pct = { position: "right", min: 0, max: 100, grid: { display: false },
    ticks: { color: textColor, font: { size: 10 }, callback: v => v + " %" } };

  if (_dayMode === "precip") {
    const snow = hourly.map(h => h.snow ?? 0);
    const hasSnow = snow.some(v => v > 0);
    const precipColors = precip.map(v => v > 0 ? "rgba(79,142,247,.75)" : "rgba(79,142,247,.15)");
    return {
      datasets: [
        { type: "bar", label: "Srážky (mm)", data: precip, backgroundColor: precipColors,
          yAxisID: "y", order: 2, barPercentage: 0.9, categoryPercentage: 1 },
        ...(hasSnow ? [{ type: "bar", label: "Sníh (cm)", data: snow,
          backgroundColor: "rgba(172,196,255,.8)", yAxisID: "y", order: 3,
          barPercentage: 0.55, categoryPercentage: 1 }] : []),
        { type: "line", label: "Pravděpodobnost (%)", data: prob, borderColor: "#5AC8FA",
          backgroundColor: "transparent", borderWidth: 1.6, borderDash: [5, 3],
          pointRadius: 0, tension: 0.3, yAxisID: "y1", order: 1 },
      ],
      scales: {
        y: { position: "left", beginAtZero: true, suggestedMax: 3, grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: v => v + " mm" } },
        y1: pct,
      },
    };
  }

  if (_dayMode === "wind") {
    return {
      datasets: [
        { type: "line", label: "Vítr (km/h)", data: hourly.map(h => h.wind ?? null),
          borderColor: "#06b6d4", backgroundColor: "rgba(6,182,212,.09)", fill: true,
          borderWidth: 2, pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
        { type: "line", label: "Nárazy (km/h)", data: hourly.map(h => h.gust ?? null),
          borderColor: "#0A84FF", backgroundColor: "transparent", borderWidth: 1.4,
          borderDash: [4, 3], pointRadius: 0, tension: 0.35, yAxisID: "y", order: 2 },
      ],
      scales: {
        y: { position: "left", beginAtZero: true, grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: v => v + " km/h" } },
      },
    };
  }

  if (_dayMode === "pressure") {
    return {
      datasets: [
        { type: "line", label: "Tlak (hPa)", data: hourly.map(h => h.pressure ?? null),
          borderColor: "#BF5AF2", backgroundColor: "transparent", borderWidth: 2,
          pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
        { type: "line", label: "Vlhkost (%)", data: hourly.map(h => h.humidity ?? null),
          borderColor: "#22c55e", backgroundColor: "transparent", borderWidth: 1.4,
          pointRadius: 0, tension: 0.35, yAxisID: "y1", order: 2 },
        { type: "line", label: "Oblačnost (%)", data: hourly.map(h => h.cloud ?? null),
          borderColor: "#8b93ab", backgroundColor: "rgba(139,147,171,.10)", fill: true,
          borderWidth: 1.1, pointRadius: 0, tension: 0.35, yAxisID: "y1", order: 3 },
      ],
      scales: {
        y: { position: "left", grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: v => v + " hPa" } },
        y1: pct,
      },
    };
  }

  if (_dayMode === "ensemble") {
    const q = k => hourly.map(h => _ensH?.get(h.iso)?.[k] ?? null);
    if (!_ensH) return null;   // ještě se stahuje / není k dispozici
    return {
      datasets: [
        // vějíř: 10–90 % (světlé) a 25–75 % (sytější) pásmo + medián
        { type: "line", label: "_p90", data: q("p90"), borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.10)", order: 6 },
        { type: "line", label: "_p75", data: q("p75"), borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.20)", order: 5 },
        { type: "line", label: "_p25", data: q("p25"), borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.10)", order: 4 },
        { type: "line", label: "_p10", data: q("p10"), borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", order: 3 },
        { type: "line", label: `Medián teploty (${_ensMembers} členů)`, data: q("p50"),
          borderColor: "#0A84FF", backgroundColor: "transparent", borderWidth: 2.2,
          pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
        { type: "bar", label: "Srážky medián (mm)", data: q("prec50"),
          backgroundColor: "rgba(79,142,247,.55)", yAxisID: "y1", order: 7,
          barPercentage: 0.9, categoryPercentage: 1 },
        { type: "line", label: "Srážky 90. percentil", data: q("prec90"),
          borderColor: "#5AC8FA", backgroundColor: "transparent", borderWidth: 1.2,
          borderDash: [3, 3], pointRadius: 0, tension: 0.3, yAxisID: "y1", order: 2 },
      ],
      scales: {
        y: { position: "left", grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 10 }, callback: v => v + "°" } },
        y1: { position: "right", grid: { display: false }, beginAtZero: true, suggestedMax: 5,
          ticks: { color: textColor, font: { size: 10 } } },
      },
    };
  }

  // "overview" — teplota, pocitová, srážky, nárazy + případné pásmo modelů
  const precipColors = precip.map((v, i) => {
    const p = prob[i] || 0;
    return `rgba(79,142,247,${v > 0 ? Math.max(0.35, Math.min(p / 100, 1)) : 0.15})`;
  });
  const datasets = [
    { type: "bar", label: "Srážky (mm)", data: precip, backgroundColor: precipColors,
      yAxisID: "y1", order: 3, barPercentage: 0.9, categoryPercentage: 1 },
    { type: "line", label: "Teplota (°C)", data: hourly.map(h => h.tempRaw ?? null),
      borderColor: "#fb923c", backgroundColor: "transparent", borderWidth: 2.2,
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1, spanGaps: true },
    { type: "line", label: "Pocitová (°C)", data: hourly.map(h => h.feelsRaw ?? null),
      borderColor: "#fb923c", backgroundColor: "transparent", borderWidth: 1.3,
      borderDash: [4, 3], pointRadius: 0, tension: 0.35, yAxisID: "y", order: 2 },
    { type: "line", label: "Nárazy větru (km/h)", data: hourly.map(h => h.gust ?? null),
      borderColor: "#06b6d4", backgroundColor: "transparent", borderWidth: 1.3,
      pointRadius: 0, borderDash: [1, 3], tension: 0.2, yAxisID: "y2", order: 4 },
  ];
  datasets.push(...spreadDatasets(hourly));
  return {
    datasets,
    scales: {
      y: { position: "left", grid: { color: gridColor },
        ticks: { color: textColor, font: { size: 10 }, callback: v => v + "°" } },
      y1: { position: "right", grid: { display: false }, beginAtZero: true, suggestedMax: 5,
        ticks: { color: textColor, font: { size: 10 } } },
      y2: { display: false },
    },
  };
}

/** Pásmo nejistoty ICON/ECMWF/GFS pro hodiny daného dne — prázdné, dokud nedorazí. */
function spreadDatasets(hourly) {
  if (!_spread || !hourly.some(h => _spread.has(h.iso))) return [];
  const g = k => hourly.map(h => _spread.get(h.iso)?.[k] ?? null);
  const ec = g("ec"), gf = g("gf"), ic = g("ic");
  const band = fn => hourly.map((h, i) => {
    const vals = [h.tempRaw, ic[i], ec[i], gf[i]].filter(v => v != null);
    return vals.length ? fn(...vals) : null;
  });
  return [
    { type: "line", label: "ECMWF (°C)", data: ec, borderColor: "#30B0C7",
      backgroundColor: "transparent", borderWidth: 1.1, borderDash: [4, 4],
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 5 },
    { type: "line", label: "GFS (°C)", data: gf, borderColor: "#BF5AF2",
      backgroundColor: "transparent", borderWidth: 1.1, borderDash: [4, 4],
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 6 },
    { type: "line", label: "rozptyl modelů", data: band(Math.max), borderWidth: 0,
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 7,
      fill: "+1", backgroundColor: "rgba(10,132,255,.10)" },
    { type: "line", label: "_bandmin", data: band(Math.min), borderWidth: 0,
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 8 },
  ];
}

function drawDayChart(hodiny) {
  const cv = document.getElementById("fc7d-canvas");
  if (!cv) return;
  // Chart.js se načítá s defer — kdyby fetch dat výjimečně předběhl CDN,
  // zkus to znovu, až doběhne load (jinak by graf zůstal prázdný).
  if (typeof Chart === "undefined") {
    window.addEventListener("load", () => { if (_openDay) drawDayChart(hodiny); }, { once: true });
    return;
  }
  _dayChart?.destroy();
  _dayChart = null;

  const isDark = isDarkTheme();
  const grid = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const txt = isDark ? "#8b93ab" : "#56606f";

  const note = document.getElementById("fc7d-note");
  note?.remove();
  const cfg = dayModeConfig(hodiny, txt, grid);
  if (!cfg) {
    // Ensemble ještě není stažený — řekni to místo prázdného plátna.
    cv.parentElement?.insertAdjacentHTML("beforebegin",
      `<div class="meteo-note" id="fc7d-note">Vějíř ensemble se načítá…</div>`);
    return;
  }

  const labels = hodiny.map(h => h.t);
  const i = (_daily?.time || []).indexOf(_openDay);
  const sunrise = i >= 0 ? _daily.sunrise?.[i]?.slice(11, 16) : null;
  const sunset = i >= 0 ? _daily.sunset?.[i]?.slice(11, 16) : null;

  // Noční pásmo — šedý obdélník mimo východ/západ TOHO dne.
  const nightPlugin = {
    id: "nightBand",
    beforeDraw(chart) {
      if (!sunrise || !sunset) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      ctx.save();
      ctx.fillStyle = isDark ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.05)";
      labels.forEach((t, k) => {
        if (t < sunrise || t >= sunset) {
          const w = xScale.width / labels.length;
          ctx.fillRect(xScale.getPixelForValue(k) - w / 2, chartArea.top, w, chartArea.height);
        }
      });
      ctx.restore();
    },
  };

  _dayChart = new Chart(cv, {
    data: { labels, datasets: cfg.datasets },
    plugins: [nightPlugin],
    options: {
      animation: chartAnim(`den-${_openDay}-${_dayMode}`),
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: {
          color: txt, font: { size: 10 }, boxWidth: 10, padding: 8,
          filter: item => !item.text.startsWith("_"),   // pomocné hrany pásem
        } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { grid: { display: false },
          ticks: { color: txt, font: { size: 10 }, maxTicksLimit: 8 } },
        ...cfg.scales,
      },
    },
  });
}

/** Překreslí otevřený den — po doplnění asynchronních dat (rozptyl, ensemble). */
function redrawOpenDay() {
  if (!_openDay || !_fc) return;
  const hodiny = forecastView(_fc, _openDay).hourlyFull || [];
  if (hodiny.length) drawDayChart(hodiny);
}

const CZ_DAYS = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
const CZ_MONTHS = ["led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"];

// Teplotní pruhy týdne na společné škále. Bez společné škály by pruh nic
// neříkal: každý den by vyplnil celou šířku a rozdíly by zmizely.
function paintRanges(grid, d) {
  const mins = (d.temperature_2m_min || []).filter(v => v != null);
  const maxs = (d.temperature_2m_max || []).filter(v => v != null);
  if (!mins.length || !maxs.length) return;
  const lo = Math.min(...mins), hi = Math.max(...maxs);
  const span = hi - lo || 1;
  grid.querySelectorAll(".fc7-day").forEach((row, i) => {
    const bar = row.querySelector(".fc7-range i");
    const tmin = d.temperature_2m_min?.[i], tmax = d.temperature_2m_max?.[i];
    if (!bar || tmin == null || tmax == null) return;
    const l = ((tmin - lo) / span) * 100;
    const r = ((hi - tmax) / span) * 100;
    bar.style.left = l.toFixed(1) + "%";
    bar.style.right = r.toFixed(1) + "%";
  });
}

export function renderFc7(data, label, fc) {
  const el = document.getElementById("fc7");
  const grid = document.getElementById("fc7-grid");
  const d = data.daily || {};
  const dates = d.time || [];
  if (!dates.length) { el.style.display = "none"; return; }

  if (fc?.all) { _fc = fc; _fcLabel = label || _fcLabel; }
  _daily = d;
  document.getElementById("fc7-place").textContent = label || "—";
  grid.classList.add("fade-swap");
  grid.style.opacity = "0";
  // Překreslení týdne zahodí i rozbalený detail — jeho DOM je uvnitř mřížky.
  // Bez tohohle by v _openDay zůstal den, jehož panel už neexistuje. Který
  // den byl otevřený, si ale zapamatuj: obnova dat co 5 minut by jinak
  // rozečtenou neděli zavřela pod rukama.
  const drzDen = _openDay;
  closeDayDetail();
  grid.innerHTML = "";
  const todayStr = locDateStr();

  dates.forEach((dateStr, i) => {
    const dt = new Date(dateStr + "T12:00:00");
    const isToday = dateStr === todayStr;
    const dayName = isToday ? "Dnes" : CZ_DAYS[dt.getDay()];
    const dayDate = `${dt.getDate()}. ${CZ_MONTHS[dt.getMonth()]}`;
    const tmax = d.temperature_2m_max?.[i];
    const tmin = d.temperature_2m_min?.[i];
    const prec = d.precipitation_sum?.[i];
    const prob = d.precipitation_probability_max?.[i];
    const gust = d.wind_gusts_10m_max?.[i];
    const uv = d.uv_index_max?.[i];
    const wc = d.weather_code?.[i];
    const rise = d.sunrise?.[i]?.slice(11, 16);
    const set_ = d.sunset?.[i]?.slice(11, 16);

    // Srážky: úhrn je konkrétnější než procenta, tak jde první. Suchý den se
    // neschovává — "0 mm" tlumeně je informace, prázdné místo je otázka.
    const precStr = (prec > 0)
      ? `<span class="prec">${num(prec)} mm</span>`
      : `<span class="dry">0 mm</span>`;
    const probStr = (prob != null && prob >= 20) ? `<span>${prob} %</span>` : "";
    const gustStr = gust != null && gust >= 45
      ? `<span>${wImg("wind", "wicon winline")} ${Math.round(gust)}</span>` : "";
    const uvStr = uv != null && uv >= 6 ? `<span class="${uvClass(uv)}">UV ${Math.round(uv)}</span>` : "";

    const day = document.createElement("div");
    // Řádek je tlačítko: klepnutím se pod ním rozbalí detail toho dne.
    // Role a aria-expanded proto, že to nese <div> — bez nich by to pro
    // odečítač obrazovky byl jen text.
    day.className = "fc7-day" + (isToday ? " fc7-today" : "");
    day.dataset.date = dateStr;
    day.setAttribute("role", "button");
    day.setAttribute("tabindex", "0");
    day.setAttribute("aria-expanded", "false");
    day.innerHTML = `
      <div class="fc7-day-name">${esc(dayName)}</div>
      <div class="fc7-day-date">${esc(dayDate)}</div>
      <div class="fc7-day-icon">${wcIconSvg(wc)}</div>
      <div class="fc7-day-temp">${tmin != null ? Math.round(tmin) + "°" : "—"}</div>
      <div class="fc7-range"><i></i></div>
      <div class="fc7-day-tmax">${tmax != null ? Math.round(tmax) + "°" : "—"}</div>
      <div class="fc7-day-sub">${precStr}${probStr || gustStr || uvStr}</div>`;
    grid.appendChild(day);
  });

  // Pruhy na SPOLEČNÉ škále — jinak by každý den vypadal stejně teple.
  // Škála se počítá až po vykreslení, protože potřebuje minimum a maximum
  // celého týdne, ne jednotlivého dne.
  paintRanges(grid, d);

  if (!grid.dataset.wired) {
    grid.dataset.wired = "1";
    const pick = t => {
      const row = t.closest?.(".fc7-day");
      if (row?.dataset.date) userToggleDay(row.dataset.date);
    };
    grid.addEventListener("click", e => pick(e.target));
    grid.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e.target); }
    });
  }

  // Dnešek je rozbalený hned — po zrušení horního proužku je tohle jediné
  // místo, kde se hodinová předpověď dá vidět, a nemá smysl na ni čekat
  // s klikáním. Otevře se ten den, který byl otevřený před překreslením.
  const cil = (drzDen && dates.includes(drzDen)) ? drzDen
    : (dates.includes(todayStr) ? todayStr : dates[0]);
  if (_fc) toggleDayDetail(cil);

  el.style.display = "block";
  void grid.offsetWidth;
  requestAnimationFrame(() => { grid.style.opacity = "1"; });
}

// ── Ensemble vějíř pro 7denní výhled ────────────────────────────────────────
// Jedna čára na 7 dní je iluze jistoty. ICON ensemble (40 členů) dá pro
// každý den rozptyl denních maxim a podíl členů se srážkami — "sobota:
// 60 % scénářů beze srážek, maxima 22–29 °C". Načítá se líně po vykreslení
// fc7 a jen doplní řádek do už stojících denních buněk.
// Token proti souběhu: funkce je async a volá se "fire and forget", takže
// při rychlém překreslení (auto-refresh, znovuvybrání místa) mohly běžet dvě
// naráz a KAŽDÁ si připsala vlastní řádek — v kartě pak stálo dvakrát totéž.
let _ensToken = 0;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export async function addEnsembleFan(lat, lon, data) {
  const grid = document.getElementById("fc7-grid");
  const dates = data?.daily?.time;
  if (!grid || !dates?.length) return;
  const my = ++_ensToken;
  try {
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=temperature_2m,precipitation&models=icon_seamless&forecast_days=7&timezone=auto`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return;
    const ens = await r.json();
    const h = ens.hourly || {};
    const times = h.time || [];
    if (!times.length) return;

    const memberKeys = Object.keys(h).filter(k => k.startsWith("temperature_2m"));
    if (memberKeys.length < 5) return; // bez členů není vějíř

    // index hodin → den (lokální datum je prefix času)
    const dayIdx = new Map(dates.map((d, i) => [d, i]));
    const perDay = dates.map(() => ({ tmax: [], wet: 0, members: 0 }));
    for (const tk of memberKeys) {
      const pk = tk.replace("temperature_2m", "precipitation");
      const tArr = h[tk], pArr = h[pk];
      const dTmax = new Array(dates.length).fill(null);
      const dPrec = new Array(dates.length).fill(0);
      for (let i = 0; i < times.length; i++) {
        const di = dayIdx.get(times[i].slice(0, 10));
        if (di == null) continue;
        const t = tArr?.[i];
        if (t != null && (dTmax[di] == null || t > dTmax[di])) dTmax[di] = t;
        dPrec[di] += pArr?.[i] ?? 0;
      }
      dTmax.forEach((t, di) => {
        if (t == null) return;
        perDay[di].tmax.push(t);
        perDay[di].members++;
        if (dPrec[di] >= 1) perDay[di].wet++;
      });
    }

    // mezitím se mohlo přepnout místo — fc7 by už patřil jinam
    if (state.currentLat?.toFixed(4) !== lat.toFixed(4)) return;
    if (my !== _ensToken) return;   // mezitím odstartoval novější běh

    const cols = grid.querySelectorAll(".fc7-day");
    perDay.forEach((d, di) => {
      const col = cols[di];
      if (!col || d.tmax.length < 5) return;
      // Vykreslení musí být idempotentní: appendChild bez úklidu byl přesně
      // ten důvod, proč se řádek zdvojoval.
      col.querySelectorAll(".fc7-ens").forEach(el => el.remove());
      const lo = Math.round(Math.min(...d.tmax)), hi = Math.round(Math.max(...d.tmax));
      const wetPct = Math.round(d.wet / d.members * 100);
      const wetStr = wetPct >= 20 ? ` · <span class="prec">${wetPct} % déšť</span>` : "";
      const div = document.createElement("div");
      div.className = "fc7-ens";
      div.title = `ICON ensemble, ${d.members} členů: rozptyl denních maxim ${lo}–${hi} °C, `
        + `${wetPct} % členů se srážkami ≥ 1 mm`;
      div.innerHTML = `<span>rozptyl ${lo}–${hi}°</span>${wetStr}`;
      col.appendChild(div);
    });

    // Z TÉHOŽ stažení spočítej i hodinové kvantily pro záložku Ensemble
    // v detailu dne. Dřív to byl druhý fetch (40 členů, 2 dny) spouštěný
    // klepnutím na záložku — stejná data, jen pro kratší horizont a znovu
    // po drátě. Takhle vějíř funguje pro všech 7 dní a stahuje se jednou.
    const precKeys = memberKeys.map(k => k.replace("temperature_2m", "precipitation"));
    const perHour = new Map();
    for (let i = 0; i < times.length; i++) {
      const temps = memberKeys.map(k => h[k]?.[i]).filter(v => v != null).sort((a, b) => a - b);
      const precs = precKeys.map(k => h[k]?.[i]).filter(v => v != null).sort((a, b) => a - b);
      if (!temps.length) continue;
      perHour.set(times[i], {
        p10: quantile(temps, 0.1), p25: quantile(temps, 0.25), p50: quantile(temps, 0.5),
        p75: quantile(temps, 0.75), p90: quantile(temps, 0.9),
        prec50: quantile(precs, 0.5), prec90: quantile(precs, 0.9),
      });
    }
    _ensH = perHour.size ? perHour : null;
    _ensMembers = memberKeys.length;
    if (_dayMode === "ensemble") redrawOpenDay();
  } catch { /* vějíř je bonus — bez něj fc7 funguje dál */ }
}

// ── Porovnání modelů — pásmo nejistoty ICON / ECMWF / GFS ──────────────────
// Druhý lehký fetch (jen teplota, 3 modely). Ukládá se do mapy podle ISO
// hodiny, ne do pole zarovnaného na jeden den — díky tomu se pásmo promítne
// do KTERÉHOKOLI rozbaleného dne, který fetch pokryl (3 dny dopředu).
export async function addModelSpread(lat, lon, fc) {
  if (!fc?.all?.length) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=temperature_2m&models=icon_seamless,ecmwf_ifs025,gfs_seamless`
      + `&forecast_days=3&timezone=auto`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return;
    const data = await r.json();
    const h = data.hourly || {};
    const times = h.time || [];
    const ec = h.temperature_2m_ecmwf_ifs025 || [];
    const gf = h.temperature_2m_gfs_seamless || [];
    const ic = h.temperature_2m_icon_seamless || [];
    if (!ec.some(v => v != null) && !gf.some(v => v != null)) return;

    // mezitím mohl uživatel přepnout místo — fc už by nebylo aktuální
    if (_fc !== fc) return;
    _spread = new Map(times.map((t, i) => [t, { ec: ec[i] ?? null, gf: gf[i] ?? null, ic: ic[i] ?? null }]));
    if (_dayMode === "overview") redrawOpenDay();
  } catch { /* nejistota je bonus — bez ní graf funguje dál */ }
}

// ── Kvalita ovzduší + pyl (Open-Meteo Air Quality API) ───────────────────────
const AQ_LEVELS = [
  [0, 20, "good", "Dobrá"], [20, 40, "fair", "Uspokojivá"], [40, 60, "moderate", "Zhoršená"],
  [60, 80, "poor", "Špatná"], [80, 100, "verypoor", "Velmi špatná"], [100, Infinity, "extreme", "Extrémní"],
];
function aqLevel(pm25) {
  if (pm25 == null) return null;
  return AQ_LEVELS.find(([lo, hi]) => pm25 >= lo && pm25 < hi) || AQ_LEVELS[AQ_LEVELS.length - 1];
}

export async function fetchAndRenderAQ(lat, lon) {
  const panel = document.getElementById("aq-panel");
  if (!panel) return;
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&current=pm10,pm2_5,ozone,nitrogen_dioxide,european_aqi`
      + `&hourly=pm2_5,pm10,ozone,european_aqi,alder_pollen,birch_pollen,grass_pollen,ragweed_pollen`
      + `&timezone=auto&forecast_days=3`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderAQ(data);
  } catch (e) {
    // Dřív tady bylo `remove("show")` — panel beze slova zmizel a nešlo
    // poznat, jestli je vzduch v pořádku, nebo jestli selhal dotaz.
    panelError(panel, "Kvalita ovzduší",
      "Data o kvalitě ovzduší se nepodařilo načíst.",
      () => fetchAndRenderAQ(lat, lon));
  }
}

// Výřez hodinové řady od "teď" dopředu (až 72 h) — pro sparkliny 3denního vývoje.
function hourlySlice(hourly, key) {
  if (!hourly?.time?.length || !hourly[key]) return null;
  const nowLoc = nowLocStr();
  let idx = hourly.time.findIndex(t => t >= nowLoc);
  if (idx < 0) idx = 0;
  const vals = hourly[key].slice(idx, idx + 72);
  return vals.some(v => v != null) ? vals : null;
}

// Mini sparkline jako inline SVG — žádný canvas/Chart.js, škáluje se s kartou.
function sparkSvg(vals, color) {
  if (!vals) return "";
  const known = vals.filter(v => v != null);
  if (!known.length) return "";
  const max = Math.max(...known, 1e-6);
  const W = 100, H = 20;
  const step = W / Math.max(vals.length - 1, 1);
  const pts = vals.map((v, i) =>
    `${(i * step).toFixed(1)},${(H - 1.5 - ((v ?? 0) / max) * (H - 4)).toFixed(1)}`
  ).join(" ");
  return `<svg class="aq-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
}

function renderAQ(data) {
  const panel = document.getElementById("aq-panel");
  const cur = data.current || {};
  const h = data.hourly || {};
  const pm25 = cur.pm2_5;
  const lvl = aqLevel(pm25);

  // Pyl: ukaž druh, který je aktivní teď NEBO se v příštích 3 dnech objeví
  const pollenDefs = [
    ["Bříza", "birch_pollen"], ["Tráva", "grass_pollen"],
    ["Olše", "alder_pollen"], ["Ambrózie", "ragweed_pollen"],
  ];
  const pollenItems = pollenDefs
    .map(([label, key]) => {
      const series = hourlySlice(h, key);
      const now = series?.[0] ?? null;
      const max3d = series ? Math.max(...series.filter(v => v != null), 0) : 0;
      return { label, series, now, max3d };
    })
    .filter(p => p.max3d > 0);

  // Jednotka se sází zvlášť a menší (span.u) — je to gramatika dlaždice,
  // stejná jako u větru nebo tlaku. Dřív byla součástí hodnoty, takže
  // "8 µg/m³" mělo jednotku stejně velkou jako číslo a sloupec čísel
  // přestal lícovat.
  const items = [
    { label: "PM2,5", series: hourlySlice(h, "pm2_5"), color: "#f59e0b",
      val: pm25 != null ? `<span class="aq-badge aq-${lvl?.[2] || "good"}"></span>${pm25.toFixed(0)}` : "—",
      unit: pm25 != null ? "µg/m³" : "" },
    { label: "PM10", series: hourlySlice(h, "pm10"), color: "#f59e0b",
      val: cur.pm10 != null ? cur.pm10.toFixed(0) : "—", unit: cur.pm10 != null ? "µg/m³" : "" },
    { label: "Ozón O₃", series: hourlySlice(h, "ozone"), color: "#30B0C7",
      val: cur.ozone != null ? cur.ozone.toFixed(0) : "—", unit: cur.ozone != null ? "µg/m³" : "" },
    { label: "Evropský AQI", series: hourlySlice(h, "european_aqi"), color: "#0A84FF",
      val: cur.european_aqi != null ? String(Math.round(cur.european_aqi)) : "—", unit: "" },
    ...pollenItems.map(p => ({
      label: `Pyl · ${p.label}`, series: p.series, color: "#22c55e",
      val: p.now != null && p.now > 0
        ? p.now.toFixed(0)
        : `<span style="color:var(--muted)">0</span>`,
      unit: p.now != null && p.now > 0 ? "zrn/m³" : `max ${p.max3d.toFixed(0)} za 3 dny`,
    })),
  ];

  const anySpark = items.some(it => it.series);
  revealSwap(panel, `<div class="aq-title">Ovzduší a pyl${lvl ? ` <span style="color:var(--muted);font-weight:400">· ${esc(lvl[3])}</span>` : ""}<span class="aq-title-days">vývoj 3 dny</span></div>
    <div class="aq-grid">${items.map(it => `<div class="aq-item">
      <div class="aq-item-label">${esc(it.label)}</div>
      <div class="aq-item-val">${it.val}${it.unit ? `<span class="u">${esc(it.unit)}</span>` : ""}</div>
      ${sparkSvg(it.series, it.color)}
      ${it.series ? `<div class="aq-item-axis"><span>teď</span><span>+3 dny</span></div>` : ""}
    </div>`).join("")}</div>`);
  void anySpark;
  panel.classList.add("show");
}

export async function fetchOpenMeteo(lat, lon, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cape,relative_humidity_2m,surface_pressure,cloud_cover,snowfall`
    + `&minutely_15=precipitation,rain,snowfall,windspeed_10m,windgusts_10m,winddirection_10m,cape`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset`
    // past_days=1 kvůli "o X° tepleji/chladněji než včera" (srovnání stejné hodiny)
    + `&forecast_days=7&past_days=1&timezone=auto`;

  // Bez vlastního timeoutu umí fetch na slabším mobilním signálu viset
  // donekonečna a volající strana (loadForecast) pak zůstane navždy na
  // "Načítám předpověď…", protože se nikdy nedostane do catch bloku.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(new Error("Open-Meteo neodpověděl do 15 s")), 15000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    // timezone=auto → API vrací zónu místa; všechny zobrazované časy pak
    // jedou v ní (utils.localHM / nowLocStr čtou state.tz)
    state.tz = data.timezone || "Europe/Prague";
    state.elevation = data.elevation ?? null;   // pro výškovou korekci měření stanic
    // past_days=1 posouvá i daily o den zpět — ořízni včerejšek, ať všichni
    // konzumenti (fc7, meteogram, astro) dál dostávají [0] = dnešek
    if (data.daily?.time?.length) {
      const todayStr = locDateStr();
      const off = data.daily.time.findIndex(t => t >= todayStr);
      if (off > 0) {
        for (const k of Object.keys(data.daily)) {
          if (Array.isArray(data.daily[k])) data.daily[k] = data.daily[k].slice(off);
        }
      }
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
