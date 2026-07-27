// Cloudflare Worker — nowcast-narrate
//
// Routy:
//   GET  /verdict?lat=..&lon=..&label=..   — AI verdikt pro libovolné místo (Gemini),
//                                             edge-cachovaný přes Cache API (~10 min)
//   GET  /vapid-public-key                 — veřejný VAPID klíč pro Push subscribe
//   POST /subscribe                        — uloží Web Push subscription + oblíbená místa
//   POST /unsubscribe                      — smaže subscription
//   scheduled()                            — cron (~10 min): zkontroluje oblíbená místa
//                                             všech subscriberů proti forecast_grid.json
//                                             a pošle prázdný Web Push, když hrozí déšť/výstraha

const SYSTEM_PROMPT = `Jsi zkušený meteorolog, který píše stručnou, informačně bohatou předpověď pro běžné lidi.
Dostaneš JSON s hodinovými daty o počasí pro konkrétní místo. Napiš předpověď ve dvou krátkých odstavcích:

ODSTAVEC 1 — Nejbližších 6 hodin (2–3 hutné věty):
Shrň teploty (min–max ve °C), srážky (kdy, jak vydatné, kolik mm) a nárazy větru (km/h).
Bouřky zmiň jen tehdy, pokud podle dat hrozí. Spojuj fakta do jedné věty, kde to jde —
žádné rozvláčné opisy.

ODSTAVEC 2 — Výhled do konce dne (1 věta):
Trend teplot a jestli se počasí zlepší, nebo zhorší.

POVINNÁ PRAVIDLA:
- Uváděj POUZE hodnoty a jevy, které jsou ve vstupním JSON. Nic nevymýšlej.
- Časy jsou v místním čase daného místa — použij přímo.
- Pokud nejsou srážky: zaměř se na teploty a vítr.
- Žádný uvítací odstavec ani zdvořilostní fráze ("dobrý den", "přinášíme vám předpověď") — jdi rovnou k věci.

STYL:
- Přirozená čeština, věcně, jako krátká rozhlasová zpráva o počasí — ne školní slohovka.
- NIKDY nezmiňuj: ICON-D2, Open-Meteo, CAPE (říkej "bouřkový potenciál"), radarová extrapolace.
- Vítr: vždy jen NÁRAZY v km/h. Průměr nezmiňuj.
- Srážky: intenzitu slovně (slabý/mírný/vydatný déšť, přeháňky), úhrn na celé mm.
- Teploty: celé °C, pocitovou jen pokud se liší o ≥3°C.`;

// 30 min místo 10 — Gemini free-tier kvóta je denní/RPM limit, tak ať
// stejné místo nespotřebovává nový request při každém druhém načtení.
const CACHE_TTL_S = 1800;             // edge cache pro /verdict
// Zvyš při každé změně SYSTEM_PROMPT / buildPrompt / generationConfig —
// jinak stará (třeba uťatá) odpověď přežije v edge cache i nový deploy.
const CACHE_VERSION = "v4";
const PUSH_SNOOZE_MS = 30 * 60 * 1000;     // 30 min mezi upozorněními na stejné místo
const WARN_SNOOZE_MS = 60 * 60 * 1000;     // 60 min pro výstrahy
const RAIN_THRESHOLD_MM_H = 0.1;
const RAIN_LOOKAHEAD_STEPS = 5;            // 5 × step_min ~ 45-50 min dopředu = "imminent"

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/verdict" && request.method === "GET") {
        return await handleVerdict(request, url, env, ctx);
      }
      if (url.pathname === "/ask" && request.method === "GET") {
        return await handleAsk(url, env);
      }
      if (url.pathname === "/vapid-public-key" && request.method === "GET") {
        return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
      }
      if (url.pathname === "/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env);
      }
      if (url.pathname === "/unsubscribe" && request.method === "POST") {
        return await handleUnsubscribe(request, env);
      }
      if (url.pathname === "/push-status" && request.method === "POST") {
        return await handlePushStatus(request, env);
      }
      if (url.pathname === "/model-obs" && request.method === "POST") {
        return await handleModelObs(request, env);
      }
      if (url.pathname === "/model-scores" && request.method === "GET") {
        return await handleModelScores(url, env);
      }
      // Zpětná kompatibilita se starým klientem (POST / s {lat,lon,label})
      if (url.pathname === "/" && request.method === "POST") {
        return await handleVerdictLegacyPost(request, env);
      }
    } catch (e) {
      return json({ error: `Neočekávaná chyba: ${e.message}` }, 500);
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPushCheck(env));
  },
};

// ── /verdict (GET, cachovaný) ────────────────────────────────────────────────

