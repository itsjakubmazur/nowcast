import { state } from "./state.js";
import { wcIconSvg, wcLabel, mostSevere, wImg } from "./icons.js";
import { chartAnim, reducedMotion } from "./motion.js";
import { uvClass, esc, num, revealSwap, nowLocStr, locDateStr } from "./utils.js";
import { isDarkTheme } from "./theme.js";

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

export function parseFc24(data) {
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

/** Pohled na jeden den — stejný tvar jako parseFc24, jiný výřez. */
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

// ── Rozklik dne v týdnu ─────────────────────────────────────────────────────
// První verze přepínala HORNÍ proužek: klepneš na neděli dole a hodinový
// přehled i meteogram se přepnou nahoře — jenže ty jsou o dvě obrazovky výš,
// takže výsledek vlastního kliknutí nebyl vidět a muselo se rolovat zpátky.
// Akce a její efekt musí být na jednom místě.
//
// Detail se proto rozbaluje PŘÍMO POD ŘÁDKEM. Horní proužek zůstává natrvalo
// dnešek, což mimochodem řeší i past, kterou jsem si sám vyrobil: nemůže
// nastat stav "vybraná neděle nahoře, ale graf kreslí dnešek", protože každý
// rozbalený den má vlastní graf.
let _fc = null;          // poslední rozparsovaná předpověď (má .all)
let _fcLabel = "";
let _openDay = null;     // rozbalený den (YYYY-MM-DD) nebo null
let _dayChart = null;

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
  const faze = dayPhases(hodiny);
  const maxP = Math.max(0.4, ...hodiny.map(h => h.precip || 0));

  box.innerHTML = `
    <div class="fc7d-head">${esc(dayLabel(dateStr))}</div>
    <div class="fc7d-phases">${faze.map(f => `
      <div class="fc7d-phase" title="${esc(f.name)} ${esc(f.from)}–${esc(f.to)}">
        <div class="fc7d-pname">${esc(f.short || f.name)}</div>
        <div class="fc7d-picon">${wcIconSvg(f.wc, f.hr)}</div>
        <div class="fc7d-ptemp">${f.tmin != null
          ? (f.tmin === f.tmax ? `${f.tmax}°` : `${f.tmin}–${f.tmax}°`) : "—"}</div>
        <div class="fc7d-pprec">${f.precip > 0
          ? `${num(f.precip)} mm` : f.prob >= 15 ? `${f.prob} %` : ""}</div>
      </div>`).join("")}</div>
    <div class="fc7d-hours">${hodiny.map(h => `
      <div class="fc7d-hour">
        <div class="fc7d-ht">${esc(h.t.slice(0, 2))}</div>
        <div class="fc7d-hi">${wcIconSvg(h.wc, parseInt(h.t, 10))}</div>
        <div class="fc7d-hv">${h.temp != null ? h.temp + "°" : "—"}</div>
        <div class="fc7d-hb"><i style="height:${h.precip > 0
          ? Math.max(10, Math.round(h.precip / maxP * 100)) : 0}%"></i></div>
      </div>`).join("")}</div>
    <div class="fc7d-chart"><canvas id="fc7d-canvas"></canvas></div>`;

  row.insertAdjacentElement("afterend", box);
  drawDayChart(hodiny);
  // Rozbalení nesmí utéct pod spodní lištu sekcí — když se detail nevejde,
  // dorovnej pohled tak, aby byl vidět celý.
  requestAnimationFrame(() => {
    const r = box.getBoundingClientRect();
    const spodek = window.innerHeight - 90;
    if (r.bottom > spodek) {
      const o = Math.min(r.top - 80, r.bottom - spodek);
      if (o > 0) window.scrollBy({ top: o, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  });
}

function drawDayChart(hodiny) {
  const cv = document.getElementById("fc7d-canvas");
  if (!cv || typeof Chart === "undefined") return;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const grid = isDark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.07)";
  const txt = isDark ? "#8b909a" : "#6b7280";
  _dayChart = new Chart(cv, {
    data: {
      labels: hodiny.map(h => h.t.slice(0, 5)),
      datasets: [
        { type: "line", label: "Teplota", data: hodiny.map(h => h.tempRaw ?? null),
          borderColor: "#f59e0b", backgroundColor: "transparent", borderWidth: 2,
          pointRadius: 0, tension: .35, yAxisID: "y", spanGaps: true },
        { type: "bar", label: "Srážky", data: hodiny.map(h => h.precip ?? 0),
          backgroundColor: "#3b82f6aa", borderWidth: 0, yAxisID: "y1" },
      ],
    },
    options: {
      animation: chartAnim("den-" + _openDay), responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: txt, font: { size: 9 } }, grid: { color: grid } },
        y: { position: "left", ticks: { color: txt, font: { size: 9 } }, grid: { color: grid } },
        y1: { position: "right", beginAtZero: true, ticks: { color: txt, font: { size: 9 } },
              grid: { display: false } },
      },
    },
  });
}

