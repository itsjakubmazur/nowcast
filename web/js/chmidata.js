// Panely nad daty ČHMÚ, která appka dřív nevyužívala:
//   - COTREC: publikovaná extrapolace ČHMÚ vedle naší (druhý názor)
//   - echotop + aerologie: prostředí pro bouřky
//   - měřená kvalita ovzduší ze státní sítě
//   - klimatický normál 1991–2020 z nejbližší stanice
//   - oficiální textová předpověď
//
// Všechny panely se samy schovají, když pro ně nejsou data — pipeline kroky
// jsou continue-on-error, takže kterýkoli z nich může chybět, aniž by to
// znamenalo chybu.

import { state } from "./state.js";
import { esc, haversine, localHM } from "./utils.js";

// ── Druhý názor: COTREC ČHMÚ ────────────────────────────────────────────────
// Naše extrapolace jede na lucaskanade (pysteps), ČHMÚ na COTREC. Jsou to
// dva nezávislé algoritmy nad týmiž radarovými daty, takže jejich shoda je
// informace: když oba čekají déšť ve stejnou dobu, dá se tomu věřit víc než
// kterémukoli z nich zvlášť.

const COTREC_MAX_AGE_MIN = 30;
const AGREE_MIN = 10;      // do 10 min rozdílu = shoda
const DISAGREE_MIN = 30;   // nad 30 min = metody si odporují

function minutesUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((t - Date.now()) / 60000) : null;
}

// Nejbližší bod mřížky COTREC — grid má stejné indexy jako forecast_grid.json,
// takže se hledá ve `state.GRID.pts` a čte z `COTREC.grid.series`.
function cotrecSeriesAt(lat, lon) {
  const cot = state.COTREC;
  const pts = state.GRID?.pts;
  if (!cot?.grid?.series || !pts) return null;
  // Pojistka proti spárování dvou různých běhů: pokud grid.py mezitím běžel
  // znovu, indexy by ukazovaly jinam.
  if (cot.grid.t0_utc && state.GRID.t0_utc && cot.grid.t0_utc !== state.GRID.t0_utc) return null;
  if (cot.grid.n_pts !== pts.length) return null;

  let bi = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(lat, lon, pts[i][0], pts[i][1]);
    if (d < bd) { bd = d; bi = i; }
  }
  if (bi < 0 || bd > 15) return null;
  return { series: cot.grid.series[String(bi)] || null, distKm: bd };
}

export function renderCotrec() {
  const el = document.getElementById("cotrec-card");
  if (!el) return;
  el.classList.remove("show");
  el.innerHTML = "";
  if (!state.inCZ) return;                 // radar ČHMÚ je jen nad ČR

  const cot = state.COTREC;
  if (!cot || (cot.age_min ?? 999) > COTREC_MAX_AGE_MIN) return;

  const hit = cotrecSeriesAt(state.currentLat, state.currentLon);
  const step = cot.grid?.step_min || cot.step_min || 10;

  // Čas příchodu podle ČHMÚ: buď z mřížky pro naše místo, nebo (mimo mřížku)
  // z bodové řady pro domovskou lokaci — ta ale platí jinde, tak ji nebereme.
  let chmiIn = null;
  if (hit?.series) {
    const idx = hit.series.findIndex(v => v >= (cot.threshold_mm_h ?? 0.1));
    if (idx >= 0) chmiIn = (idx + 1) * step;
  } else if (hit) {
    chmiIn = Infinity;                     // bod v mřížce je, ale beze srážek
  } else {
    return;                                // mimo mřížku → nemáme co říct
  }

  // Náš čas příchodu ze stejné mřížky (act[i] = [start, end, peak, total])
  let oursIn = null;
  const pts = state.GRID?.pts || [];
  let bi = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(state.currentLat, state.currentLon, pts[i][0], pts[i][1]);
    if (d < bd) { bd = d; bi = i; }
  }
  const act = bi >= 0 ? state.GRID?.act?.[String(bi)] : null;
  const gstep = state.GRID?.step_min || 10;
  oursIn = act && act[0] >= 0 ? (act[0] + 1) * gstep : Infinity;

  // Na suchý den nemá druhý názor co říct — "obě metody se shodují, že nic
  // nepřijde" je řádek navíc nad countdownem, který totéž říká líp. Karta
  // se proto ukáže jen tehdy, když někdo z dvojice čeká déšť, nebo když se
  // metody rozcházejí. Tím zmizí z běžného provozu a zůstane pro chvíli,
  // kdy je opravdu užitečná.
  if (oursIn === Infinity && chmiIn === Infinity) return;

  const fmt = m => (m === Infinity ? "nic" : `za ${m} min`);
  let verdict, cls;
  if (oursIn === Infinity || chmiIn === Infinity) {
    verdict = "metody se neshodují — ber odpočet s rezervou";
    cls = "disagree";
  } else {
    const diff = Math.abs(oursIn - chmiIn);
    if (diff <= AGREE_MIN) { verdict = "obě metody se shodují"; cls = "agree"; }
    else if (diff >= DISAGREE_MIN) { verdict = `liší se o ${diff} min — ber s rezervou`; cls = "disagree"; }
    else { verdict = `liší se o ${diff} min`; cls = "partial"; }
  }

  el.innerHTML =
    `<b>Druhý názor:</b> ČHMÚ (COTREC) ${fmt(chmiIn)}, my ${fmt(oursIn)} — ${esc(verdict)}. ` +
    `<span class="muted">Nezávislý algoritmus nad týmiž radarovými daty, ` +
    `vydáno ${localHM(cot.base_utc)}.</span>`;
  el.className = `cotrec-${cls}`;
  el.classList.add("show");
}