async function handleVerdict(request, url, env, ctx) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const label = url.searchParams.get("label") || "";
  // Radarový kontext z klienta (assessRain): "raining" | "soon" | "possible" |
  // "dry". AI verdikt z čistého NWP uměl tvrdit "déšť kolem 18:00", zatímco
  // venku už půl hodiny lilo — model o bouřce nevěděl, radar ano.
  const radarHint = ["raining", "soon", "possible", "dry"].includes(url.searchParams.get("radar"))
    ? url.searchParams.get("radar") : "";
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat/lon required" }, 400);
  }

  // Zaokrouhli na ~1 km, ať víc lidí ze stejné obce trefí stejný cache klíč.
  // Radarový stav patří do klíče — "prší" a "sucho" nesmí sdílet odpověď.
  const rlat = lat.toFixed(2);
  const rlon = lon.toFixed(2);
  const cacheKey = new Request(
    `https://cache.internal/verdict?v=${CACHE_VERSION}&lat=${rlat}&lon=${rlon}&radar=${radarHint}`,
    { method: "GET" }
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const res = new Response(cached.body, cached);
    Object.entries(corsHeaders()).forEach(([k, v]) => res.headers.set(k, v));
    res.headers.set("X-Cache", "HIT");
    return res;
  }

  const result = await generateVerdict(lat, lon, label, env, radarHint);
  if (result.error) {
    return json(result, result.status || 502);
  }

  const res = json({ text: result.text });
  res.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_S}`);
  res.headers.set("X-Cache", "MISS");
  const toCache = new Response(res.body, res);
  toCache.headers.set("Cache-Control", `public, max-age=${CACHE_TTL_S}`);
  ctx.waitUntil(cache.put(cacheKey, toCache));
  return res;
}

// ── /ask — „zeptej se na počasí" (Q&A nad hodinovými daty) ───────────────────
const ASK_PROMPT = `Jsi meteorolog. Dostaneš JSON s hodinovými daty o počasí pro konkrétní místo
a otázku uživatele. Odpověz česky, stručně (1–3 věty), POUZE z dat v JSON — nic si nevymýšlej.
Když se otázka netýká počasí nebo na ni data neodpovídají, řekni to na rovinu jednou větou.
Časy jsou v místním čase daného místa. Vítr uváděj v nárazech km/h, srážky v mm, teploty celé °C.`;

async function handleAsk(url, env) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const label = url.searchParams.get("label") || "";
  const q = (url.searchParams.get("q") || "").slice(0, 200).trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat/lon required" }, 400);
  if (!q) return json({ error: "q required" }, 400);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "GEMINI_API_KEY not configured" }, 500);

  let omData;
  try {
    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_gusts_10m,cape,uv_index,cloud_cover`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset`
      + `&timezone=auto&forecast_days=3`;
    const r = await fetch(omUrl);
    if (!r.ok) throw new Error(`OM HTTP ${r.status}`);
    omData = await r.json();
  } catch (e) {
    return json({ error: `Open-Meteo fetch failed: ${e.message}` }, 502);
  }

  const prompt = JSON.stringify({
    misto: label || `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`,
    otazka: q,
    data: { hourly: compactHourly(omData), daily: omData.daily },
  });
  try {
    const body = {
      system_instruction: { parts: [{ text: ASK_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    };
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    return json({ text });
  } catch (e) {
    return json({ error: `Gemini failed: ${e.message}` }, 502);
  }
}

// Kompaktní hodinovka pro /ask — jen každá 2. hodina, ať prompt není obří
function compactHourly(om) {
  const h = om.hourly || {};
  const out = [];
  for (let i = 0; i < (h.time || []).length; i += 2) {
    out.push({
      t: h.time[i],
      T: h.temperature_2m?.[i], poc: h.apparent_temperature?.[i],
      mm: h.precipitation?.[i], pct: h.precipitation_probability?.[i],
      naraz: h.wind_gusts_10m?.[i], cape: h.cape?.[i], uv: h.uv_index?.[i],
      obl: h.cloud_cover?.[i],
    });
  }
  return out;
}

async function handleVerdictLegacyPost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { lat, lon, label } = body || {};
  if (!lat || !lon) return json({ error: "lat/lon required" }, 400);
  const result = await generateVerdict(parseFloat(lat), parseFloat(lon), label, env);
  if (result.error) return json(result, result.status || 502);
  return json({ text: result.text });
}

async function generateVerdict(lat, lon, label, env, radarHint = "") {
  let omData;
  try {
    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,cape`
      + `&timezone=auto&forecast_days=1`;
    const r = await fetch(omUrl);
    if (!r.ok) throw new Error(`OM HTTP ${r.status}`);
    omData = await r.json();
  } catch (e) {
    return { error: `Open-Meteo fetch failed: ${e.message}`, status: 502 };
  }

  const prompt = buildPrompt(omData, label, lat, lon, radarHint);

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { error: "GEMINI_API_KEY not configured", status: 500 };

  try {
    const text = await callGemini(prompt, apiKey);
    return { text };
  } catch (e) {
    return { error: `Gemini failed: ${e.message}`, status: 502 };
  }
}