export function renderFc24(fc, label) {
  const el = document.getElementById("fc24");
  const scroll = document.getElementById("fc24-scroll");
  document.getElementById("fc24-place").textContent = label || "—";
  // Nadpis musí říct, který den je vidět — jinak se po kliknutí na čtvrtek
  // nedá poznat, jestli se něco přepnulo.
  const titleEl = document.getElementById("fc24-day");
  if (titleEl) titleEl.textContent = "Dnes";
  if (fc.all) { _fc = fc; _fcLabel = label || _fcLabel; }
  // Fade-out skeletonu → fade-in skutečného obsahu (viz revealSwap v utils.js,
  // tady je to natvrdo protože se staví přes appendChild, ne přes jeden innerHTML).
  scroll.classList.add("fade-swap");
  scroll.style.opacity = "0";
  scroll.innerHTML = "";

  // Sloupce se oddělují PRUHOVÁNÍM, ne linkami: střídavý podklad ohraničí
  // hodinu bez jediné čáry navíc, a noc dostane tmavší pás. Díky tomu se do
  // stejné šířky vejde i vítr a proužek srážek — dřív se sem nevešly, protože
  // sloupec bez ohraničení splýval se sousedním a text přetékal.
  const hourlyMax = Math.max(0.4, ...fc.hourly.map(h => h.precip || 0));
  fc.hourly.forEach((h, i) => {
    const col = document.createElement("div");
    const hh = parseInt(h.t, 10);
    const night = Number.isFinite(hh) && (hh >= 21 || hh < 5);
    col.className = "fc24-col" + (i % 2 ? " fc24-alt" : "") + (night ? " fc24-night" : "");
    // Vítr: šipka ukazuje, KAM vítr fouká (meteorologický směr + 180°),
    // protože "odkud" si člověk musí přepočítat v hlavě a stejně to splete.
    const windStr = h.wind != null
      ? `<span class="fc24-arrow" style="transform:rotate(${(h.wind_dir ?? 0) + 180}deg)">↑</span>${h.wind}`
      : "";
    const barPct = h.precip > 0 ? Math.max(12, Math.round(h.precip / hourlyMax * 100)) : 0;
    const precLabel = h.precip > 0 ? `${num(h.precip)} mm` : h.prob >= 25 ? `${h.prob} %` : "";
    col.innerHTML = `
      <div class="fc24-time">${esc(h.t)}</div>
      <div class="fc24-icon">${wcIconSvg(h.wc, hh)}</div>
      <div class="fc24-temp">${h.temp != null ? h.temp + "°" : "—"}</div>
      <div class="fc24-wind">${windStr}</div>
      <div class="fc24-bar"><i style="width:${barPct}%"></i></div>
      <div class="fc24-sub fc24-prec">${esc(precLabel)}</div>`;
    scroll.appendChild(col);
  });

  const phases = fc.phases || [];
  if (fc.hourly.length && phases.length) {
    const sep = document.createElement("div");
    sep.className = "fc24-sep";
    scroll.appendChild(sep);
  }

  // Zbytek dne po fázích. Dřív to byla samostatná karta "Průběh dne" se
  // stejným výpočtem — viz dayPhases().
  for (const b of phases) {
    const col = document.createElement("div");
    col.className = "fc24-col fc24-block";
    const tRange = b.tmin != null
      ? (b.tmin === b.tmax ? `${b.tmax}°` : `${b.tmin}–${b.tmax}°`) : "—";
    const precStr = b.precip > 0
      ? `${b.prob} % ${num(b.precip)} mm`
      : b.prob >= 15 ? `${b.prob} %` : "";
    col.innerHTML = `
      <div class="fc24-time">${esc(b.name)}</div>
      <div class="fc24-icon">${wcIconSvg(b.wc, b.hr)}</div>
      <div class="fc24-range">${esc(tRange)}</div>
      <div class="fc24-sub fc24-hours">${esc(b.from)}–${esc(b.to)}</div>
      <div class="fc24-sub fc24-prec">${esc(precStr)}</div>`;
    scroll.appendChild(col);
  }

  el.style.display = "block";
  void scroll.offsetWidth;
  requestAnimationFrame(() => { scroll.style.opacity = "1"; });
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

export function renderFc7(data, label) {
  const el = document.getElementById("fc7");
  const grid = document.getElementById("fc7-grid");
  const d = data.daily || {};
  const dates = d.time || [];
  if (!dates.length) { el.style.display = "none"; return; }

  document.getElementById("fc7-place").textContent = label || "—";
  grid.classList.add("fade-swap");
  grid.style.opacity = "0";
  // Překreslení týdne zahodí i rozbalený detail — jeho DOM je uvnitř mřížky.
  // Bez tohohle by v _openDay zůstal den, jehož panel už neexistuje.
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
      if (row?.dataset.date) toggleDayDetail(row.dataset.date);
    };
    grid.addEventListener("click", e => pick(e.target));
    grid.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e.target); }
    });
  }

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
  } catch { /* vějíř je bonus — bez něj fc7 funguje dál */ }
}

