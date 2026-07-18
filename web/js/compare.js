// Porovnání dvou míst — aktuální místo vs. libovolná obec z geocoderu.
// Lehký fetch (current + daily na 1 den) pro obě polohy, tabulka vedle sebe.

import { state } from "./state.js";
import { esc } from "./utils.js";
import { wcLabel } from "./icons.js";

async function fetchCompact(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation,relative_humidity_2m`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,uv_index_max`
    + `&forecast_days=1&timezone=auto`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(q) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=cs&countryCode=CZ`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.results || [];
}

function fmtRow(label, a, b, unit = "", better = null) {
  // better: "lower" | "higher" | null — zvýrazní výhodnější stranu
  let clsA = "", clsB = "";
  if (better && a != null && b != null && a !== b) {
    const aWins = better === "lower" ? a < b : a > b;
    clsA = aWins ? " cmp-win" : "";
    clsB = aWins ? "" : " cmp-win";
  }
  const f = v => v == null ? "—" : `${v}${unit}`;
  return `<div class="cmp-row"><span class="cmp-label">${esc(label)}</span>
    <span class="cmp-val${clsA}">${f(a)}</span><span class="cmp-val${clsB}">${f(b)}</span></div>`;
}

function renderCompareTable(placeA, dataA, placeB, dataB) {
  const box = document.getElementById("compare-result");
  if (!box) return;
  const cA = dataA.current || {}, cB = dataB.current || {};
  const dA = dataA.daily || {}, dB = dataB.daily || {};
  const r = (v, dec = 0) => v == null ? null : Math.round(v * 10 ** dec) / 10 ** dec;

  box.innerHTML = `
    <div class="cmp-row cmp-head"><span class="cmp-label"></span>
      <span class="cmp-val">${esc(placeA)}</span><span class="cmp-val">${esc(placeB)}</span></div>
    ${fmtRow("Teď", cA.weather_code != null ? wcLabel(cA.weather_code) : null, cB.weather_code != null ? wcLabel(cB.weather_code) : null)}
    ${fmtRow("Teplota", r(cA.temperature_2m), r(cB.temperature_2m), "°")}
    ${fmtRow("Pocitová", r(cA.apparent_temperature), r(cB.apparent_temperature), "°")}
    ${fmtRow("Dnes max/min", dA.temperature_2m_max ? `${Math.round(dA.temperature_2m_max[0])}°/${Math.round(dA.temperature_2m_min[0])}` : null,
              dB.temperature_2m_max ? `${Math.round(dB.temperature_2m_max[0])}°/${Math.round(dB.temperature_2m_min[0])}` : null, "°")}
    ${fmtRow("Srážky dnes", r(dA.precipitation_sum?.[0], 1), r(dB.precipitation_sum?.[0], 1), " mm", "lower")}
    ${fmtRow("Pravděp. srážek", r(dA.precipitation_probability_max?.[0]), r(dB.precipitation_probability_max?.[0]), " %", "lower")}
    ${fmtRow("Vítr · nárazy", cA.wind_speed_10m != null ? `${r(cA.wind_speed_10m)}·${r(cA.wind_gusts_10m)}` : null,
              cB.wind_speed_10m != null ? `${r(cB.wind_speed_10m)}·${r(cB.wind_gusts_10m)}` : null, " km/h", "lower")}
    ${fmtRow("Vlhkost", r(cA.relative_humidity_2m), r(cB.relative_humidity_2m), " %")}
    ${fmtRow("UV max", r(dA.uv_index_max?.[0]), r(dB.uv_index_max?.[0]))}`;
}

export function initCompare() {
  const overlay = document.getElementById("compare-overlay");
  const btn = document.getElementById("btn-compare");
  if (!overlay || !btn) return;

  const input = document.getElementById("compare-input");
  const sugg = document.getElementById("compare-suggestions");
  const result = document.getElementById("compare-result");

  btn.addEventListener("click", () => {
    if (state.currentLat == null) return;
    overlay.classList.add("open");
    result.innerHTML = "";
    sugg.innerHTML = "";
    input.value = "";
    setTimeout(() => input.focus(), 50);
  });
  document.getElementById("compare-close")?.addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });

  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) { sugg.innerHTML = ""; return; }
    debounce = setTimeout(async () => {
      try {
        const results = await geocode(q);
        sugg.innerHTML = results.map((res, i) =>
          `<li data-i="${i}">${esc(res.name)}${res.admin1 ? ` <span style="color:var(--muted)">· ${esc(res.admin1)}</span>` : ""}</li>`
        ).join("");
        sugg.querySelectorAll("li").forEach(li => {
          li.addEventListener("click", async () => {
            const res = results[+li.dataset.i];
            sugg.innerHTML = "";
            input.value = res.name;
            result.innerHTML = `<div class="set-log-empty">Načítám porovnání…</div>`;
            try {
              const [a, b] = await Promise.all([
                fetchCompact(state.currentLat, state.currentLon),
                fetchCompact(res.latitude, res.longitude),
              ]);
              renderCompareTable(state.currentLabel || "Aktuální místo", a, res.name, b);
            } catch {
              result.innerHTML = `<div class="set-log-empty">Porovnání se nepodařilo načíst.</div>`;
            }
          });
        });
      } catch { /* geocoder nedostupný */ }
    }, 300);
  });
}

// Tlačítko se ukazuje až když je vybrané místo (volá showForecast)
export function showCompareBtn() {
  document.getElementById("btn-compare")?.classList.add("show");
}