function buildPrompt(om, label, lat, lon, radarHint) {
  const h = om.hourly || {};
  const times = h.time || [];
  const temp = h.temperature_2m || [];
  const feels = h.apparent_temperature || [];
  const wc = h.weather_code || [];
  const prec = h.precipitation || [];
  const prob = h.precipitation_probability || [];
  const gusts = h.wind_gusts_10m || [];
  const cape = h.cape || [];

  const tz = om.timezone || "Europe/Prague";
  const nowLoc = new Date().toLocaleString("sv-SE", { timeZone: tz });
  const nowStr = nowLoc.slice(0, 10) + "T" + nowLoc.slice(11, 14) + "00";

  let startIdx = times.findIndex(t => t >= nowStr);
  if (startIdx < 0) startIdx = 0;

  const detail = [];
  for (let i = startIdx; i < Math.min(startIdx + 6, times.length); i++) {
    const row = { cas: times[i].slice(11, 16) };
    if (temp[i] != null) row.teplota_C = Math.round(temp[i]);
    if (feels[i] != null && temp[i] != null && Math.abs(feels[i] - temp[i]) >= 3)
      row.pocitova_C = Math.round(feels[i]);
    if (prec[i] != null && prec[i] >= 0.1) row.srazky_mm = prec[i];
    if (prob[i] != null) row.pravdepodobnost_pct = prob[i];
    if (gusts[i] != null) row.narazy_km_h = Math.round(gusts[i]);
    if (wc[i] != null) row.weather_code = wc[i];
    if (cape[i] != null && cape[i] >= 200) row.bou_potencial_J_kg = Math.round(cape[i]);
    detail.push(row);
  }

  const outlook = [];
  for (let i = startIdx + 6; i < times.length; i += 3) {
    const slice = { cas: times[i].slice(11, 16) };
    const temps = temp.slice(i, i + 3).filter(v => v != null);
    if (temps.length) { slice.tmin_C = Math.round(Math.min(...temps)); slice.tmax_C = Math.round(Math.max(...temps)); }
    const precSum = prec.slice(i, i + 3).filter(v => v != null).reduce((a, b) => a + b, 0);
    if (precSum >= 0.1) slice.srazky_mm = Math.round(precSum * 10) / 10;
    const gustSlice = gusts.slice(i, i + 3).filter(v => v != null);
    if (gustSlice.length) {
      const maxGust = Math.max(...gustSlice);
      if (maxGust >= 20) slice.max_narazy_km_h = Math.round(maxGust);
    }
    outlook.push(slice);
  }

  // Generické placeholdery (např. tlačítko "Moje poloha") nejsou skutečný název
  // místa — kdyby to šlo do promptu takhle doslova, model by si "Moje poloha"
  // spletl s reálným toponymem. Radši spadni na souřadnice.
  const isGenericLabel = !label || /^(moje poloha|aktuální poloha|vybrané místo)$/i.test(label.trim());

  // Radar má vždy pravdu o TEĎ — NWP hodinovka bouřku klidně nevidí.
  const RADAR_CZ = {
    raining: "PRÁVĚ TEĎ na místě nebo v bezprostředním okolí PRŠÍ (radarové měření). Začni od aktuálního deště, nemluv o něm v budoucím čase.",
    soon: "Radar ukazuje srážky přicházející v řádu desítek minut.",
    possible: "Radar zatím nic, ale ensemble/model srážky v nejbližších 2 h připouští.",
    dry: "Radar aktuálně žádné srážky v okolí neukazuje.",
  };

  return JSON.stringify({
    misto: isGenericLabel ? `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E` : label,
    ...(radarHint && RADAR_CZ[radarHint] ? { radar_ted: RADAR_CZ[radarHint] } : {}),
    detail_0_6h: detail,
    vyhled_zbytek_dne: outlook,
  }, null, 2);
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: prompt }] }],
    // thinkingBudget: 0 — bez toho si gemini-2.5-flash "myšlením" ukrajuje
    // z maxOutputTokens a odpověď pak přijde uťatá uprostřed věty.
    generationConfig: {
      maxOutputTokens: 1200,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`HTTP ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

// ── Web Push subscribe / unsubscribe ─────────────────────────────────────────

async function handleSubscribe(request, env) {
  if (!env.SUBSCRIPTIONS) return json({ error: "Push není na serveru nakonfigurovaný" }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const sub = body?.subscription;
  const favorites = body?.favorites;
  if (!sub?.endpoint) return json({ error: "subscription.endpoint required" }, 400);
  if (!Array.isArray(favorites) || favorites.length === 0) {
    return json({ error: "favorites (neprázdné pole) required" }, 400);
  }

  const key = "sub:" + (await sha256Hex(sub.endpoint));
  let existing = null;
  try {
    existing = await env.SUBSCRIPTIONS.get(key, "json");
  } catch { /* ignore */ }

  const record = {
    subscription: sub,
    favorites: favorites.slice(0, 5).map(f => ({
      lat: Number(f.lat), lon: Number(f.lon),
      label: String(f.label || "").slice(0, 60),
    })),
    updatedAt: new Date().toISOString(),
    notified: existing?.notified || {},
  };
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 60, // 60 dní — mrtvé subscriptions samy vyprší
  });
  return json({ ok: true });
}

async function handleUnsubscribe(request, env) {
  if (!env.SUBSCRIPTIONS) return json({ error: "Push není na serveru nakonfigurovaný" }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const endpoint = body?.endpoint;
  if (!endpoint) return json({ error: "endpoint required" }, 400);
  const key = "sub:" + (await sha256Hex(endpoint));
  await env.SUBSCRIPTIONS.delete(key);
  return json({ ok: true });
}

// Diagnostika: má server tenhle endpoint opravdu uložený?
//
// Bez toho se "notifikace nechodí" nedá odlišit od "prohlídeč si myslí, že je
// přihlášený, ale na serveru žádný záznam není" — a to je přesně stav, který
// nastane, když subscription vyprší nebo ji smaže systém. Vrací jen metadata,
// žádný obsah subscription.
async function handlePushStatus(request, env) {
  if (!env.SUBSCRIPTIONS) return json({ error: "Push není na serveru nakonfigurovaný" }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const endpoint = body?.endpoint;
  if (!endpoint) return json({ error: "endpoint required" }, 400);
  const key = "sub:" + (await sha256Hex(endpoint));
  let rec = null;
  try {
    rec = await env.SUBSCRIPTIONS.get(key, "json");
  } catch { /* ignore */ }
  if (!rec) return json({ registered: false });
  return json({
    registered: true,
    favorites: (rec.favorites || []).length,
    updatedAt: rec.updatedAt || null,
    lastNotified: Object.values(rec.notified || {}).sort().slice(-1)[0] || null,
  });
}

// ── Sdílené učení: přesnost modelů napříč uživateli ─────────────────────────
//
// Dosud se každý prohlížeč učil sám do localStorage. Znamenalo to, že po
// vymazání cache začínala appka od nuly a sto lidí ze stejného města se učilo
// stokrát totéž. Tady se pozorování slévají po buňkách 0,25° (~20 km), takže
// se učí APLIKACE, ne jedno zařízení.
//
// Ukládá se běžící součet, ne jednotlivé vzorky: paměťově je to konstantní,
// a k MAE i k systematické odchylce (bias) stačí. Bias je tu důležitější než
// MAE — o kolik se model mýlí NA JEDNU STRANU se dá odečíst, což zpřesní
// číslo, které uživatel vidí.
const CELL_DEG = 0.25;
const OBS_MAX_PER_REQ = 60;
const SCORE_TTL_S = 60 * 60 * 24 * 120;   // 120 dní bez zápisu = zapomeneme
const HALF_LIFE_N = 400;                  // po tolika vzorcích má starší půl váhy

function cellKey(lat, lon) {
  const la = Math.floor(lat / CELL_DEG);
  const lo = Math.floor(lon / CELL_DEG);
  return `ms:${la}_${lo}`;
}

async function handleModelObs(request, env) {
  if (!env.SUBSCRIPTIONS) return json({ error: "Úložiště není nakonfigurované" }, 501);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const lat = Number(body?.lat), lon = Number(body?.lon);
  const obs = Array.isArray(body?.obs) ? body.obs.slice(0, OBS_MAX_PER_REQ) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !obs?.length) {
    return json({ error: "lat, lon a neprázdné obs required" }, 400);
  }

  const key = cellKey(lat, lon);
  let rec = null;
  try { rec = await env.SUBSCRIPTIONS.get(key, "json"); } catch { /* ignore */ }
  rec = rec && typeof rec === "object" ? rec : { models: {} };
  rec.models = rec.models || {};

  let taken = 0;
  for (const o of obs) {
    const id = String(o?.model || "").slice(0, 40);
    const err = Number(o?.err);        // predikce − měření (SE ZNAMÉNKEM)
    if (!id || !Number.isFinite(err) || Math.abs(err) > 30) continue;
    const m = rec.models[id] || { n: 0, sumAbs: 0, sumSigned: 0 };
    // Exponenciální zapomínání: staré vzorky se nesmí kupit donekonečna,
    // protože model se v čase mění (nové verze, jiná sezóna).
    if (m.n >= HALF_LIFE_N) {
      m.n *= 0.5; m.sumAbs *= 0.5; m.sumSigned *= 0.5;
    }
    m.n += 1;
    m.sumAbs += Math.abs(err);
    m.sumSigned += err;
    rec.models[id] = m;
    taken++;
  }
  if (!taken) return json({ ok: true, taken: 0 });

  rec.updatedAt = new Date().toISOString();
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(rec), { expirationTtl: SCORE_TTL_S });
  return json({ ok: true, taken });
}

async function handleModelScores(url, env) {
  if (!env.SUBSCRIPTIONS) return json({ error: "Úložiště není nakonfigurované" }, 501);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat/lon required" }, 400);
  }
  let rec = null;
  try { rec = await env.SUBSCRIPTIONS.get(cellKey(lat, lon), "json"); } catch { /* ignore */ }

  const models = {};
  for (const [id, m] of Object.entries(rec?.models || {})) {
    if (!m?.n) continue;
    models[id] = {
      n: Math.round(m.n),
      mae: Math.round((m.sumAbs / m.n) * 100) / 100,
      // Kladný bias = model to přestřeluje, takže se od předpovědi odečítá.
      bias: Math.round((m.sumSigned / m.n) * 100) / 100,
    };
  }
  const res = json({ cell: CELL_DEG, updatedAt: rec?.updatedAt || null, models });
  // Krátká edge cache: skóre se mění pomalu, ale nesmí zamrznout na hodiny.
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
}

// ── Cron: zkontroluj oblíbená místa všech subscriberů, pošli push ───────────

async function runPushCheck(env) {
  if (!env.SUBSCRIPTIONS) return;
  const base = env.PAGES_BASE || "https://itsjakubmazur.github.io/nowcast";
  let grid;
  try {
    const r = await fetch(`${base}/data/forecast_grid.json`, { cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    grid = await r.json();
  } catch (e) {
    console.log(`runPushCheck: grid fetch selhal: ${e.message}`);
    return;
  }

  // Ranní briefing — jednou denně v okně 7:00–7:09 místního času
  const pragueNow = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Prague" });
  const briefingDue = pragueNow.slice(11, 13) === "07" && +pragueNow.slice(14, 16) < 10;
  const todayStr = pragueNow.slice(0, 10);

  let cursor;
  let checked = 0, notified = 0, expired = 0;
  do {
    const page = await env.SUBSCRIPTIONS.list({ prefix: "sub:", cursor, limit: 1000 });
    for (const k of page.keys) {
      checked++;
      const record = await env.SUBSCRIPTIONS.get(k.name, "json");
      if (!record) continue;
      if (briefingDue && record.lastBriefing !== todayStr) {
        const out = await sendMorningBriefing(k.name, record, todayStr, env);
        if (out === "expired") { expired++; continue; }
        if (out === "notified") notified++;
      }
      const outcome = await checkAndNotify(k.name, record, grid, env);
      if (outcome === "notified") notified++;
      if (outcome === "expired") expired++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(`runPushCheck: checked=${checked} notified=${notified} expired=${expired}`);
}

// ── Ranní briefing (7:00) — shrnutí dne pro první oblíbené místo ─────────────
async function sendMorningBriefing(key, record, todayStr, env) {
  const fav = record.favorites?.[0];
  if (!fav) return "skip";
  let body = "Tvůj přehled počasí na dnešek je připravený.";
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${fav.lat.toFixed(4)}&longitude=${fav.lon.toFixed(4)}`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max`
      + `&timezone=auto&forecast_days=1`);
    if (r.ok) {
      const d = (await r.json()).daily || {};
      const tmax = Math.round(d.temperature_2m_max?.[0]);
      const tmin = Math.round(d.temperature_2m_min?.[0]);
      const prob = d.precipitation_probability_max?.[0];
      const sum = d.precipitation_sum?.[0];
      const gust = Math.round(d.wind_gusts_10m_max?.[0]);
      const parts = [`${tmin}–${tmax} °C`];
      if (prob != null) parts.push(sum >= 0.5 ? `srážky ${prob} % (~${Math.round(sum)} mm)` : `srážky ${prob} %`);
      if (gust >= 30) parts.push(`nárazy až ${gust} km/h`);
      body = `Dnes ${parts.join(" · ")}.`;
    }
  } catch { /* generický text */ }

  const resp = await sendPush(record.subscription, env, {
    title: `🌅 Ranní přehled — ${fav.label || "tvoje místo"}`,
    body,
    tag: "briefing",
  }).catch(() => null);
  if (resp && (resp.status === 404 || resp.status === 410)) {
    await env.SUBSCRIPTIONS.delete(key);
    return "expired";
  }
  record.lastBriefing = todayStr;
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 60 });
  return "notified";
}

function localHM(iso) {
  return new Date(iso).toLocaleTimeString("cs-CZ", {
    timeZone: "Europe/Prague", hour: "2-digit", minute: "2-digit",
  });
}
// Stejné prahy jako precipDescr ve frontendovém verdict.js — 0.3 mm/h je
// mrholení, ne déšť; notifikace nesmí dramatizovat
function rainWords(peak) {
  if (peak < 0.5) return "mrholení";
  if (peak < 2.5) return "slabý déšť";
  if (peak < 7.5) return "mírný déšť";
  if (peak < 15) return "vydatný déšť";
  return "přívalový déšť";
}

// Radar zná jen intenzitu, ne skupenství — typ srážek (déšť/sníh/smíšené)
// doplní rychlý dotaz na aktuální teplotu a sněžení z Open-Meteo. Při
// jakémkoli selhání se vracíme k obyčejnému dešti, notifikace nesmí spadnout.
async function precipType(lat, lon) {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&current=temperature_2m,snowfall&timezone=auto`,
      { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const cur = (await r.json()).current || {};
    const t = cur.temperature_2m;
    if ((cur.snowfall ?? 0) > 0 || (t != null && t <= 0.5)) return "snow";
    if (t != null && t <= 2) return "mixed";
    return "rain";
  } catch {
    return null;
  }
}

