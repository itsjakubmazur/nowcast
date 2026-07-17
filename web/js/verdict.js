import { state, WORKER_BASE } from "./state.js";
import { wImg } from "./icons.js";
import { haversine, localHM, esc } from "./utils.js";

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
  if (!G?.pts?.[ptId]) return null;
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

  if (best) {
    const status = now >= best.startMs && now <= best.endMs ? "raining"
      : now < best.startMs ? "soon" : null;
    if (status) {
      return { status, ...best, prob: probAt(best.startMs), radarAgeMin, source: best.nearKm > 0 ? "radar-okolí" : "radar" };
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
  if (peak < 0.5) return "slabé přeháňky";
  if (peak < 2.5) return "slabý déšť";
  if (peak < 7.5) return "mírný déšť";
  if (peak < 15) return "vydatný déšť";
  return "silný déšť";
}
function gustsKmh(ms) { return Math.round(ms * 3.6 / 10) * 10; }
const COLOR_CZ = { yellow: "žlutou", orange: "oranžovou", red: "červenou" };

export function warningsForPt(ptId) {
  const matchIdx = new Set(state.GRID.wmatch[String(ptId)] || []);
  return state.GRID.warnings.filter((w, wi) => w.global || matchIdx.has(wi));
}

export function templateVerdict(ptId) {
  const sentences = [], chips = [];
  const warns = warningsForPt(ptId);

  for (const w of warns) {
    const cls = ["yellow", "orange", "red"].includes(w.color) ? w.color : "unknown";
    chips.push(`<span class="warn-chip c-${cls}">${esc(w.event)}</span>`);
  }

  if (warns.length) {
    const w = warns[0];
    const barva = COLOR_CZ[w.color] || w.color;
    sentences.push(`ČHMÚ vydalo ${barva} výstrahu (${w.event}), platnou od ${localHM(w.onset_utc)} do ${localHM(w.expires_utc)}.`);
  }

  const as = assessRain(ptId);
  if (as?.status === "raining") {
    const kde = as.nearKm > 5 ? ` (jádro ~${as.nearKm} km odtud)` : "";
    sentences.push(`Právě prší${kde}${as.peak != null ? `, špička kolem ${as.peak} mm/h` : ""}.`);
  } else if (as?.status === "soon") {
    const intenzita = rainIntensity(as.peak ?? 0);
    const total = as.total == null ? "" : as.total < 1 ? ", úhrn do 1 mm" : `, úhrn kolem ${Math.round(as.total)} mm`;
    sentences.push(`V nejbližších hodinách se očekává ${intenzita} od ${localHM(new Date(as.startMs).toISOString())}${as.endMs ? ` do ${localHM(new Date(as.endMs).toISOString())}` : ""}${total}.`);
  } else if (as?.status === "possible") {
    sentences.push(`Radar zatím srážky nezachytil, ${as.source === "model" ? "model je ale čeká" : `ensemble je připouští (P≈${as.prob} %)`} přibližně od ${localHM(new Date(as.startMs).toISOString())}.`);
  } else if (!warns.length) {
    sentences.push("Srážky se v nejbližších hodinách neočekávají.");
  }

  const nwp = nearestNwp(state.GRID.pts[ptId][0], state.GRID.pts[ptId][1]);
  if (nwp && nwp[2]) {
    sentences.push(`Srážky jsou možné i v dalším výhledu, přibližně od ${localHM(nwp[2])}.`);
  }
  if (nwp && nwp[3] && nwp[3] >= 8) {
    sentences.push(`Vítr může v nárazech dosahovat kolem ${gustsKmh(nwp[3])} km/h.`);
  }

  return { text: sentences.join(" "), chips: chips.join("") };
}

// ── Rain status badge ─────────────────────────────────────────────────────────
export function renderRainBadge(ptId) {
  const wrap = document.getElementById("rain-badge-wrap");
  if (!wrap) return;
  const as = assessRain(ptId);
  const warns = warningsForPt(ptId);
  const hasThunder = warns.some(w => /bouř|thunder/i.test(w.event));
  let cls = "green", icon = "🟢", msg = "Bez srážek v nejbližší době";
  if (hasThunder) {
    cls = "red"; icon = "🔴"; msg = "Výstraha: " + warns.find(w => /bouř/i.test(w.event))?.event;
  } else if (as && (as.status === "raining" || as.status === "soon")) {
    const when = localHM(new Date(as.startMs).toISOString());
    const peak = as.peak ?? 0;
    if (as.status === "raining") { cls = "red"; icon = "🔴"; msg = `Právě prší${as.nearKm > 5 ? ` (~${as.nearKm} km)` : ""}`; }
    else if (peak >= 7.5) { cls = "red"; icon = "🔴"; msg = `Vydatný déšť od ${when}`; }
    else if (peak >= 2.5) { cls = "orange"; icon = "🟠"; msg = `Déšť od ${when}`; }
    else { cls = "yellow"; icon = "🟡"; msg = `Slabé srážky od ${when}`; }
  } else if (as?.status === "possible") {
    cls = "yellow"; icon = "🟡"; msg = `Srážky možné od ~${localHM(new Date(as.startMs).toISOString())}`;
  } else if (warns.length) {
    cls = "yellow"; icon = "🟡"; msg = warns[0].event;
  }
  wrap.innerHTML = `<div class="rain-badge ${cls}">${icon} ${esc(msg)}</div>`;
}

// ── Hero countdown "Déšť za X min" ────────────────────────────────────────────
let _countdownTimer = null;
let _countdownTarget = null; // { startMs, endMs, peak } nebo null

// Typ srážek (déšť / sníh / smíšené) — hint z Open-Meteo hodinovky, nastavuje
// showFc24 po parseFc24. Radar sám typ nezná, model ano.
let _precipHint = "rain";
const PRECIP_WORD = { rain: "Déšť", snow: "Sněžení", mixed: "Déšť se sněhem" };
const PRECIP_NOW = { rain: "Právě prší", snow: "Právě sněží", mixed: "Padá déšť se sněhem" };
const PRECIP_ICON = { rain: "rain", snow: "snow", mixed: "sleet" };

export function setPrecipTypeHint(fc) {
  const h = (fc?.hourlyFull || []).slice(0, 3);
  const snow = h.some(x => (x.snow ?? 0) > 0);
  const cold = h.length && h[0].tempRaw != null && h[0].tempRaw <= 1;
  _precipHint = snow ? (cold ? "snow" : "mixed") : "rain";
}

export function renderRainCountdown(ptId, minutely) {
  const el = document.getElementById("rain-countdown");
  if (!el || !state.GRID || !state.MANIFEST) { el?.classList.remove("show"); return; }

  clearInterval(_countdownTimer);
  const as = assessRain(ptId, minutely);
  const radarHM = localHM(state.GRID.t0_utc);
  const staleNote = as && as.radarAgeMin > 20 ? ` · radar ${radarHM} (${as.radarAgeMin} min starý!)` : "";

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

  document.getElementById("rc-icon").innerHTML = wImg("clear-day");
  document.getElementById("rc-title").textContent = "Nejbližší 2 h bez srážek";
  const nwp = nearestNwp(state.GRID.pts[ptId][0], state.GRID.pts[ptId][1]);
  document.getElementById("rc-sub").textContent = (nwp && nwp[2]
    ? `Model naznačuje déšť později, přibližně od ${localHM(nwp[2])}.`
    : `Radar ${radarHM} i model se shodují: sucho.`) + staleNote;
}

function _tickCountdown() {
  const el = document.getElementById("rain-countdown");
  if (!el || !_countdownTarget) return;
  const now = Date.now();
  const { startMs, endMs, peak, total, prob, nearKm, source, radarAgeMin } = _countdownTarget;
  el.classList.add("show", "imminent");
  el.classList.remove("clear");
  document.getElementById("rc-icon").innerHTML = wImg(PRECIP_ICON[_precipHint]);

  const nearStr = nearKm != null && nearKm > 5 ? ` · jádro ~${nearKm} km odtud` : "";
  const staleStr = radarAgeMin > 20 ? ` · radar ${radarAgeMin} min starý` : "";

  if (now < startMs) {
    const minsAway = Math.round((startMs - now) / 60000);
    const durMin = endMs ? Math.round((endMs - startMs) / 60000) : null;
    document.getElementById("rc-title").innerHTML =
      `${PRECIP_WORD[_precipHint]} za <span class="rc-timer">${minsAway} min</span>`;
    const probStr = prob != null ? ` · jistota ~${prob} %` : "";
    document.getElementById("rc-sub").textContent =
      `${localHM(new Date(startMs).toISOString())}${endMs ? `–${localHM(new Date(endMs).toISOString())}` : ""}`
      + `${durMin ? ` · potrvá ~${durMin} min` : ""}${peak != null ? ` · špička ${peak} mm/h` : ""}${probStr}${nearStr}${staleStr}`;
  } else if (!endMs || now <= endMs) {
    const minsLeft = endMs ? Math.round((endMs - now) / 60000) : null;
    document.getElementById("rc-title").innerHTML = minsLeft != null
      ? `${PRECIP_NOW[_precipHint]} <span class="rc-timer">(ještě ~${Math.max(minsLeft, 1)} min)</span>`
      : PRECIP_NOW[_precipHint];
    const srcStr = source === "model" ? " · radar bod nevidí, hlásí model" : nearStr;
    document.getElementById("rc-sub").textContent =
      `${peak != null ? `Špička ${peak} mm/h` : "Podle aktuálních dat"}${total != null ? ` · úhrn ~${total} mm` : ""}${srcStr}${staleStr}`;
  } else {
    document.getElementById("rc-title").textContent = "Přeháňka odezněla";
    document.getElementById("rc-sub").textContent = `${total != null ? `Úhrn ~${total} mm · ` : ""}další výhled v modelu`;
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
  const timer = setTimeout(() => ctrl.abort(), 12000);
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
    const { id } = nearestPt(lat, lon);
    radar = assessRain(id)?.status || "";
  } catch { /* bez GRIDu jede verdikt bez radarového kontextu */ }
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
    ? `<div class="verdict-ai-badge">✨ AI meteorolog</div><div class="verdict-text">${esc(aiText).replace(/\n\n/g, "<br><br>")}</div>`
    : `<div class="verdict-text">${templateText}</div>`;
  el.innerHTML = body;

  // Výstrahy patří na první pohled — do glass pruhu pod topbarem, ne dovnitř karty
  const bar = document.getElementById("alert-bar");
  if (bar) {
    if (chips) { bar.innerHTML = chips; bar.classList.add("show"); }
    else { bar.innerHTML = ""; bar.classList.remove("show"); }
  }
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
    ? ` · shoda ${leads.map(([t, l]) => `<b>${t}′ ${Math.round(l.hit_rate_pct)}%</b>`).join(" / ")}`
    : ` · shoda příchodu srážek <b>${l10.hit_rate_pct}%</b>`;
  el.innerHTML = `📊 Přesnost nowcastu (${acc.window_days} dní): MAE <b>${l10.mae_mm_h} mm/h</b>${perLead}` +
    ` <span style="opacity:.7">(n=${l10.n})</span>`;
  el.classList.add("show");
  el.title = acc.method || "";
}