// ── Prostředí pro bouřky: aerologie + výška vrcholů ─────────────────────────
// Dvě různé věci, které dávají smysl vedle sebe: aerologie říká, jestli je
// atmosféra k bouřkám naladěná, echotop říká, jak hluboká je konvekce PRÁVĚ
// TEĎ. Ani jedno není předpověď.

const AERO_MAX_KM = 180;   // dvě stanice na republiku — dosah musí být velký

function nearestSounding(lat, lon) {
  const all = state.CHMI_AERO?.stations || [];
  let best = null, bd = Infinity;
  for (const s of all) {
    if (s.lat == null) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= AERO_MAX_KM ? { ...best, distKm: bd } : null;
}

function echotopAt(lat, lon) {
  const et = state.ECHOTOP;
  const pts = state.GRID?.pts;
  if (!et?.tops_m || !pts || et.n_pts !== pts.length) return null;
  let bi = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversine(lat, lon, pts[i][0], pts[i][1]);
    if (d < bd) { bd = d; bi = i; }
  }
  if (bi < 0 || bd > 15) return null;
  const m = et.tops_m[String(bi)];
  return m ? { m, distKm: bd } : null;
}

export function renderConvect() {
  const panel = document.getElementById("convect-panel");
  const body = document.getElementById("convect-body");
  if (!panel || !body) return;
  panel.classList.remove("show");
  body.innerHTML = "";
  if (!state.inCZ) return;

  const rows = [];
  const top = echotopAt(state.currentLat, state.currentLon);
  if (top) {
    const km = (top.m / 1000).toFixed(1).replace(".", ",");
    rows.push(`<div class="ct-row"><span>Vrcholy odrazu u vás</span>` +
      `<b>${km} km</b></div>`);
  }
  const et = state.ECHOTOP;
  if (et?.max_m > 0) {
    const km = (et.max_m / 1000).toFixed(1).replace(".", ",");
    rows.push(`<div class="ct-row"><span>Nejvyšší nad ČR</span>` +
      `<b>${km} km</b> <span class="muted">${esc(et.max_severity || "")}</span></div>`);
  }

  const snd = nearestSounding(state.currentLat, state.currentLon);
  if (snd && snd.cape != null) {
    rows.push(`<div class="ct-row"><span>CAPE (${esc(snd.name)}, ` +
      `${snd.distKm.toFixed(0)} km)</span><b>${Math.round(snd.cape)} J/kg</b> ` +
      `<span class="muted">${esc(snd.cape_label || "")}</span></div>`);
    if (snd.cin != null) {
      // Silně záporný CIN drží pokličku — bouřka se nespustí, i když je CAPE.
      const held = snd.cin <= -100;
      rows.push(`<div class="ct-row"><span>Zábrana (CIN)</span>` +
        `<b>${Math.round(snd.cin)} J/kg</b> <span class="muted">` +
        `${held ? "drží pokličku" : "slabá"}</span></div>`);
    }
    if (snd.t_konv != null) {
      rows.push(`<div class="ct-row"><span>Konvektivní teplota</span>` +
        `<b>${String(snd.t_konv).replace(".", ",")} °C</b></div>`);
    }
    // VKH/KKH = teplota a tlak v kondenzačních hladinách [°C, hPa]. První
    // číslo je teplota, ne výška — potvrzeno až oficiální dokumentací ČHMÚ,
    // z dat samotných to vypadalo opačně.
    if (snd.ccl?.hpa != null) {
      rows.push(`<div class="ct-row"><span>Konvektivní kondenzační hladina</span>` +
        `<b>${Math.round(snd.ccl.hpa)} hPa</b> <span class="muted">` +
        `${String(snd.ccl.t_c).replace(".", ",")} °C</span></div>`);
    }
  }

  if (!rows.length) return;
  const caveat = snd
    ? `Sondáž ${localHM(snd.sounding_utc)}, dvakrát denně. Popisuje prostředí, ` +
      `ve kterém by bouřka vznikala — není to předpověď konkrétní bouřky.`
    : `Výška vrcholů radarového odrazu, aktualizace po 5 minutách.`;
  body.innerHTML = rows.join("") + `<div class="ct-note">${esc(caveat)}</div>`;
  panel.classList.add("show");
}