const PRECIP_TITLE = { rain: "🌧️ Déšť", snow: "🌨️ Sněžení", mixed: "🌨️ Déšť se sněhem" };
function precipWords(type, peak) {
  if (type === "snow") return peak >= 2.5 ? "vydatné sněžení" : "sněžení";
  if (type === "mixed") return "déšť se sněhem";
  return rainWords(peak);
}

async function checkAndNotify(key, record, grid, env) {
  const now = Date.now();
  let shouldNotify = false;
  let reason = "";
  let notifPayload = null;
  const stepMin = grid.step_min || 10;
  const t0ms = Date.parse(grid.t0_utc || 0);

  for (const fav of record.favorites || []) {
    const favKey = `${fav.lat.toFixed(2)},${fav.lon.toFixed(2)}`;
    const lastNotified = record.notified?.[favKey] ? Date.parse(record.notified[favKey]) : 0;

    const { id, dist } = nearestPtIdx(grid, fav.lat, fav.lon);

    // Oblíbené místo mimo pokrytí českého gridu (> 25 km od nejbližšího bodu)
    // → světová kontrola přes Open-Meteo minutely_15 místo radaru
    if (id == null || dist > 25) {
      if (now - lastNotified <= PUSH_SNOOZE_MS) continue;
      const g = await globalRainCheck(fav);
      if (g) {
        shouldNotify = true;
        reason = `rainglobal:${favKey}`;
        const type = (await precipType(fav.lat, fav.lon)) || "rain";
        notifPayload = g.minsAway <= 0
          ? { title: type === "snow" ? "🌨️ Právě sněží" : "🌧️ Právě prší",
              body: `${fav.label || favKey}: ${precipWords(type, g.peakMmH)}, ~${g.peakMmH} mm/h. Podle modelu.`,
              tag: `rain-${favKey}` }
          : { title: `${PRECIP_TITLE[type]} za ~${g.minsAway} min`,
              body: `${fav.label || favKey}: ${precipWords(type, g.peakMmH)} (~${g.peakMmH} mm/h). Podle modelu.`,
              tag: `rain-${favKey}` };
        record.notified = record.notified || {};
        record.notified[favKey] = new Date(now).toISOString();
      }
      continue;
    }

    // Zásah bouřkou — nejvyšší priorita. Predikovaná dráha buňky (grid.cells)
    // protne oblíbené místo → "Bouřka za ~25 min". Bezpečnostní věc, kratší
    // snooze než déšť, ať upozornění dorazí včas.
    const imp = stormImpactFor(grid, fav.lat, fav.lon);
    if (imp && now - lastNotified > PUSH_SNOOZE_MS) {
      shouldNotify = true;
      reason = `storm:${favKey}`;
      const sev = imp.cell.hail ? "silná bouřka s možnými kroupami"
        : imp.cell.dbz >= 50 ? "silná bouřka" : "bouřka";
      notifPayload = imp.etaMin <= 0
        ? { title: "⛈️ Bouřka právě nad tebou",
            body: `${fav.label || favKey}: ${sev}, ${imp.cell.dbz} dBZ. Podle radaru.`,
            tag: `storm-${favKey}` }
        : { title: `⛈️ Bouřka za ~${imp.etaMin} min`,
            body: `${fav.label || favKey}: ${sev} postupuje ${imp.cell.speed_kmh} km/h. Podle radaru.`,
            tag: `storm-${favKey}` };
      record.notified = record.notified || {};
      record.notified[favKey] = new Date(now).toISOString();
      continue;
    }

    // Výstrahy (CAP) — vyšší priorita, delší snooze
    const matchIdx = new Set(grid.wmatch?.[String(id)] || []);
    const activeWarn = (grid.warnings || []).find((w, wi) =>
      (w.global || matchIdx.has(wi)) && ["yellow", "orange", "red"].includes(w.color));
    if (activeWarn && now - lastNotified > WARN_SNOOZE_MS) {
      shouldNotify = true;
      reason = `warn:${favKey}`;
      notifPayload = {
        title: `⚠️ ${activeWarn.event}`,
        body: `${fav.label || favKey}: výstraha ČHMÚ platí do ${localHM(activeWarn.expires_utc)}.`,
        tag: `warn-${favKey}`,
      };
      record.notified = record.notified || {};
      record.notified[favKey] = new Date(now).toISOString();
      continue;
    }

    // Příchozí srážky — nejbližší aktivita v okolí (≤ 12 km), ne jen jeden pixel
    const near = nearestRainActivity(grid, fav.lat, fav.lon);
    if (near && now - lastNotified > PUSH_SNOOZE_MS) {
      const [startStep, endStep] = near.act;
      const rainVal = near.act[2];
      if (rainVal >= RAIN_THRESHOLD_MM_H && startStep <= RAIN_LOOKAHEAD_STEPS) {
        const startMs = t0ms + (startStep + 1) * stepMin * 60000;
        const endMs = t0ms + (endStep + 1) * stepMin * 60000;
        const type = (await precipType(fav.lat, fav.lon)) || "rain";
        const kmStr = near.distKm > 5 ? ` (~${Math.round(near.distKm)} km)` : "";
        if (now >= startMs && now <= endMs) {
          // už prší/sněží — "za X min" by byl výsměch, řekni to na rovinu
          shouldNotify = true;
          reason = `rainnow:${favKey}`;
          notifPayload = {
            title: type === "snow" ? "🌨️ Právě sněží" : "🌧️ Právě prší",
            body: `${fav.label || favKey}${kmStr}: ${precipWords(type, rainVal)}, špička ${rainVal} mm/h. Podle radaru.`,
            tag: `rain-${favKey}`,
          };
        } else if (now < startMs) {
          shouldNotify = true;
          reason = `rain:${favKey}`;
          const minsAway = Math.max(Math.round((startMs - now) / 60000), 1);
          notifPayload = {
            title: `${PRECIP_TITLE[type]} za ~${minsAway} min`,
            body: `${fav.label || favKey}${kmStr}: ${precipWords(type, rainVal)} přibližně od ${localHM(new Date(startMs).toISOString())}. Podle radaru.`,
            tag: `rain-${favKey}`,
          };
        }
        if (shouldNotify) {
          record.notified = record.notified || {};
          record.notified[favKey] = new Date(now).toISOString();
        }
      }
    }
  }

  if (!shouldNotify) return "skip";

  const resp = await sendPush(record.subscription, env, notifPayload).catch(() => null);
  if (resp && (resp.status === 404 || resp.status === 410)) {
    await env.SUBSCRIPTIONS.delete(key);
    return "expired";
  }
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 60,
  });
  console.log(`push sent (${reason})`);
  return "notified";
}

