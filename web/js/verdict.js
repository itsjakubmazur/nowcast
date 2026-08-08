import { state, WORKER_BASE } from "./state.js";
import { wImg, wcLabel } from "./icons.js";
import { haversine, localHM, esc, num } from "./utils.js";
import { uiIcon } from "./uiicons.js";
import { assessRainGlobal } from "./globalrain.js";

// ── Geo lookup v GRID ─────────────────────────────────────────────────────────
export function nearestPt(lat, lon) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < state.GRID.pts.length; i++) {
    const d = haversine(lat, lon, state.GRID.pts[i][0], state.GRID.pts[i][1]);
    if (d < bd) { bd = d; best = i; }
  }
  return { id: best, dist: bd };
}

export function nearestNwp(lat, lon) {
  const pts = state.GRID.nwp.pts;
  let best = null, bd = Infinity;
  for (const p of pts) {
    const d = haversine(lat, lon, p[0], p[1]);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

export function stepToLocal(stepIdx) {
  const t0 = new Date(state.GRID.t0_utc);
  const ms = t0.getTime() + (stepIdx + 1) * state.GRID.step_min * 60000;
  return localHM(new Date(ms).toISOString());
}

// ── Jednotné vyhodnocení srážek ──────────────────────────────────────────────
// JEDEN zdroj pravdy pro countdown kartu, badge, šablonový verdikt i klientské
// notifikace. Dřív si každá karta četla jiný zdroj (bod radaru / NWP podmřížka /
// model / ensemble) a uměly si navzájem protiřečit — radarový pixel byl suchý,
// zatímco 3 km vedle lilo a model hlásil déšť za hodinu.
//
// Kombinuje:
//  1. radarovou extrapolaci NEJBLIŽŠÍHO BODU I OKOLÍ (≤ 12 km) — bouřka kousek
//     vedle se počítá; extrapolace navíc míjí body kvůli chybě směru
//  2. stav "prší PRÁVĚ TEĎ" — radarový čas t0 + krok, ve kterém se nacházíme
//  3. ensemble P(déšť) — riziko i tam, kde deterministická dráha nic nemá
//  4. model minutely_15 (blend zdroj) — když radar nic nevidí, model může
//  5. stáří radaru — po 20 minutách už "radar nic nevidí" moc neznamená
const NEIGH_KM = 12;
const MODEL_RAIN_MM_H = 0.2;
const PROB_MIN = 30; // % — od kdy stojí ensemble riziko za zmínku

export function assessRain(ptId, minutely) {
  const G = state.GRID;
  // ptId == null → místo mimo pokrytí českého radaru: světový režim
  // (RainViewer vzorky + minutely_15, stejný tvar výsledku)
  if (ptId == null || !G?.pts?.[ptId]) return assessRainGlobal(minutely);
  minutely = minutely ?? state._lastMinutely ?? null;
  const stepMin = G.step_min || 10;
  const t0ms = new Date(G.t0_utc).getTime();
  const now = Date.now();
  const radarAgeMin = Math.max(0, Math.round((now - t0ms) / 60000));

  // 1+2) radar: vlastní bod a okolí — vyber kandidáta s nejdřívějším začátkem;
  // vlastní bod má přednost, pokud nezačíná výrazně později než soused
  const [plat, plon] = G.pts[ptId];
  let best = null;
  for (let i = 0; i < G.pts.length; i++) {
    const a = G.act[String(i)];
    if (!a) continue;
    const dKm = i === ptId ? 0 : haversine(plat, plon, G.pts[i][0], G.pts[i][1]);
    if (dKm > NEIGH_KM) continue;
    const startMs = t0ms + (a[0] + 1) * stepMin * 60000;
    const endMs = t0ms + (a[1] + 1) * stepMin * 60000;
    const cand = { startMs, endMs, peak: a[2], total: a[3], nearKm: Math.round(dKm) };
    if (!best
      || startMs < best.startMs - 10 * 60000
      || (Math.abs(startMs - best.startMs) <= 10 * 60000 && dKm < best.nearKm)) {
      best = cand;
    }
  }

  const probSeries = G.prob?.[String(ptId)] || null;
  const probNow = probSeries?.[0] ?? null;
  const probAt = ms => {
    if (!probSeries) return null;
    const idx = Math.floor((ms - t0ms) / (stepMin * 60000)) - 1;
    return idx >= 0 && idx < probSeries.length ? probSeries[idx] : null;
  };

  // Shoda modelu s radarem — pro poctivou argumentaci v UI ("radar i model
  // se shodují" vs. "zatím jen radarová extrapolace"). Model minutely_15 jede
  // v 15min slotech od "teď".
  const modelAtMs = ms => {
    if (!minutely?.length) return null;
    const idx = Math.max(0, Math.floor((ms - now) / (15 * 60000)));
    return idx < minutely.length ? (minutely[idx]?.precip ?? null) : null;
  };

  if (best) {
    const status = now >= best.startMs && now <= best.endMs ? "raining"
      : now < best.startMs ? "soon" : null;
    if (status) {
      const mv = modelAtMs(status === "raining" ? now : best.startMs);
      const modelAgrees = mv == null ? null : mv >= 0.1;
      return { status, ...best, prob: probAt(best.startMs), modelAgrees,
        radarAgeMin, source: best.nearKm > 0 ? "radar-okolí" : "radar" };
    }
    // interval už proběhl (starý radar) — spadni do model/ensemble větve
  }

  // 3) model minutely_15 — první 15min slot s deštěm
  let modelStartMs = null, modelPeak = null;
  if (minutely?.length) {
    const idx = minutely.findIndex(m => (m.precip ?? 0) >= MODEL_RAIN_MM_H);
    if (idx >= 0) {
      modelStartMs = now + idx * 15 * 60000; // sloty jedou od "teď"
      modelPeak = Math.max(...minutely.map(m => m.precip ?? 0));
    }
  }

  // 4) ensemble — první krok s P ≥ PROB_MIN
  let probStartMs = null, probMax = null;
  if (probSeries) {
    probMax = Math.max(...probSeries);
    const idx = probSeries.findIndex(p => p >= PROB_MIN);
    if (idx >= 0) probStartMs = t0ms + (idx + 1) * stepMin * 60000;
  }

  // model říká "prší hned teď" (první slot) → ber jako déšť, radar ho jen nevidí
  if (minutely?.length && (minutely[0].precip ?? 0) >= MODEL_RAIN_MM_H
      && modelStartMs != null && modelStartMs <= now + 5 * 60000) {
    return { status: "raining", startMs: now, endMs: now + 30 * 60000,
      peak: modelPeak, total: null, nearKm: null, prob: probNow,
      radarAgeMin, source: "model" };
  }

  if (modelStartMs != null || (probStartMs != null && probStartMs > now)) {
    const cands = [modelStartMs, probStartMs].filter(v => v != null && v > now);
    const startMs = cands.length ? Math.min(...cands) : (modelStartMs ?? probStartMs);
    return { status: "possible", startMs, endMs: null, peak: modelPeak,
      total: null, nearKm: null, prob: probMax, radarAgeMin,
      source: modelStartMs != null && (startMs === modelStartMs) ? "model" : "ensemble" };
  }

  return { status: "dry", startMs: null, endMs: null, peak: null, total: null,
    nearKm: null, prob: probMax, radarAgeMin, source: "radar+model" };
}

// ── JS šablonový verdikt (okamžitý, vždy dostupný fallback) ─────────────────
function rainIntensity(peak) {
  if (peak < 0.5) return "mrholení";
  if (peak < 2.5) return "slabý déšť";
  if (peak < 7.5) return "mírný déšť";
  if (peak < 15) return "vydatný déšť";
  return "přívalový déšť";
}
function gustsKmh(ms) { return Math.round(ms * 3.6 / 10) * 10; }
const COLOR_CZ = { yellow: "žlutou", orange: "oranžovou", red: "červenou" };

export function warningsForPt(ptId) {
  // Výstrahy ČHMÚ existují jen pro body českého gridu
  if (ptId == null || !state.GRID?.warnings || !state.GRID?.wmatch) return [];
  const matchIdx = new Set(state.GRID.wmatch[String(ptId)] || []);
  const hits = state.GRID.warnings.filter((w, wi) => w.global || matchIdx.has(wi));
  // ČHMÚ tutéž výstrahu publikuje zvlášť pro každou zasaženou oblast, takže
  // se na jednom místě potkalo i 3× "Riziko požárů". Deduplikuj podle jevu,
  // barvy a platnosti — pro uživatele je to jedna a tatáž výstraha.
  const seen = new Set();
  return hits.filter(w => {
    const key = `${w.event}|${w.color}|${w.onset_utc}|${w.expires_utc}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Pruh výstrah pod topbarem. Sazba jednoho štítku na jednu výstrahu se
// neosvědčila: ČHMÚ vydává tentýž jev zvlášť na každý den platnosti, takže
// se v pruhu sešlo třináct štítků. Flex je smrskl na minimální šířku, text
// se zalomil na tři řádky a kulaté rohy z nich udělaly kolečka.
//
// Řešení má dvě půlky. Tady se výstrahy shlukují podle jevu — jeden jev je
// právě jeden štítek, ať ho ČHMÚ vydalo jednou nebo pětkrát — a řadí se od
// nejzávažnější; v CSS se pak štítek nesmí smrsknout.
//
// Počet opakování se ZÁMĚRNĚ nepíše. Zkoušel jsem "3×", ale nic to neříká:
// tři výstrahy na tři dny za sebou nejsou třikrát horší vedro, je to jedno
// vedro do čtvrtka. Do štítku proto jde jen jev a do bublinkové nápovědy
// celý rozsah platnosti, což je informace, kterou člověk opravdu chce.
// A ještě o patro výš: "Silná zátěž teplem" vedle "Velmi silné zátěže teplem"
// není druhá informace, je to tatáž věc o stupeň slabší. ČHMÚ takhle vydává
// celé rodiny jevů ve stupních (silný / velmi silný / extrémní vítr, zátěž
// teplem, bouřky…) a v pruhu z toho vzniká šum. Ze skupiny se proto ukáže jen
// nejsilnější stupeň.
//
// Sloučení se dělá podle názvu, což je křehké, takže je schválně opatrné:
// zahazují se JEN zesilující přívlastky, nikdy slova určující směr jevu.
// Proto "vysoké"/"nízké" v seznamu nejsou — jinak by se "Vysoké teploty" a
// "Nízké teploty" slily do jedné rodiny "teploty", což jsou opačné jevy.
//   Silná / Velmi silná / Extrémní zátěž teplem → "zátěž teplem"   (slije se)
//   Vysoké teploty vs. Velmi vysoké teploty     → "vysoké teploty" (slije se)
//   Vysoké teploty vs. Nízké teploty            → různé rodiny      (nesleje)
const SEVERITY = { red: 3, orange: 2, yellow: 1 };
const MAX_VISIBLE_CHIPS = 3;
const AMPLIFIERS = new Set([
  "velmi", "extrémně", "extrémní", "mimořádně", "mimořádná", "mimořádné",
  "silná", "silný", "silné", "vydatný", "vydatná", "vydatné",
]);

// Rodina jevu = název bez zesilujících přívlastků na začátku.
function familyKey(event) {
  const words = String(event || "").toLowerCase().trim().split(/\s+/);
  let i = 0;
  while (i < words.length && AMPLIFIERS.has(words[i])) i++;
  // Kdyby byl název složený jen z přívlastků, radši ho nech být celý —
  // prázdný klíč by slil všechno se vším.
  return (i < words.length ? words.slice(i) : words).join(" ");
}

// Stupeň zapsaný v názvu. Slouží jen jako rozhodčí při shodě barev.
function nameRank(event) {
  const e = String(event || "").toLowerCase();
  if (e.includes("extrém") || e.includes("mimořádn")) return 3;
  if (e.includes("velmi")) return 2;
  return 1;
}

// Rozsah přes víc dní potřebuje i den, ne jen hodinu — "platí 08:00 – 20:00"
// by u třídenní výstrahy lhalo. Dnešek zůstává bez data, ať to není upovídané.
function dayHM(utcIso) {
  const d = new Date(utcIso);
  const day = d.toLocaleDateString("cs-CZ", { timeZone: state.tz, weekday: "short", day: "numeric", month: "numeric" });
  const today = new Date().toLocaleDateString("cs-CZ", { timeZone: state.tz, weekday: "short", day: "numeric", month: "numeric" });
  const hm = localHM(utcIso);
  return day === today ? hm : `${day} ${hm}`;
}

function groupSpan(g) {
  const from = g.onset ? dayHM(g.onset) : null;
  const to = g.expires ? dayHM(g.expires) : null;
  if (from && to) return `platí ${from} – ${to}`;
  return from ? `platí od ${from}` : "";
}

export function warningChips(warns) {
  const groups = new Map();
  for (const w of warns) {
    const key = familyKey(w.event);
    const rank = SEVERITY[w.color] || 0;
    const nrank = nameRank(w.event);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        event: w.event, color: w.color, rank, nrank,
        onset: w.onset_utc, expires: w.expires_utc,
      });
      continue;
    }
    // O vítězi rozhoduje barva, teprve při shodě stupeň v názvu. Barva je to
    // jediné, co ČHMÚ garantuje napříč jevy; název je jen text.
    const stronger = rank > g.rank || (rank === g.rank && nrank > g.nrank);
    if (stronger) {
      // Slabší stupeň se zahodí celý včetně své platnosti. Roztáhnout rozsah
      // přes celou rodinu by lhalo: kdyby "silná" trvala do neděle a "velmi
      // silná" jen v sobotu, štítek by tvrdil, že do neděle platí ta silnější.
      g.event = w.event; g.color = w.color; g.rank = rank; g.nrank = nrank;
      g.onset = w.onset_utc; g.expires = w.expires_utc;
      continue;
    }
    if (rank < g.rank || nrank < g.nrank) continue;   // slabší stupeň → pryč
    // Stejně silná výstraha vydaná znovu (typicky na další den): platnost se
    // roztáhne od prvního začátku po poslední konec.
    if (w.onset_utc && w.onset_utc < g.onset) g.onset = w.onset_utc;
    if (w.expires_utc && w.expires_utc > g.expires) g.expires = w.expires_utc;
  }
  const list = [...groups.values()].sort((a, b) => b.rank - a.rank || b.nrank - a.nrank);
  const chip = g => {
    const cls = ["yellow", "orange", "red"].includes(g.color) ? g.color : "unknown";
    const span = groupSpan(g);
    const title = span ? ` title="${esc(g.event)} — ${esc(span)}"` : "";
    return `<span class="warn-chip c-${cls}"${title}>${esc(g.event)}</span>`;
  };
  const shown = list.slice(0, MAX_VISIBLE_CHIPS).map(chip);
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`<span class="warn-chip warn-chip-more">+${rest}</span>`);
  return { html: shown.join(""), allHtml: list.map(chip).join(""), count: list.length };
}

export function templateVerdict(ptId) {
  const sentences = [];
  const warns = warningsForPt(ptId);
  const chips = warns.length ? warningChips(warns) : null;

  if (warns.length) {
    // Ne první v pořadí, ale nejzávažnější — jinak by karta mluvila o žluté
    // výstraze, zatímco pruh nad ní svítí oranžovou. Pořadí, v jakém výstrahy
    // chodí z ČHMÚ, není žebříček.
    const w = [...warns].sort((a, b) =>
      (SEVERITY[b.color] || 0) - (SEVERITY[a.color] || 0)
      || nameRank(b.event) - nameRank(a.event))[0];
    const barva = COLOR_CZ[w.color] || w.color;
    sentences.push(`ČHMÚ vydalo ${barva} výstrahu (${w.event}), platnou od ${localHM(w.onset_utc)} do ${localHM(w.expires_utc)}.`);
  }

  const as = assessRain(ptId);
  if (as?.status === "raining") {
    const kde = as.nearKm > 5 ? ` (jádro ~${as.nearKm} km odtud)` : "";
    sentences.push(`${precipDescr(as.peak).now}${kde}${as.peak != null ? `, špička kolem ${peakStr(as.peak)}` : ""}.`);
  } else if (as?.status === "soon") {
    const intenzita = rainIntensity(as.peak ?? 0);
    const total = as.total == null ? "" : as.total < 1 ? ", úhrn do 1 mm" : `, úhrn kolem ${Math.round(as.total)} mm`;
    sentences.push(`V nejbližších hodinách se očekává ${intenzita} od ${localHM(new Date(as.startMs).toISOString())}${as.endMs ? ` do ${localHM(new Date(as.endMs).toISOString())}` : ""}${total}.`);
  } else if (as?.status === "possible") {
    sentences.push(`Radar zatím srážky nezachytil, ${as.source === "model" ? "model je ale čeká" : `ensemble je připouští (P≈${as.prob} %)`} přibližně od ${localHM(new Date(as.startMs).toISOString())}.`);
  } else if (!warns.length) {
    sentences.push("Srážky se v nejbližších hodinách neočekávají.");
  }

  // NWP podmřížka pokrývá jen ČR — ve světovém režimu tuhle větu vynech
  const nwp = ptId != null && state.GRID?.pts?.[ptId]
    ? nearestNwp(state.GRID.pts[ptId][0], state.GRID.pts[ptId][1]) : null;
  if (nwp && nwp[2]) {
    sentences.push(`Srážky jsou možné i v dalším výhledu, přibližně od ${localHM(nwp[2])}.`);
  }
  if (nwp && nwp[3] && nwp[3] >= 8) {
    sentences.push(`Vítr může v nárazech dosahovat kolem ${gustsKmh(nwp[3])} km/h.`);
  }

  return { text: sentences.join(" "), chips };
}

// ── Rain status badge ─────────────────────────────────────────────────────────
export function renderRainBadge(ptId) {
  const wrap = document.getElementById("rain-badge-wrap");
  if (!wrap) return;
  const as = assessRain(ptId);
  const warns = warningsForPt(ptId);
  const hasThunder = warns.some(w => /bouř|thunder/i.test(w.event));
  let cls = "green", msg = "Bez srážek v nejbližší době";
  if (hasThunder) {
    cls = "red"; msg = "Výstraha: " + warns.find(w => /bouř/i.test(w.event))?.event;
  } else if (as && (as.status === "raining" || as.status === "soon")) {
    const when = localHM(new Date(as.startMs).toISOString());
    const peak = as.peak ?? 0;
    const descr = precipDescr(as.peak);
    if (as.status === "raining") {
      // mrholení není poplach — žlutá místo červené
      cls = peak < 0.5 ? "yellow" : "red";
      msg = `${descr.now}${as.nearKm > 5 ? ` (~${as.nearKm} km)` : ""}`;
    }
    else if (peak >= 7.5) { cls = "red"; msg = `${descr.fut} od ${when}`; }
    else if (peak >= 2.5) { cls = "orange"; msg = `${descr.fut} od ${when}`; }
    else { cls = "yellow"; msg = `${descr.fut} od ${when}`; }
  } else if (as?.status === "possible") {
    cls = "yellow"; msg = `Srážky možné od ~${localHM(new Date(as.startMs).toISOString())}`;
  } else if (warns.length) {
    cls = "yellow"; msg = warns[0].event;
  }
  wrap.innerHTML = `<div class="rain-badge ${cls}"><span class="rb-dot"></span>${esc(msg)}</div>`;
}

// ── Hero countdown "Déšť za X min" ────────────────────────────────────────────
let _countdownTimer = null;
let _countdownTarget = null; // { startMs, endMs, peak } nebo null

// Typ srážek (déšť / sníh / smíšené) — hint z Open-Meteo hodinovky, nastavuje
// showFc24 po parseFc24. Radar sám typ nezná, model ano.
let _precipHint = "rain";

// Slovník podle SKUTEČNÉ intenzity (mm/h ze špičky radaru/modelu) — 0.3 mm/h
// není "déšť", ale mrholení; 20 mm/h není "déšť", ale průtrž. Prahy odpovídají
// běžné meteorologické klasifikaci (slabý < 2.5 < mírný < 7.5 < vydatný < 15).
const INT_RAIN = [
  [0.5,      { fut: "Mrholení", now: "Právě mrholí", icon: "drizzle" }],
  [2.5,      { fut: "Slabý déšť", now: "Právě slabě prší", icon: "partly-cloudy-day-rain" }],
  [7.5,      { fut: "Déšť", now: "Právě prší", icon: "rain" }],
  [15,       { fut: "Vydatný déšť", now: "Právě vydatně prší", icon: "rain" }],
  [Infinity, { fut: "Přívalový déšť", now: "Právě lije", icon: "extreme-day-rain" }],
];
const INT_SNOW = [
  [1,        { fut: "Slabé sněžení", now: "Právě slabě sněží", icon: "snow" }],
  [5,        { fut: "Sněžení", now: "Právě sněží", icon: "snow" }],
  [Infinity, { fut: "Husté sněžení", now: "Právě hustě sněží", icon: "snow" }],
];
const INT_MIXED = { fut: "Déšť se sněhem", now: "Padá déšť se sněhem", icon: "sleet" };

export function precipDescr(peak, hint = _precipHint) {
  if (hint === "mixed") return INT_MIXED;
  const table = hint === "snow" ? INT_SNOW : INT_RAIN;
  if (peak == null) return table[Math.floor(table.length / 2)][1]; // bez špičky → střední slovo
  return (table.find(([max]) => peak < max) || table[table.length - 1])[1];
}

// Kontext z hodinovky pro nedeštivý hero panel (vítr/mlha/horko/mráz/CAPE) —
// nastavuje showFc24 spolu s typem srážek.
let _fcX = null;

export function setPrecipTypeHint(fc) {
  const h3 = (fc?.hourlyFull || []).slice(0, 3);
  const snow = h3.some(x => (x.snow ?? 0) > 0);
  const cold = h3.length && h3[0].tempRaw != null && h3[0].tempRaw <= 1;
  _precipHint = snow ? (cold ? "snow" : "mixed") : "rain";

  const h6 = (fc?.hourlyFull || []).slice(0, 6);
  if (!h6.length) { _fcX = null; return; }
  let gustMax = null, gustT = null;
  for (const x of h6) {
    if (x.gust != null && (gustMax == null || x.gust > gustMax)) { gustMax = x.gust; gustT = x.t; }
  }
  const temps = h6.map(x => x.tempRaw).filter(v => v != null);
  _fcX = {
    wcNow: h6[0].wc, tNow: h6[0].tempRaw,
    gustMax, gustT,
    tMax6: temps.length ? Math.max(...temps) : null,
    tMin6: temps.length ? Math.min(...temps) : null,
    capeMax: Math.max(...h6.map(x => x.cape ?? 0)),
  };
}

// Radar nad ~100 mm/h už intenzitu nekvantifikuje — odrazivost tam saturuje
// a bývá to spíš kroupy nebo pás tání než déšť. Vypsat "150 mm/h" (což je náš
// vlastní strop, ne měření) je proto poplašná zpráva vydávaná za údaj.
function peakStr(mm) {
  return mm >= 100 ? "přes 100 mm/h" : `${num(mm)} mm/h`;
}

export function renderRainCountdown(ptId, minutely) {
  const el = document.getElementById("rain-countdown");
  if (!el) return;
  // Český režim potřebuje GRID+MANIFEST; světový (ptId null) jede bez nich
  if (ptId != null && (!state.GRID || !state.MANIFEST)) { el.classList.remove("show"); return; }

  clearInterval(_countdownTimer);
  const as = assessRain(ptId, minutely);
  const radarT0 = ptId != null ? state.GRID.t0_utc
    : (state._globalRadar?.frames?.[0] ? new Date(state._globalRadar.frames[0].tMs).toISOString() : null);
  const radarHM = radarT0 ? localHM(radarT0) : null;
  const staleNote = as && as.radarAgeMin != null && as.radarAgeMin > 20 && radarHM
    ? ` · radar ${radarHM} (${as.radarAgeMin} min starý!)` : "";

  if (as && (as.status === "raining" || as.status === "soon")) {
    _countdownTarget = { ...as };
    _tickCountdown();
    _countdownTimer = setInterval(_tickCountdown, 30000);
    return;
  }

  _countdownTarget = null;
  el.classList.add("show", "clear");
  el.classList.remove("imminent");

  if (as?.status === "possible") {
    // radar nic nezachytil, ale model/ensemble déšť připouští — NErikej "bez srážek"
    document.getElementById("rc-icon").innerHTML = wImg("partly-cloudy-day-rain");
    document.getElementById("rc-title").textContent =
      `Srážky možné od ~${localHM(new Date(as.startMs).toISOString())}`;
    const src = as.source === "model" ? "model" : `ensemble P≈${as.prob} %`;
    document.getElementById("rc-sub").textContent =
      `Radar zatím nic nezachytil, ${src} ale déšť připouští${staleNote}.`;
    return;
  }

  // ── Beze srážek: panel řekne to nejdůležitější o počasí, co skutečně je ──
  const nwp = ptId != null && state.GRID?.pts?.[ptId]
    ? nearestNwp(state.GRID.pts[ptId][0], state.GRID.pts[ptId][1]) : null;
  const drySub = (nwp && nwp[2]
    ? `Model naznačuje déšť později, přibližně od ${localHM(nwp[2])}.`
    : radarHM
      ? `Radar ${radarHM} i model se shodují: beze srážek.`
      : `Podle modelu se srážky neočekávají.`) + staleNote;

  const thunderWarn = warningsForPt(ptId).find(w => /bouř/i.test(w.event));
  const x = _fcX;

  const setHero = (icon, title, sub) => {
    document.getElementById("rc-icon").innerHTML = wImg(icon);
    document.getElementById("rc-title").textContent = title;
    document.getElementById("rc-sub").textContent = sub;
  };

  if (thunderWarn) {
    setHero("thunderstorms-day", "Riziko bouřek",
      `Výstraha ČHMÚ (${thunderWarn.event}) platí do ${localHM(thunderWarn.expires_utc)} · radar zatím srážky nevidí.`);
  } else if (x && x.capeMax >= 800) {
    setHero("thunderstorms-day", "Bouřkový potenciál",
      `Energie pro bouřky až ${Math.round(x.capeMax)} J/kg — přeháňky se mohou vyvinout rychle. ${drySub}`);
  } else if (x && x.gustMax != null && x.gustMax >= 45) {
    setHero("wind", `Vítr v nárazech až ${Math.round(x.gustMax)} km/h`,
      `Nejsilnější kolem ${x.gustT} · srážky se nečekají.`);
  } else if (x && (x.wcNow === 45 || x.wcNow === 48)) {
    setHero("fog-day", "Mlha", `Omezená dohlednost · beze srážek. ${drySub}`);
  } else if (x && x.tMax6 != null && x.tMax6 >= 30) {
    setHero("clear-day", `Horko, až ${Math.round(x.tMax6)} °C`, drySub);
  } else if (x && x.tMin6 != null && x.tMin6 <= -3) {
    setHero("snow", `Mráz, až ${Math.round(x.tMin6)} °C`, drySub);
  } else {
    const nowStr = x && x.wcNow != null
      ? `${wcLabel(x.wcNow)}${x.tNow != null ? `, ${Math.round(x.tNow)} °C` : ""} · ` : "";
    setHero("clear-day", "Nejbližší 2 h bez srážek", nowStr + drySub);
  }
}

// Poctivá argumentace zdrojů — kdo tvrzení potvrzuje a kdo ne. "Déšť za
// 1 min" podložený jen radarovou extrapolací je jiná zpráva než tentýž
// odpočet, na kterém se radar, model i ensemble shodují.
function sourcesClause({ source, modelAgrees, prob }) {
  if (source === "model") return " · hlásí model, radar bod nevidí";
  const parts = [];
  if (modelAgrees === true) parts.push("radar i model se shodují");
  else if (modelAgrees === false) parts.push("jen radar, model zatím nic nevidí");
  else parts.push("radarová extrapolace");
  if (prob != null) parts.push(`jistota ~${prob} %`);
  return " · " + parts.join(", ");
}

function _tickCountdown() {
  const el = document.getElementById("rain-countdown");
  if (!el || !_countdownTarget) return;
  const now = Date.now();
  const { startMs, endMs, peak, total, prob, nearKm, source, radarAgeMin, modelAgrees } = _countdownTarget;
  const descr = precipDescr(peak);
  el.classList.add("show", "imminent");
  el.classList.remove("clear");
  document.getElementById("rc-icon").innerHTML = wImg(descr.icon);

  const nearStr = nearKm != null && nearKm > 5 ? ` · jádro ~${nearKm} km odtud` : "";
  const staleStr = radarAgeMin > 20 ? ` · radar ${radarAgeMin} min starý` : "";
  const srcStr = sourcesClause({ source, modelAgrees, prob });

  if (now < startMs) {
    const minsAway = Math.round((startMs - now) / 60000);
    const durMin = endMs ? Math.round((endMs - startMs) / 60000) : null;
    document.getElementById("rc-title").innerHTML =
      `${descr.fut} za <span class="rc-timer">${minsAway} min</span>`;
    document.getElementById("rc-sub").textContent =
      `${localHM(new Date(startMs).toISOString())}${endMs ? `–${localHM(new Date(endMs).toISOString())}` : ""}`
      + `${durMin ? ` · potrvá ~${durMin} min` : ""}${peak != null ? ` · špička ${peakStr(peak)}` : ""}${srcStr}${nearStr}${staleStr}`;
  } else if (!endMs || now <= endMs) {
    const minsLeft = endMs ? Math.round((endMs - now) / 60000) : null;
    document.getElementById("rc-title").innerHTML = minsLeft != null
      ? `${descr.now} <span class="rc-timer">(ještě ~${Math.max(minsLeft, 1)} min)</span>`
      : descr.now;
    document.getElementById("rc-sub").textContent =
      `${peak != null ? `Špička ${peakStr(peak)}` : "Podle aktuálních dat"}${total != null ? ` · úhrn ~${num(total)} mm` : ""}${srcStr}${nearStr}${staleStr}`;
  } else {
    document.getElementById("rc-title").textContent = "Přeháňka odezněla";
    document.getElementById("rc-sub").textContent = `${total != null ? `Úhrn ~${num(total)} mm · ` : ""}další výhled v modelu`;
    el.classList.remove("imminent");
    el.classList.add("clear");
    document.getElementById("rc-icon").innerHTML = wImg("partly-cloudy-day-rain");
    clearInterval(_countdownTimer);
  }
}

// ── AI verdikt (Cloudflare Worker, cachovaný) ────────────────────────────────
// Verzi zvyš při každé změně promptu/formátu na workeru — jinak stará
// (třeba uťatá) odpověď přežije v localStorage i po opravě serveru.
const AI_CACHE_KEY = "nowcast_ai_verdict_cache_v3";
const AI_CACHE_TTL_MS = 30 * 60 * 1000; // ať odpovídá edge cache TTL na workeru

function aiCacheGet(key) {
  try {
    const all = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}");
    const entry = all[key];
    if (entry && Date.now() - entry.t < AI_CACHE_TTL_MS) return entry.text;
  } catch { /* ignore */ }
  return null;
}
function aiCacheSet(key, text) {
  try {
    const all = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}");
    all[key] = { text, t: Date.now() };
    // drž cache malou
    const keys = Object.keys(all);
    if (keys.length > 40) {
      keys.sort((a, b) => all[a].t - all[b].t);
      for (const k of keys.slice(0, keys.length - 40)) delete all[k];
    }
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

async function fetchAiVerdictAttempt(lat, lon, label, radar) {
  state.verdictCtrl?.abort();
  const ctrl = new AbortController();
  state.verdictCtrl = ctrl;
  // 20 s, ne 12. Sonda proti nasazenému webu ukazovala u /verdict "blocked by
  // CORS policy: No 'Access-Control-Allow-Origin' header" — což vypadalo na
  // rozbitý worker. Nebyl: dotaz na tentýž endpoint ze serveru vrátil HTTP 200
  // i s hlavičkou "Access-Control-Allow-Origin: *" a hotovým textem. Prohlížeč
  // takhle hlásí i request, který jsme sami přerušili — a přerušoval se, protože
  // generování při prázdné cache trvá přes dvanáct vteřin. Karta mezitím ukazuje
  // šablonový verdikt, takže čekání navíc nikoho nezdržuje.
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const url = `${WORKER_BASE}/verdict?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&label=${encodeURIComponent(label || "")}${radar ? `&radar=${radar}` : ""}`;
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`AI verdikt: worker vrátil HTTP ${r.status}`, await r.text().catch(() => ""));
      return null;
    }
    const data = await r.json();
    return data.text || null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name !== "AbortError") console.warn("AI verdikt: fetch selhal", e);
    return null;
  }
}

export async function fetchAiVerdict(lat, lon, label) {
  // radarový stav patří do cache klíče — text "prší" nesmí přežít do sucha a naopak
  let radar = "";
  try {
    const id = state.inCZ && state.GRID ? nearestPt(lat, lon).id : null;
    radar = assessRain(id)?.status || "";
  } catch { /* bez radarového kontextu jede verdikt dál */ }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}|${radar}`;
  const cached = aiCacheGet(key);
  if (cached) return cached;

  // Free-tier Gemini kvóta občas hodí 429/5xx na jeden pokus — jeden rychlý
  // retry to většinou spolehlivě zachrání, aniž by to uživatel poznal.
  let text = await fetchAiVerdictAttempt(lat, lon, label, radar);
  if (!text) {
    await new Promise(res => setTimeout(res, 1200));
    text = await fetchAiVerdictAttempt(lat, lon, label, radar);
  }
  if (text) aiCacheSet(key, text);
  return text;
}

export function renderVerdictText(chips, templateText, aiText) {
  const el = document.getElementById("verdict");
  const body = aiText
    ? `<div class="verdict-ai-badge">${uiIcon("sparkle")}AI meteorolog</div><div class="verdict-text">${esc(aiText).replace(/\n\n/g, "<br><br>")}</div>`
    : `<div class="verdict-text">${templateText}</div>`;
  el.innerHTML = body;

  // Výstrahy patří na první pohled — do glass pruhu pod topbarem, ne dovnitř karty
  renderAlertBar(chips);
}

// Pruh výstrah. `chips` je výstup warningChips(), nebo cokoli prázdného.
let _alertWired = false;
function renderAlertBar(chips) {
  const bar = document.getElementById("alert-bar");
  if (!bar) return;
  if (!chips || !chips.count) {
    bar.innerHTML = "";
    bar.classList.remove("show", "expanded");
    bar.removeAttribute("title");
    return;
  }

  bar._chips = chips;
  const expanded = bar.classList.contains("expanded");
  bar.innerHTML = expanded ? chips.allHtml : chips.html;
  bar.classList.add("show");
  bar.title = expanded ? "Klepnutím sbalit" : `Aktivní výstrahy: ${chips.count} — klepnutím rozbalit`;

  if (_alertWired) return;
  _alertWired = true;
  const toggle = () => {
    const b = document.getElementById("alert-bar");
    if (!b?._chips) return;
    b.classList.toggle("expanded");
    renderAlertBar(b._chips);
  };
  bar.addEventListener("click", toggle);
  bar.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
}

// ── „Zeptej se na počasí" — chat nad daty přes worker /ask ──────────────────
export function initAiAsk() {
  const row = document.getElementById("ai-ask-row");
  const input = document.getElementById("ai-ask");
  const send = document.getElementById("ai-ask-send");
  const answer = document.getElementById("ai-answer");
  if (!row || !input || !send || !answer) return;

  async function submit() {
    const q = input.value.trim();
    if (!q || state.currentLat == null) return;
    answer.textContent = "Přemýšlím…";
    answer.classList.add("show");
    send.disabled = true;
    try {
      const url = `${WORKER_BASE}/ask?lat=${state.currentLat.toFixed(4)}&lon=${state.currentLon.toFixed(4)}`
        + `&label=${encodeURIComponent(state.currentLabel || "")}&q=${encodeURIComponent(q)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      answer.textContent = data.text || "Odpověď se nepodařilo získat — zkus to za chvíli.";
    } catch {
      answer.textContent = "Odpověď se nepodařilo získat — zkus to za chvíli.";
    } finally {
      send.disabled = false;
    }
  }
  send.addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
}

// Zobrazí chat řádek, jakmile je vybrané místo (volá se ze showForecast)
export function showAiAsk() {
  document.getElementById("ai-ask-row")?.classList.add("show");
}

// ── Přesnost nowcastu (accuracy.json) ────────────────────────────────────────
export function renderAccuracyLine() {
  const el = document.getElementById("accuracy-line");
  if (!el) return;
  // Statistika přesnosti platí pro český radarový nowcast — mimo ČR ji skryj
  if (!state.inCZ) { el.classList.remove("show"); return; }
  const acc = state.ACCURACY;
  if (!acc || !acc.leadtime_10min?.mae_mm_h == null || !acc.n_runs) {
    el.classList.remove("show");
    return;
  }
  const l10 = acc.leadtime_10min;
  if (l10.mae_mm_h == null) { el.classList.remove("show"); return; }
  // přesnost podle lead-time: +10/+20/+30 min vedle sebe — poctivě ukazuje,
  // jak extrapolace s časem degraduje
  const leads = [["+10", acc.leadtime_10min], ["+20", acc.leadtime_20min], ["+30", acc.leadtime_30min]]
    .filter(([, l]) => l && l.hit_rate_pct != null);
  const perLead = leads.length > 1
    ? ` · shoda ${leads.map(([t, l]) => `<b>${t}′ ${Math.round(l.hit_rate_pct)} %</b>`).join(" / ")}`
    : ` · shoda příchodu srážek <b>${l10.hit_rate_pct} %</b>`;
  el.innerHTML = `${uiIcon("chart")}Přesnost nowcastu (${acc.window_days} dní): MAE <b>${num(l10.mae_mm_h, 2)} mm/h</b>${perLead}` +
    ` <span style="opacity:.7">(n=${l10.n})</span>`;
  el.classList.add("show");
  el.title = acc.method || "";
}

// ── "Trefili jsme se?" — verifikace po dnech ─────────────────────────────────
// Radikální transparentnost: sloupec za každý z posledních 7 dní ukazuje,
// v kolika % out-of-sample hindcastů (+10 min) nowcast správně řekl
// prší/neprší. Žádná velká aplikace tohle nepublikuje — my měříme, tak
// můžeme.
export function renderVerifCard() {
  const el = document.getElementById("verif-panel");
  if (!el) return;
  const daily = state.ACCURACY?.daily;
  if (!state.inCZ || !daily?.length) { el.classList.remove("show"); return; }

  const bars = daily.map(d => {
    const pct = Math.round(d.hit_rate_pct);
    const day = new Date(d.date + "T12:00:00");
    const label = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"][day.getDay()];
    const cls = pct >= 90 ? "good" : pct >= 75 ? "mid" : "bad";
    // Počet běhů a MAE žily jen v `title`, který se na dotyku nezobrazí
    // a odečítač ho čte nespolehlivě. Stejný text jde i do aria-label.
    const popis = `${d.date}: shoda ${pct} % (${d.n_runs} běhů, MAE ${num(d.mae_mm_h, 2)} mm/h)`;
    return `<div class="vf-col" title="${popis}" aria-label="${popis}">
      <div class="vf-bar-wrap"><div class="vf-bar ${cls}" style="height:${Math.max(8, pct)}%"></div></div>
      <div class="vf-pct">${pct}</div>
      <div class="vf-day">${label}</div>
    </div>`;
  }).join("");

  const last = daily[daily.length - 1];
  el.innerHTML = `
    <h2 class="vf-title">Trefili jsme se? <span class="vf-sub">shoda prší/neprší v +10 min, po dnech</span></h2>
    <div class="vf-row">${bars}</div>
    <div class="vf-note">Poctivá out-of-sample verifikace: predikci vždy porovnáme s tím, co radar
    následně skutečně změřil. Včera: <b>${Math.round(last.hit_rate_pct)} %</b>.</div>`;
  el.classList.add("show");
}
