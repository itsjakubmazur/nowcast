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

  const a = state.GRID.act[String(ptId)];
  if (a) {
    const intenzita = rainIntensity(a[2]);
    const total = a[3] < 1 ? "do 1 mm" : `kolem ${Math.round(a[3])} mm`;
    sentences.push(`V nejbližších hodinách se očekává ${intenzita} od ${stepToLocal(a[0])} do ${stepToLocal(a[1])}, úhrn ${total}.`);
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
  const a = state.GRID?.act?.[String(ptId)];
  const warns = warningsForPt(ptId);
  const hasThunder = warns.some(w => /bouř|thunder/i.test(w.event));
  let cls = "green", icon = "🟢", msg = "Bez srážek v nejbližší době";
  if (hasThunder) {
    cls = "red"; icon = "🔴"; msg = "Výstraha: " + warns.find(w => /bouř/i.test(w.event))?.event;
  } else if (a) {
    const peak = a[2], when = stepToLocal(a[0]);
    if (peak >= 7.5) { cls = "red"; icon = "🔴"; msg = `Vydatný déšť od ${when}`; }
    else if (peak >= 2.5) { cls = "orange"; icon = "🟠"; msg = `Déšť od ${when}`; }
    else { cls = "yellow"; icon = "🟡"; msg = `Slabé srážky od ${when}`; }
  } else if (warns.length) {
    cls = "yellow"; icon = "🟡"; msg = warns[0].event;
  }
  wrap.innerHTML = `<div class="rain-badge ${cls}">${icon} ${esc(msg)}</div>`;
}

// ── Hero countdown "Déšť za X min" ────────────────────────────────────────────
let _countdownTimer = null;
let _countdownTarget = null; // { startMs, endMs, peak } nebo null

export function renderRainCountdown(ptId) {
  const el = document.getElementById("rain-countdown");
  if (!el || !state.GRID || !state.MANIFEST) { el?.classList.remove("show"); return; }

  const a = state.GRID.act[String(ptId)];
  const stepMin = state.GRID.step_min || 10;
  const t0ms = new Date(state.GRID.t0_utc).getTime();

  clearInterval(_countdownTimer);

  if (a) {
    const startMs = t0ms + (a[0] + 1) * stepMin * 60000;
    const endMs = t0ms + (a[1] + 1) * stepMin * 60000;
    _countdownTarget = { startMs, endMs, peak: a[2], total: a[3] };
    _tickCountdown();
    _countdownTimer = setInterval(_tickCountdown, 30000);
  } else {
    _countdownTarget = null;
    const nwp = nearestNwp(state.GRID.pts[ptId][0], state.GRID.pts[ptId][1]);
    el.classList.add("show", "clear");
    el.classList.remove("imminent");
    document.getElementById("rc-icon").innerHTML = wImg("clear-day");
    document.getElementById("rc-title").textContent = "Nejbližší 2 h bez srážek";
    document.getElementById("rc-sub").textContent = nwp && nwp[2]
      ? `Model naznačuje déšť později, přibližně od ${localHM(nwp[2])}.`
      : "Podle radarové extrapolace ani modelu se srážky nečekají.";
  }
}

function _tickCountdown() {
  const el = document.getElementById("rain-countdown");
  if (!el || !_countdownTarget) return;
  const now = Date.now();
  const { startMs, endMs, peak, total } = _countdownTarget;
  el.classList.add("show", "imminent");
  el.classList.remove("clear");
  document.getElementById("rc-icon").innerHTML = wImg("rain");

  if (now < startMs) {
    const minsAway = Math.round((startMs - now) / 60000);
    const durMin = Math.round((endMs - startMs) / 60000);
    document.getElementById("rc-title").innerHTML =
      `Déšť za <span class="rc-timer">${minsAway} min</span>`;
    document.getElementById("rc-sub").textContent =
      `${localHM(new Date(startMs).toISOString())}–${localHM(new Date(endMs).toISOString())} · potrvá ~${durMin} min · špička ${peak} mm/h`;
  } else if (now <= endMs) {
    const minsLeft = Math.round((endMs - now) / 60000);
    document.getElementById("rc-title").innerHTML =
      `Právě prší <span class="rc-timer">(ještě ~${Math.max(minsLeft, 1)} min)</span>`;
    document.getElementById("rc-sub").textContent = `Špička ${peak} mm/h · úhrn ~${total} mm`;
  } else {
    document.getElementById("rc-title").textContent = "Přeháňka odezněla";
    document.getElementById("rc-sub").textContent = `Úhrn ~${total} mm · další výhled v modelu`;
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

async function fetchAiVerdictAttempt(lat, lon, label) {
  state.verdictCtrl?.abort();
  const ctrl = new AbortController();
  state.verdictCtrl = ctrl;
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const url = `${WORKER_BASE}/verdict?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&label=${encodeURIComponent(label || "")}`;
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
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = aiCacheGet(key);
  if (cached) return cached;

  // Free-tier Gemini kvóta občas hodí 429/5xx na jeden pokus — jeden rychlý
  // retry to většinou spolehlivě zachrání, aniž by to uživatel poznal.
  let text = await fetchAiVerdictAttempt(lat, lon, label);
  if (!text) {
    await new Promise(res => setTimeout(res, 1200));
    text = await fetchAiVerdictAttempt(lat, lon, label);
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
  el.innerHTML = `📊 Přesnost nowcastu (${acc.window_days} dní): MAE <b>${l10.mae_mm_h} mm/h</b>, ` +
    `shoda příchodu srážek <b>${l10.hit_rate_pct}%</b> <span style="opacity:.7">(n=${l10.n})</span>`;
  el.classList.add("show");
  el.title = acc.method || "";
}