// Světová kontrola deště pro oblíbená místa mimo ČR — Open-Meteo minutely_15.
// Vrací { minsAway, peakMmH } při dešti do ~45 min, jinak null. Jakékoli
// selhání → null (notifikace nesmí spadnout kvůli jedné zahraniční oblíbené).
async function globalRainCheck(fav) {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${fav.lat.toFixed(4)}&longitude=${fav.lon.toFixed(4)}`
      + `&minutely_15=precipitation&forecast_days=1&timezone=auto`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const om = await r.json();
    const times = om.minutely_15?.time || [];
    const prec = om.minutely_15?.precipitation || [];
    const tz = om.timezone || "UTC";
    const nowLoc = new Date().toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T").slice(0, 16);
    let si = times.findIndex(t => t >= nowLoc);
    if (si < 0) return null;
    for (let k = 0; k < 4 && si + k < times.length; k++) { // 0–45 min dopředu
      const v = prec[si + k];
      if (v != null && v >= RAIN_THRESHOLD_MM_H) {
        return { minsAway: k * 15, peakMmH: Math.round(v * 4 * 10) / 10 }; // mm/15min → mm/h
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Zásah bouřkou pro server-side push — zrcadlí stormImpact() na klientu.
// Vrací { cell, etaMin } nejdřívějšího zásahu, nebo null.
function stormImpactFor(grid, lat, lon) {
  const cells = grid.cells || [];
  const stepMin = grid.step_min || 10;
  let soonest = null;
  for (const c of cells) {
    const path = [[c.lat, c.lon], ...(c.track || [])];
    let bestD = Infinity, bestIdx = 0;
    path.forEach((p, i) => {
      const d = haversineKm(lat, lon, p[0], p[1]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    });
    const hitKm = Math.sqrt((c.area_km2 || 50) / Math.PI) + 4;
    if (bestD <= hitKm) {
      const etaMin = bestIdx * stepMin;
      if (!soonest || etaMin < soonest.etaMin) soonest = { cell: c, etaMin };
    }
  }
  return soonest;
}

function nearestPtIdx(grid, lat, lon) {
  const pts = grid.pts || [];
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineKm(lat, lon, pts[i][0], pts[i][1]);
    if (d < bd) { bd = d; best = i; }
  }
  return { id: best, dist: bd };
}

// Nejbližší aktivní srážky v okolí bodu (≤ 12 km) — bouřka pár km vedle
// oblíbeného místa se počítá; jediný suchý pixel dřív celou notifikaci zahodil.
function nearestRainActivity(grid, lat, lon) {
  const pts = grid.pts || [];
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = grid.act?.[String(i)];
    if (!a) continue;
    const d = haversineKm(lat, lon, pts[i][0], pts[i][1]);
    if (d > 12) continue;
    if (!best || a[0] < best.act[0] || (a[0] === best.act[0] && d < best.distKm)) {
      best = { act: a, distKm: d };
    }
  }
  return best;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Web Push (VAPID/RFC 8292 + šifrovaný payload aes128gcm/RFC 8291) ─────────
// Payload nese title/body/tag — service worker tak umí zobrazit konkrétní
// zprávu ("Déšť za 20 min v Podivíně"), ne jen generickou hlášku.

async function sendPush(subscription, env, payload = null, ttlSeconds = 600) {
  const auth = await buildVapidAuthHeader(subscription.endpoint, env);
  const headers = { Authorization: auth, TTL: String(ttlSeconds) };
  let body = null;

  if (payload && subscription.keys?.p256dh && subscription.keys?.auth) {
    try {
      body = await encryptPushPayload(subscription, JSON.stringify(payload));
      headers["Content-Encoding"] = "aes128gcm";
      headers["Content-Type"] = "application/octet-stream";
    } catch (e) {
      console.log(`ECE encrypt selhal (${e.message}) — posílám prázdný push`);
      body = null;
    }
  }
  if (!body) headers["Content-Length"] = "0";

  return fetch(subscription.endpoint, { method: "POST", headers, body });
}

// RFC 8291: ECDH(P-256) → HKDF → AES-128-GCM, formát těla aes128gcm (RFC 8188)
async function encryptPushPayload(subscription, payloadStr) {
  const uaPub = b64urlToBytes(subscription.keys.p256dh);   // 65 B nekomprimovaný bod
  const authSecret = b64urlToBytes(subscription.keys.auth); // 16 B

  const asKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey(
    "raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const te = new TextEncoder();
  const hkdf = async (salt, ikm, info, len) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
  };
  const cat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };

  const keyInfo = cat(te.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // jediný (poslední) záznam → padding delimiter 0x02
  const plaintext = cat(te.encode(payloadStr), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // hlavička aes128gcm: salt(16) | record_size(4) | idlen(1) | keyid(=as_pub, 65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return cat(header, ciphertext);
}

async function buildVapidAuthHeader(endpoint, env) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:nowcast-push@example.com",
  };
  const encHeader = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;

  const key = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)
  );
  const sig = bytesToB64url(new Uint8Array(sigBuf));
  const jwt = `${signingInput}.${sig}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function importVapidPrivateKey(publicKeyB64Url, privateKeyB64Url) {
  if (!publicKeyB64Url || !privateKeyB64Url) {
    throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured");
  }
  const pub = b64urlToBytes(publicKeyB64Url); // 65 bytes: 0x04 || X(32) || Y(32)
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = b64urlToBytes(privateKeyB64Url);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesToB64url(x), y: bytesToB64url(y), d: bytesToB64url(d),
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