// ── Měřená kvalita ovzduší ──────────────────────────────────────────────────
// Appka jinde ukazuje modelované ovzduší (CAMS). Tohle je skutečné měření
// z nejbližší stanice — stejný posun jako u teploty ze stanic proti modelu.

const AIR_MAX_KM = 35;
const AIR_LABEL = {
  SO2: "SO₂", NO2: "NO₂", NOx: "NOₓ", NO: "NO", O3: "O₃",
  PM10: "PM10", PM2_5: "PM2,5", "PM2.5": "PM2,5", CO: "CO", C6H6: "benzen",
};
// Pořadí podle toho, co lidi zajímá, ne podle abecedy.
const AIR_ORDER = ["PM2_5", "PM2.5", "PM10", "O3", "NO2", "SO2", "NOx", "NO", "CO", "C6H6"];

export function nearestAirStation(lat, lon) {
  const all = state.CHMI_AIR?.stations || [];
  let best = null, bd = Infinity;
  for (const s of all) {
    if (s.lat == null) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= AIR_MAX_KM ? { ...best, distKm: bd } : null;
}

export function renderAirMeasured() {
  const panel = document.getElementById("air-panel");
  const body = document.getElementById("air-body");
  if (!panel || !body) return;
  panel.classList.remove("show");
  body.innerHTML = "";
  if (!state.inCZ) return;

  const st = nearestAirStation(state.currentLat, state.currentLon);
  if (!st) return;
  const vals = st.v || {};
  const keys = AIR_ORDER.filter(k => vals[k]).concat(
    Object.keys(vals).filter(k => !AIR_ORDER.includes(k)));
  if (!keys.length) return;

  const chips = keys.map(k => {
    const v = vals[k];
    const num = String(v.val).replace(".", ",");
    // Jednotka je UVNITŘ hodnoty, ne za ní — jinak spadne na vlastní řádek
    // a dlaždice přestane vypadat jako ostatní (popisek / hodnota s malou
    // jednotkou vedle sebe).
    return `<div class="air-chip"><span>${esc(AIR_LABEL[k] || k)}</span>` +
      `<b>${num}<i>${esc(v.unit || "")}</i></b></div>`;
  }).join("");

  const age = state.CHMI_AIR?.age_min;
  body.innerHTML =
    `<div class="air-head">${esc(st.name)} <span class="muted">` +
    `${st.distKm.toFixed(0)} km${st.region ? ` · ${esc(st.region)}` : ""}</span></div>` +
    `<div class="air-grid">${chips}</div>` +
    `<div class="ct-note">Naměřeno státní sítí imisního monitoringu ČHMÚ` +
    `${age != null ? `, hodinový průměr starý ${age} min` : ""}.</div>`;
  panel.classList.add("show");
}

// ── Klimatický normál 1991–2020 z nejbližší stanice ─────────────────────────

const NORMAL_MAX_KM = 40;
const MONTHS = ["lednu", "únoru", "březnu", "dubnu", "květnu", "červnu",
  "červenci", "srpnu", "září", "říjnu", "listopadu", "prosinci"];

export function nearestNormalStation(lat, lon) {
  const st = state.CHMI_NORMALS?.stations;
  if (!st) return null;
  let best = null, bd = Infinity, bk = null;
  for (const [wsi, s] of Object.entries(st)) {
    if (s.lat == null || s.lon == null) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < bd) { bd = d; best = s; bk = wsi; }
  }
  return best && bd <= NORMAL_MAX_KM ? { ...best, wsi: bk, distKm: bd } : null;
}

