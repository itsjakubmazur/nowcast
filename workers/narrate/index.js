const SYSTEM_PROMPT = `Jsi zkušený meteorolog, který píše profesionální předpověď pro běžné lidi.
Dostaneš JSON s hodinovými daty o počasí pro konkrétní místo. Napiš předpověď ve dvou odstavcích:

ODSTAVEC 1 — Nejbližších 6 hodin (podrobně):
Uveď konkrétní teploty (min–max ve °C), srážky (kdy začnou/skončí, jak vydatné, kolik mm),
nárazy větru v km/h, a zda hrozí nebo nehrozí bouřky. Buď konkrétní a přesný.

ODSTAVEC 2 — Výhled do konce dne (stručně, 1–2 věty):
Obecný vývoj počasí, trend teplot, jestli se situace zlepší nebo zhorší.

POVINNÁ PRAVIDLA:
- Uváděj POUZE hodnoty a jevy, které jsou ve vstupním JSON. Nic nevymýšlej.
- Časy jsou v místním čase (Europe/Prague) — použij přímo.
- Pokud nejsou srážky: zaměř se na teploty a vítr.

STYL:
- Přirozená čeština, jako meteorolog v rádiu.
- NIKDY nezmiňuj: ICON-D2, Open-Meteo, CAPE (říkej "bouřkový potenciál"), radarová extrapolace.
- Vítr: vždy jen NÁRAZY v km/h. Průměr nezmiňuj.
- Srážky: intenzitu slovně (slabý/mírný/vydatný déšť, přeháňky), úhrn na celé mm.
- Teploty: celé °C, pocitovou jen pokud se liší o ≥3°C.`;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { lat, lon, label } = body;
    if (!lat || !lon) return json({ error: "lat/lon required" }, 400);

    // Fetch Open-Meteo pro dané místo
    let omData;
    try {
      const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${parseFloat(lat).toFixed(4)}&longitude=${parseFloat(lon).toFixed(4)}`
        + `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,cape`
        + `&timezone=Europe%2FPrague&forecast_days=1`;
      const r = await fetch(omUrl);
      if (!r.ok) throw new Error(`OM HTTP ${r.status}`);
      omData = await r.json();
    } catch (e) {
      return json({ error: `Open-Meteo fetch failed: ${e.message}` }, 502);
    }

    // Sestavení promptu — hodinový přehled pro aktuální den
    const prompt = buildPrompt(omData, label);

    // Gemini call
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return json({ error: "GEMINI_API_KEY not configured" }, 500);

    let text;
    try {
      text = await callGemini(prompt, apiKey);
    } catch (e) {
      return json({ error: `Gemini failed: ${e.message}` }, 502);
    }

    return json({ text }, 200);
  }
};

function buildPrompt(om, label) {
  const h = om.hourly || {};
  const times = h.time || [];
  const temp  = h.temperature_2m || [];
  const feels = h.apparent_temperature || [];
  const wc    = h.weather_code || [];
  const prec  = h.precipitation || [];
  const prob  = h.precipitation_probability || [];
  const gusts = h.wind_gusts_10m || [];
  const cape  = h.cape || [];

  // Najdi aktuální hodinu
  const now = new Date();
  const pragueHour = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Prague" }));
  const nowStr = pragueHour.toISOString().slice(0, 14) + "00"; // "2024-06-02T14:00"

  let startIdx = times.findIndex(t => t >= nowStr);
  if (startIdx < 0) startIdx = 0;

  // Prvních 6h hodinově
  const detail = [];
  for (let i = startIdx; i < Math.min(startIdx + 6, times.length); i++) {
    const row = { cas: times[i].slice(11, 16) };
    if (temp[i]  != null) row.teplota_C = Math.round(temp[i]);
    if (feels[i] != null && temp[i] != null && Math.abs(feels[i] - temp[i]) >= 3)
      row.pocitova_C = Math.round(feels[i]);
    if (prec[i]  != null && prec[i] >= 0.1) row.srazky_mm = prec[i];
    if (prob[i]  != null) row.pravdepodobnost_pct = prob[i];
    if (gusts[i] != null) row.narazy_km_h = Math.round(gusts[i]);
    if (wc[i]    != null) row.weather_code = wc[i];
    if (cape[i]  != null && cape[i] >= 200) row.bou_potencial_J_kg = Math.round(cape[i]);
    detail.push(row);
  }

  // Zbytek dne — 3h bloky
  const outlook = [];
  for (let i = startIdx + 6; i < times.length; i += 3) {
    const slice = { cas: times[i].slice(11, 16) };
    const temps = temp.slice(i, i+3).filter(v => v != null);
    if (temps.length) { slice.tmin_C = Math.round(Math.min(...temps)); slice.tmax_C = Math.round(Math.max(...temps)); }
    const precSum = prec.slice(i, i+3).filter(v => v != null).reduce((a,b) => a+b, 0);
    if (precSum >= 0.1) slice.srazky_mm = Math.round(precSum * 10) / 10;
    const maxGust = Math.max(...gusts.slice(i, i+3).filter(v => v != null));
    if (maxGust >= 20) slice.max_narazy_km_h = Math.round(maxGust);
    outlook.push(slice);
  }

  return JSON.stringify({
    misto: label || `${parseFloat(lat).toFixed(2)}°N ${parseFloat(lon).toFixed(2)}°E`,
    detail_0_6h: detail,
    vyhled_zbytek_dne: outlook,
  }, null, 2);
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