// ── Meteogram — přepínatelný graf (Přehled / Srážky / Vítr / Tlak) ──────────
let _meteoChart = null;
let _meteoData = null;   // { fc, daily } posledního vykresleného místa
let _meteoMode = "overview";
let _meteoSpread = null; // { ec, gf, bandMax, bandMin } zarovnané na hourlyFull
let _meteoTabsWired = false;

function wireMeteoTabs() {
  if (_meteoTabsWired) return;
  const tabs = document.getElementById("meteo-tabs");
  if (!tabs) return;
  _meteoTabsWired = true;
  tabs.addEventListener("click", e => {
    const btn = e.target.closest(".mtab");
    if (!btn || btn.dataset.mode === _meteoMode) return;
    _meteoMode = btn.dataset.mode;
    tabs.querySelectorAll(".mtab").forEach(b => b.classList.toggle("active", b === btn));
    if (!_meteoData) return;
    if (_meteoMode === "ensemble" && !_meteoEnsemble) loadEnsemble();
    else drawMeteoChart(false);
  });
}

export function renderMeteogram(fc, daily) {
  const wrap = document.getElementById("meteo-block");
  const hourly = fc.hourlyFull || fc.hourly;
  if (!hourly.length) { wrap.classList.remove("show"); return; }
  _meteoData = { fc, daily };
  // Meteogram je natrvalo dnešek. Rozbalený den v týdnu má vlastní graf,
  // takže nemůže nastat "vybraná neděle, ale graf kreslí dnešek".
  _meteoSpread = null;   // nové místo = staré pásmo modelů neplatí
  _meteoEnsemble = null; // ensemble se pro nové místo stáhne líně při kliku
  wireMeteoTabs();
  wrap.classList.add("show");
  if (_meteoMode === "ensemble") loadEnsemble();
  else drawMeteoChart(true);
}