export function renderNormals(todayMaxC) {
  const panel = document.getElementById("normal-panel");
  const body = document.getElementById("normal-body");
  if (!panel || !body) return;
  panel.classList.remove("show");
  body.innerHTML = "";
  if (!state.inCZ) return;

  const st = nearestNormalStation(state.currentLat, state.currentLon);
  if (!st) return;
  const m = new Date().getMonth();       // 0–11
  const n = st.normals || {};
  const rows = [];

  const pick = (arr) => (Array.isArray(arr) && arr[m] != null ? arr[m] : null);
  const tAvg = pick(n.T), tMax = pick(n.TMA), tMin = pick(n.TMI), sra = pick(n.SRA);

  if (tAvg != null) {
    rows.push(`<div class="ct-row"><span>Průměrná teplota v ${MONTHS[m]}</span>` +
      `<b>${String(tAvg).replace(".", ",")} °C</b></div>`);
  }
  if (tMax != null) {
    // Odchylku ukazujeme jen když máme dnešní maximum z modelu.
    let delta = "";
    if (Number.isFinite(todayMaxC)) {
      const d = todayMaxC - tMax;
      const sign = d >= 0 ? "+" : "−";
      delta = ` <span class="muted">dnes ${sign}${Math.abs(d).toFixed(1).replace(".", ",")}</span>`;
    }
    rows.push(`<div class="ct-row"><span>Obvyklé denní maximum</span>` +
      `<b>${String(tMax).replace(".", ",")} °C</b>${delta}</div>`);
  }
  if (tMin != null) {
    rows.push(`<div class="ct-row"><span>Obvyklé noční minimum</span>` +
      `<b>${String(tMin).replace(".", ",")} °C</b></div>`);
  }
  if (sra != null) {
    rows.push(`<div class="ct-row"><span>Obvyklý měsíční úhrn</span>` +
      `<b>${String(sra).replace(".", ",")} mm</b></div>`);
  }
  if (!rows.length) return;

  const elev = st.elev != null ? `, ${Math.round(st.elev)} m n. m.` : "";
  body.innerHTML = rows.join("") +
    `<div class="ct-note">Stanice ${esc(st.name || st.wsi)} ` +
    `(${st.distKm.toFixed(0)} km${elev}), normál 1991–2020. ` +
    `Hodnoty platí pro výšku stanice — na přepočet podle nadmořské výšky se ` +
    `u měsíčních normálů záměrně nesahá.</div>`;
  panel.classList.add("show");
}

// ── Klimatický kontext: letošní rok proti normálu 1991–2020 ────────────────
// Areálové průměry jsou po krajích, ale mapovat lat/lon na kraj by chtělo
// polygony, které nemáme. Ukazujeme proto celostátní hodnotu (sloupec "CR") —
// je poctivá a nepotřebuje geometrii. Kraje jsou v datech připravené, až bude
// čím je přiřadit.

const MONTHS_SHORT = ["led", "úno", "bře", "dub", "kvě", "črv",
  "čvc", "srp", "zář", "říj", "lis", "pro"];

function regionIndex(code = "CR") {
  const regions = state.CHMI_REGIONAL?.regions || [];
  const i = regions.findIndex(r => r.code === code);
  return i >= 0 ? i : null;
}

