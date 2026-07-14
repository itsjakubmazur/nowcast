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
- Časy jsou v místním čase (Europe/Prague) — použij přímo.
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
const CACHE_VERSION = "v3";
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
      if (url.pathname === "/vapid-public-key" && request.method === "GET") {
        return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
      }
      if (url.pathname === "/subscribe" && request.method === "POST") {
        return await handleSubscribe(request, env);
      }
      if (url.pathname === "/unsubscribe" && request.method === "POST") {
        return await handleUnsubscribe(request, env);
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
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "lat/lon required" }, 400);
  }

  // Zaokrouhli na ~1 km, ať víc lidí ze stejné obce trefí stejný cache klíč.
  const rlat = lat.toFixed(2);
  const rlon = lon.toFixed(2);
  const cacheKey = new Request(
    `https://cache.internal/verdict?v=${CACHE_VERSION}&lat=${rlat}&lon=${rlon}`,
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

  const result = await generateVerdict(lat, lon, label, env);
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

async function generateVerdict(lat, lon, label, env) {
  let omData;
  try {
    const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,cape`
      + `&timezone=Europe%2FPrague&forecast_days=1`;
    const r = await fetch(omUrl);
    if (!r.ok) throw new Error(`OM HTTP ${r.status}`);
    omData = await r.json();
  } catch (e) {
    return { error: `Open-Meteo fetch failed: ${e.message}`, status: 502 };
  }

  const prompt = buildPrompt(omData, label);

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { error: "GEMINI_API_KEY not configured", status: 500 };

  try {
    const text = await callGemini(prompt, apiKey);
    return { text };
  } catch (e) {
    return { error: `Gemini failed: ${e.message}`, status: 502 };
  }
}

function buildPrompt(om, label) {
  const h = om.hourly || {};
  const times = h.time || [];
  const temp = h.temperature_2m || [];
  const feels = h.apparent_temperature || [];
  const wc = h.weather_code || [];
  const prec = h.precipitation || [];
  const prob = h.precipitation_probability || [];
  const gusts = h.wind_gusts_10m || [];
  const cape = h.cape || [];

  const now = new Date();
  const pragueHour = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  const nowStr = pragueHour.toISOString().slice(0, 14) + "00";

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

  return JSON.stringify({
    misto: isGenericLabel ? `${lat.toFixed(2)}°N ${lon.toFixed(2)}°E` : label,
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

  let cursor;
  let checked = 0, notified = 0, expired = 0;
  do {
    const page = await env.SUBSCRIPTIONS.list({ prefix: "sub:", cursor, limit: 1000 });
    for (const k of page.keys) {
      checked++;
      const record = await env.SUBSCRIPTIONS.get(k.name, "json");
      if (!record) continue;
      const outcome = await checkAndNotify(k.name, record, grid, env);
      if (outcome === "notified") notified++;
      if (outcome === "expired") expired++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(`runPushCheck: checked=${checked} notified=${notified} expired=${expired}`);
}

async function checkAndNotify(key, record, grid, env) {
  const now = Date.now();
  let shouldNotify = false;
  let reason = "";

  for (const fav of record.favorites || []) {
    const favKey = `${fav.lat.toFixed(2)},${fav.lon.toFixed(2)}`;
    const lastNotified = record.notified?.[favKey] ? Date.parse(record.notified[favKey]) : 0;

    const { id } = nearestPtIdx(grid, fav.lat, fav.lon);
    if (id == null) continue;

    // Výstrahy (CAP) — vyšší priorita, delší snooze
    const matchIdx = new Set(grid.wmatch?.[String(id)] || []);
    const activeWarn = (grid.warnings || []).find((w, wi) =>
      (w.global || matchIdx.has(wi)) && ["yellow", "orange", "red"].includes(w.color));
    if (activeWarn && now - lastNotified > WARN_SNOOZE_MS) {
      shouldNotify = true;
      reason = `warn:${favKey}`;
      record.notified = record.notified || {};
      record.notified[favKey] = new Date(now).toISOString();
      continue;
    }

    // Příchozí srážky
    const act = grid.act?.[String(id)];
    if (act && now - lastNotified > PUSH_SNOOZE_MS) {
      const [startStep] = act;
      const rainVal = act[2];
      if (rainVal >= RAIN_THRESHOLD_MM_H && startStep <= RAIN_LOOKAHEAD_STEPS) {
        shouldNotify = true;
        reason = `rain:${favKey}`;
        record.notified = record.notified || {};
        record.notified[favKey] = new Date(now).toISOString();
      }
    }
  }

  if (!shouldNotify) return "skip";

  const resp = await sendPush(record.subscription, env).catch(() => null);
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

function nearestPtIdx(grid, lat, lon) {
  const pts = grid.pts || [];
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = haversineKm(lat, lon, pts[i][0], pts[i][1]);
    if (d < bd) { bd = d; best = i; }
  }
  return { id: best, dist: bd };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Web Push (VAPID, prázdný payload — RFC 8292, bez potřeby ECE šifrování) ──

async function sendPush(subscription, env, ttlSeconds = 300) {
  const auth = await buildVapidAuthHeader(subscription.endpoint, env);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      TTL: String(ttlSeconds),
      "Content-Length": "0",
    },
  });
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