// ── Ensemble vějíř — ICON-EPS členy z Open-Meteo ensemble API ───────────────
// Stahuje se líně až při kliknutí na záložku (40 členů = větší odpověď).
let _meteoEnsemble = null; // { p10, p25, p50, p75, p90, prec50, prec90 } zarovnané na hourlyFull

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function loadEnsemble() {
  const canvasWrap = document.getElementById("meteo-canvas-wrap");
  const fc = _meteoData?.fc;
  const lat = state.currentLat, lon = state.currentLon;
  if (!fc || lat == null) return;
  if (canvasWrap) canvasWrap.innerHTML = `<span class="skel" style="width:100%;height:100%;border-radius:12px"></span>`;
  try {
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=temperature_2m,precipitation&models=icon_seamless&forecast_days=2&timezone=auto`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const h = data.hourly || {};
    const tempKeys = Object.keys(h).filter(k => k.startsWith("temperature_2m"));
    const precKeys = Object.keys(h).filter(k => k.startsWith("precipitation"));
    if (tempKeys.length < 5) throw new Error("málo členů");
    const idxByTime = new Map((h.time || []).map((t, i) => [t, i]));
    const hourly = fc.hourlyFull || [];

    const agg = { p10: [], p25: [], p50: [], p75: [], p90: [], prec50: [], prec90: [] };
    for (const x of hourly) {
      const j = idxByTime.get(x.iso);
      if (j == null) { for (const k of Object.keys(agg)) agg[k].push(null); continue; }
      const temps = tempKeys.map(k => h[k]?.[j]).filter(v => v != null).sort((a, b) => a - b);
      const precs = precKeys.map(k => h[k]?.[j]).filter(v => v != null).sort((a, b) => a - b);
      agg.p10.push(quantile(temps, 0.1)); agg.p25.push(quantile(temps, 0.25));
      agg.p50.push(quantile(temps, 0.5)); agg.p75.push(quantile(temps, 0.75));
      agg.p90.push(quantile(temps, 0.9));
      agg.prec50.push(quantile(precs, 0.5)); agg.prec90.push(quantile(precs, 0.9));
    }
    agg.nMembers = tempKeys.length;
    // mezitím mohl uživatel přepnout místo nebo záložku
    if (_meteoData?.fc !== fc) return;
    _meteoEnsemble = agg;
    if (_meteoMode === "ensemble") drawMeteoChart(false);
  } catch (e) {
    console.warn("Ensemble:", e);
    if (_meteoMode === "ensemble" && canvasWrap) {
      canvasWrap.innerHTML = `<div class="meteo-note" style="padding:2rem 0;text-align:center">Ensemble data se nepodařilo načíst.</div>`;
    }
  }
}

// Datasety pro jednotlivé záložky. Každá vrací { datasets, scales }.
function meteoModeConfig(hourly, textColor, gridColor) {
  const precip = hourly.map(h => h.precip ?? 0);
  const prob = hourly.map(h => h.prob ?? 0);
  const pct = { position: "right", min: 0, max: 100, ticks: { color: textColor, font: { size: 10 }, callback: v => v + " %" }, grid: { display: false } };

  if (_meteoMode === "precip") {
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
        y: { position: "left", beginAtZero: true, suggestedMax: 3, ticks: { color: textColor, font: { size: 10 }, callback: v => v + " mm" }, grid: { color: gridColor } },
        y1: pct,
      },
    };
  }

  if (_meteoMode === "wind") {
    const wind = hourly.map(h => h.wind ?? null);
    const gusts = hourly.map(h => h.gust ?? null);
    return {
      datasets: [
        { type: "line", label: "Vítr (km/h)", data: wind, borderColor: "#06b6d4",
          backgroundColor: "rgba(6,182,212,.09)", fill: true, borderWidth: 2,
          pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
        { type: "line", label: "Nárazy (km/h)", data: gusts, borderColor: "#0A84FF",
          backgroundColor: "transparent", borderWidth: 1.4, borderDash: [4, 3],
          pointRadius: 0, tension: 0.35, yAxisID: "y", order: 2 },
      ],
      scales: {
        y: { position: "left", beginAtZero: true, ticks: { color: textColor, font: { size: 10 }, callback: v => v + " km/h" }, grid: { color: gridColor } },
      },
    };
  }

  if (_meteoMode === "pressure") {
    const pres = hourly.map(h => h.pressure ?? null);
    const hum = hourly.map(h => h.humidity ?? null);
    const cloud = hourly.map(h => h.cloud ?? null);
    return {
      datasets: [
        { type: "line", label: "Tlak (hPa)", data: pres, borderColor: "#BF5AF2",
          backgroundColor: "transparent", borderWidth: 2, pointRadius: 0,
          tension: 0.35, yAxisID: "y", order: 1 },
        { type: "line", label: "Vlhkost (%)", data: hum, borderColor: "#22c55e",
          backgroundColor: "transparent", borderWidth: 1.4, pointRadius: 0,
          tension: 0.35, yAxisID: "y1", order: 2 },
        { type: "line", label: "Oblačnost (%)", data: cloud, borderColor: "#8b93ab",
          backgroundColor: "rgba(139,147,171,.10)", fill: true, borderWidth: 1.1,
          pointRadius: 0, tension: 0.35, yAxisID: "y1", order: 3 },
      ],
      scales: {
        y: { position: "left", ticks: { color: textColor, font: { size: 10 }, callback: v => v + " hPa" }, grid: { color: gridColor } },
        y1: pct,
      },
    };
  }

  if (_meteoMode === "ensemble" && _meteoEnsemble) {
    const e = _meteoEnsemble;
    return {
      datasets: [
        // vějíř: 10–90 % (světlé) a 25–75 % (sytější) pásmo + medián
        { type: "line", label: "_p90", data: e.p90, borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.10)", order: 6 },
        { type: "line", label: "_p75", data: e.p75, borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.20)", order: 5 },
        { type: "line", label: "_p25", data: e.p25, borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", fill: "+1", backgroundColor: "rgba(10,132,255,.10)", order: 4 },
        { type: "line", label: "_p10", data: e.p10, borderWidth: 0, pointRadius: 0,
          tension: 0.35, yAxisID: "y", order: 3 },
        { type: "line", label: `Medián teploty (${e.nMembers} členů)`, data: e.p50,
          borderColor: "#0A84FF", backgroundColor: "transparent", borderWidth: 2.2,
          pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
        { type: "bar", label: "Srážky medián (mm)", data: e.prec50,
          backgroundColor: "rgba(79,142,247,.55)", yAxisID: "y1", order: 7,
          barPercentage: 0.9, categoryPercentage: 1 },
        { type: "line", label: "Srážky 90. percentil", data: e.prec90,
          borderColor: "#5AC8FA", backgroundColor: "transparent", borderWidth: 1.2,
          borderDash: [3, 3], pointRadius: 0, tension: 0.3, yAxisID: "y1", order: 2 },
      ],
      scales: {
        y: { position: "left", ticks: { color: textColor, font: { size: 10 }, callback: v => v + "°" }, grid: { color: gridColor } },
        y1: { position: "right", ticks: { color: textColor, font: { size: 10 } }, grid: { display: false }, beginAtZero: true, suggestedMax: 5 },
      },
    };
  }

  // "overview" — původní kombinovaný graf + případné pásmo modelů
  const temps = hourly.map(h => h.tempRaw ?? null);
  const feelsArr = hourly.map(h => h.feelsRaw ?? null);
  const gusts = hourly.map(h => h.gust ?? null);
  const precipColors = precip.map((v, i) => {
    const p = prob[i] || 0;
    const alpha = v > 0 ? Math.max(0.35, Math.min(p / 100, 1)) : 0.15;
    return `rgba(79,142,247,${alpha})`;
  });
  const datasets = [
    { type: "bar", label: "Srážky (mm)", data: precip,
      backgroundColor: precipColors, yAxisID: "y1", order: 3,
      barPercentage: 0.9, categoryPercentage: 1 },
    { type: "line", label: "Teplota (°C)", data: temps,
      borderColor: "#fb923c", backgroundColor: "transparent",
      borderWidth: 2.2, pointRadius: 0, tension: 0.35, yAxisID: "y", order: 1 },
    { type: "line", label: "Pocitová (°C)", data: feelsArr,
      borderColor: "#fb923c", backgroundColor: "transparent",
      borderWidth: 1.3, borderDash: [4, 3], pointRadius: 0, tension: 0.35, yAxisID: "y", order: 2 },
    { type: "line", label: "Nárazy větru (km/h)", data: gusts,
      borderColor: "#06b6d4", backgroundColor: "transparent",
      borderWidth: 1.3, pointRadius: 0, borderDash: [1, 3], tension: 0.2, yAxisID: "y2", order: 4 },
  ];
  if (_meteoSpread) datasets.push(...spreadDatasets(_meteoSpread));
  return {
    datasets,
    scales: {
      y: { position: "left", ticks: { color: textColor, font: { size: 10 }, callback: v => v + "°" }, grid: { color: gridColor } },
      y1: { position: "right", ticks: { color: textColor, font: { size: 10 } }, grid: { display: false }, beginAtZero: true, suggestedMax: 5 },
      y2: { display: false },
    },
  };
}

function spreadDatasets(sp) {
  return [
    { type: "line", label: "ECMWF (°C)", data: sp.ec, borderColor: "#30B0C7",
      backgroundColor: "transparent", borderWidth: 1.1, borderDash: [4, 4],
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 5 },
    { type: "line", label: "GFS (°C)", data: sp.gf, borderColor: "#BF5AF2",
      backgroundColor: "transparent", borderWidth: 1.1, borderDash: [4, 4],
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 6 },
    { type: "line", label: "rozptyl modelů", data: sp.bandMax, borderWidth: 0,
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 7,
      fill: "+1", backgroundColor: "rgba(10,132,255,.10)" },
    { type: "line", label: "_bandmin", data: sp.bandMin, borderWidth: 0,
      pointRadius: 0, tension: 0.35, yAxisID: "y", order: 8 },
  ];
}

function drawMeteoChart(withFade) {
  // Chart.js se načítá s defer — kdyby fetch dat výjimečně předběhl CDN,
  // zkus to znovu až doběhne load (jinak by meteogram zůstal prázdný).
  if (typeof Chart === "undefined") {
    window.addEventListener("load", () => { if (_meteoData) drawMeteoChart(withFade); }, { once: true });
    return;
  }
  const canvasWrap = document.getElementById("meteo-canvas-wrap");
  const { fc, daily } = _meteoData;
  const hourly = fc.hourlyFull || fc.hourly;

  if (_meteoChart) { _meteoChart.destroy(); _meteoChart = null; }
  canvasWrap.classList.add("fade-swap");
  if (withFade) canvasWrap.style.opacity = "0";
  canvasWrap.innerHTML = `<canvas id="meteo-canvas"></canvas>`;

  const labels = hourly.map(h => h.t);
  const sunrise = daily?.sunrise?.[0]?.slice(11, 16);
  const sunset = daily?.sunset?.[0]?.slice(11, 16);

  const isDark = isDarkTheme();
  const gridColor = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const textColor = isDark ? "#8b93ab" : "#56606f";

  // Noční pásmo — jednoduchý plugin kreslící šedý obdélník mimo rise/set
  const nightPlugin = {
    id: "nightBand",
    beforeDraw(chart) {
      if (!sunrise || !sunset) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales.x;
      ctx.save();
      ctx.fillStyle = isDark ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.05)";
      labels.forEach((t, i) => {
        if (t < sunrise || t >= sunset) {
          const x0 = xScale.getPixelForValue(i) - (xScale.width / labels.length) / 2;
          const w = xScale.width / labels.length;
          ctx.fillRect(x0, chartArea.top, w, chartArea.height);
        }
      });
      ctx.restore();
    },
  };

  const cfg = meteoModeConfig(hourly, textColor, gridColor);

  _meteoChart = new Chart(document.getElementById("meteo-canvas"), {
    data: { labels, datasets: cfg.datasets },
    plugins: [nightPlugin],
    options: {
      animation: chartAnim("meteo"), responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", labels: {
          color: textColor, font: { size: 10 }, boxWidth: 10, padding: 8,
          filter: item => !item.text.startsWith("_"), // pomocné hrany pásem
        } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 8 }, grid: { display: false } },
        ...cfg.scales,
      },
    },
  });

  if (withFade) {
    void canvasWrap.offsetWidth;
    requestAnimationFrame(() => { canvasWrap.style.opacity = "1"; });
  } else {
    canvasWrap.style.opacity = "1";
  }
}

// ── Porovnání modelů — pásmo nejistoty ICON / ECMWF / GFS v meteogramu ──────
// Druhý lehký fetch (jen teplota, 3 modely); výsledek se uloží a promítne do
// záložky Přehled — přežije i přepínání záložek (překreslí se z _meteoSpread).
export async function addModelSpread(lat, lon, fc) {
  if (!_meteoData) return;
  const hourly = fc.hourlyFull || [];
  if (!hourly.length) return;
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
    const idxByTime = new Map((h.time || []).map((t, i) => [t, i]));
    const grab = key => hourly.map(x => {
      const j = idxByTime.get(x.iso);
      return j != null ? (h[key]?.[j] ?? null) : null;
    });
    const ec = grab("temperature_2m_ecmwf_ifs025");
    const gf = grab("temperature_2m_gfs_seamless");
    const ic = grab("temperature_2m_icon_seamless");
    if (!ec.some(v => v != null) && !gf.some(v => v != null)) return;

    const bandMax = hourly.map((x, i) => {
      const vals = [x.tempRaw, ic[i], ec[i], gf[i]].filter(v => v != null);
      return vals.length ? Math.max(...vals) : null;
    });
    const bandMin = hourly.map((x, i) => {
      const vals = [x.tempRaw, ic[i], ec[i], gf[i]].filter(v => v != null);
      return vals.length ? Math.min(...vals) : null;
    });

    // mezitím mohl uživatel přepnout místo — fc už by nebylo aktuální
    if (_meteoData?.fc !== fc) return;
    _meteoSpread = { ec, gf, bandMax, bandMin };
    if (_meteoMode === "overview" && _meteoChart) {
      _meteoChart.data.datasets.push(...spreadDatasets(_meteoSpread));
      _meteoChart.update("none");
    }
  } catch { /* nejistota je bonus — bez ní meteogram funguje dál */ }
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
    panel.classList.remove("show");
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
  // donekonečna a volající strana (showFc24) pak zůstane navždy na
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