export function renderRegionalClimate() {
  const panel = document.getElementById("regional-panel");
  const body = document.getElementById("regional-body");
  if (!panel || !body) return;
  panel.classList.remove("show");
  body.innerHTML = "";
  if (!state.inCZ) return;

  const rg = state.CHMI_REGIONAL;
  const ri = regionIndex("CR");
  if (!rg || ri == null) return;

  const val = (rows, pred) => {
    const row = (rows || []).find(pred);
    const v = row?.v?.[ri];
    return typeof v === "number" ? v : null;
  };

  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  const rows = [];

  // Letošní měsíc proti normálu téhož měsíce
  const curT = val(rg.temp_current, r => r.year === yyyy && r.month === mm);
  const normT = val(rg.temp_normal, r => r.month === mm);
  if (curT != null && normT != null) {
    const d = curT - normT;
    const sign = d >= 0 ? "+" : "−";
    rows.push(`<div class="ct-row"><span>${MONTHS_SHORT[now.getMonth()]} ${yyyy} ` +
      `proti normálu</span><b>${sign}${Math.abs(d).toFixed(1).replace(".", ",")} °C</b> ` +
      `<span class="muted">${String(curT).replace(".", ",")} vs ` +
      `${String(normT).replace(".", ",")}</span></div>`);
  }

  const curP = val(rg.prec_current, r => r.year === yyyy && r.month === mm);
  const normP = val(rg.prec_normal, r => r.month === mm);
  if (curP != null && normP != null && normP > 0) {
    const pct = Math.round((curP / normP) * 100);
    rows.push(`<div class="ct-row"><span>Srážky tento měsíc</span>` +
      `<b>${pct} % normálu</b> <span class="muted">` +
      `${Math.round(curP)} z ${Math.round(normP)} mm</span></div>`);
  }

  // Poslední uzavřený rok proti normálu roku ("Year" řádek v normálech)
  const annual = rg.temp_annual || [];
  const last = annual.length ? annual[annual.length - 1] : null;
  const normYear = val(rg.temp_normal, r => String(r.month).toLowerCase() === "year");
  if (last && typeof last.v?.[ri] === "number" && normYear != null) {
    const d = last.v[ri] - normYear;
    const sign = d >= 0 ? "+" : "−";
    rows.push(`<div class="ct-row"><span>Rok ${esc(last.year)} proti normálu</span>` +
      `<b>${sign}${Math.abs(d).toFixed(1).replace(".", ",")} °C</b> ` +
      `<span class="muted">${String(last.v[ri]).replace(".", ",")} °C</span></div>`);
  }

  if (!rows.length) return;
  const span = annual.length
    ? `${annual[0].year}–${annual[annual.length - 1].year}` : "1961–dnes";
  body.innerHTML = rows.join("") +
    `<div class="ct-note">Areálové průměry ČHMÚ za celou ČR, řada ${esc(span)}, ` +
    `normál ${esc(rg.normal_period || "1991-2020")}.</div>`;
  panel.classList.add("show");
}

// ── Oficiální textová předpověď ─────────────────────────────────────────────

export function renderChmiText() {
  const panel = document.getElementById("chmitext-panel");
  const body = document.getElementById("chmitext-body");
  if (!panel || !body) return;
  panel.classList.remove("show");
  body.innerHTML = "";
  if (!state.inCZ) return;

  const f = state.CHMI_TEXT;
  if (!f?.blocks?.length) return;

  const blocks = f.blocks.map(b =>
    `<p class="ctx-block">${b.headline ? `<b>${esc(b.headline)}</b> ` : ""}` +
    `${esc(b.text)}</p>`).join("");
  body.innerHTML =
    (f.headline ? `<div class="ctx-head">${esc(f.headline)}</div>` : "") +
    blocks +
    `<div class="ct-note">Text ČHMÚ${f.author ? `, ${esc(f.author)}` : ""}` +
    `${f.issued_utc ? `, vydáno ${localHM(f.issued_utc)}` : ""}. ` +
    `Platí pro celou ČR.</div>`;
  panel.classList.add("show");
}

// ── Jeden vstupní bod pro app.js ────────────────────────────────────────────

export function renderChmiExtras(todayMaxC) {
  // Každý panel zvlášť: výjimka v jednom nesmí sebrat ostatní.
  const jobs = [
    ["cotrec", () => renderCotrec()],
    ["convect", () => renderConvect()],
    ["air", () => renderAirMeasured()],
    ["normals", () => renderNormals(todayMaxC)],
    ["regional", () => renderRegionalClimate()],
    ["chmitext", () => renderChmiText()],
  ];
  for (const [name, fn] of jobs) {
    try { fn(); } catch (e) { console.error(`chmidata/${name}:`, e); }
  }
}
