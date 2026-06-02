"""
Fáze 3b — Narrace (Google Gemini API)
- Načte forecast.json
- Sestaví strukturovaný vstup pro Gemini (časy v Europe/Prague)
- Zavolá Gemini API s tvrdým guardrailem; záloha: gemini-2.5-flash-lite na 429
- Fallback bez AI: template_verdict() — vždy vyprodukuje verdikt
- Uloží verdikt zpět do forecast.json
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DATA_DIR = Path(__file__).parent.parent / "data"
PRAGUE_TZ = ZoneInfo("Europe/Prague")

GEMINI_MODEL_PRIMARY = "gemini-2.5-flash"
GEMINI_MODEL_FALLBACK = "gemini-2.5-flash-lite"

SYSTEM_PROMPT = """\
Jsi zkušený meteorolog, který píše profesionální předpověď pro běžné lidi.
Dostaneš JSON s hodinovými daty o počasí. Napiš předpověď ve dvou odstavcích:

ODSTAVEC 1 — Nejbližších 6 hodin (podrobně):
Uveď konkrétní teploty (min–max ve °C), srážky (kdy začnou/skončí, jak vydatné, kolik mm),
nárazy větru v km/h, a zda hrozí nebo nehrozí bouřky. Buď konkrétní a přesný.

ODSTAVEC 2 — Výhled do konce dne (stručně, 1–2 věty):
Obecný vývoj počasí, trend teplot, jestli se situace zlepší nebo zhorší.

POVINNÁ PRAVIDLA:
- Uváděj POUZE hodnoty a jevy, které jsou ve vstupním JSON. Nic nevymýšlej.
- Časy jsou v místním čase (Europe/Prague) — použij přímo, nepřepočítávej.
- Platná výstraha ČHMÚ musí být VŽDY první věta: barva + jev + platnost.
- Pokud nejsou žádné srážky: v 1. odstavci to jasně řekni a zaměř se na teploty a vítr.

STYL:
- Piš přirozenou češtinou, jako meteorolog v rádiu. Ne jako technik.
- NIKDY nezmiňuj: ICON-D2, Open-Meteo, CAPE (říkej "bouřkový potenciál"), radarová extrapolace.
- Vítr: vždy jen NÁRAZY v km/h (m/s × 3,6, zaokrouhli na 10). Průměr nezmiňuj.
- Srážky: intenzitu slovně (slabý/mírný/vydatný déšť, přeháňky), úhrn na celé mm.
- Teploty: zaokrouhli na celé °C, uveď pocitovou jen pokud se liší o ≥ 3°C.\
"""


def to_prague_time(utc_str: str) -> str:
    """Převede UTC ISO string na čas v Europe/Prague (HH:MM)."""
    try:
        dt_utc = datetime.fromisoformat(utc_str)
        if dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)
        dt_local = dt_utc.astimezone(PRAGUE_TZ)
        return dt_local.strftime("%H:%M")
    except Exception:
        return utc_str


def build_prompt(forecast: dict) -> str:
    """
    Sestaví vstupní JSON pro Gemini.
    - Prvních 6 h: hodinové kroky s teplotou, srážkami, větrem, wc
    - Zbytek dne: 3h bloky (aggregate)
    """
    from datetime import timedelta

    ts       = forecast.get("timeseries", [])
    warnings = forecast.get("warnings", [])
    t0_str   = forecast.get("t0_utc", "")

    try:
        t0 = datetime.fromisoformat(t0_str)
        if t0.tzinfo is None:
            t0 = t0.replace(tzinfo=timezone.utc)
    except Exception:
        t0 = datetime.now(timezone.utc)

    cutoff_6h = t0 + timedelta(hours=6)

    # ── Hodinové kroky pro prvních 6 h ────────────────────────────────────────
    # Seskup 15min body do hodin — vezmi poslední hodnoty v dané hodině
    hourly_map: dict[str, dict] = {}
    for p in ts:
        try:
            t = datetime.fromisoformat(p["time_utc"])
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if t > cutoff_6h:
            continue
        h_key = t.replace(minute=0, second=0, microsecond=0).isoformat()
        if h_key not in hourly_map:
            hourly_map[h_key] = {"time_utc": h_key, "precip_mm_h": 0.0,
                                 "gust_kmh": None, "temp_c": None,
                                 "feels_c": None, "weather_code": None,
                                 "precip_prob": None, "cape": None}
        e = hourly_map[h_key]
        if p.get("precip_mm_h") is not None:
            e["precip_mm_h"] = round(max(e["precip_mm_h"] or 0, p["precip_mm_h"]), 2)
        if p.get("wind_gusts_ms") is not None:
            g = round(p["wind_gusts_ms"] * 3.6)
            e["gust_kmh"] = max(e["gust_kmh"] or 0, g)
        for field in ("temp_c", "feels_c", "weather_code", "precip_prob", "cape"):
            if p.get(field) is not None:
                e[field] = p[field]

    detailed = []
    for k in sorted(hourly_map):
        e = hourly_map[k]
        row = {"cas_local": to_prague_time(e["time_utc"])}
        if e["temp_c"] is not None:
            row["teplota_C"] = round(e["temp_c"], 1)
        if e["feels_c"] is not None and e["temp_c"] is not None and abs(e["feels_c"] - e["temp_c"]) >= 3:
            row["pocitova_C"] = round(e["feels_c"], 1)
        if e["precip_mm_h"] and e["precip_mm_h"] >= 0.1:
            row["srazky_mm_h"] = e["precip_mm_h"]
        if e["precip_prob"] is not None:
            row["pravdepodobnost_srazek_pct"] = e["precip_prob"]
        if e["gust_kmh"] and e["gust_kmh"] >= 20:
            row["narazy_km_h"] = e["gust_kmh"]
        if e["weather_code"] is not None:
            row["weather_code"] = e["weather_code"]
        if e["cape"] and e["cape"] >= 200:
            row["bou_potencial_J_kg"] = round(e["cape"])
        detailed.append(row)

    # ── 3h bloky pro zbytek dne ───────────────────────────────────────────────
    block_map: dict[str, dict] = {}
    for p in ts:
        try:
            t = datetime.fromisoformat(p["time_utc"])
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if t <= cutoff_6h:
            continue
        # Zaokrouhli na 3h blok
        block_h = (t.hour // 3) * 3
        bkey = t.replace(hour=block_h, minute=0, second=0, microsecond=0).isoformat()
        if bkey not in block_map:
            block_map[bkey] = {"time_utc": bkey, "precip_mm": 0.0,
                               "max_gust_kmh": None, "temps": [],
                               "max_cape": None, "precip_prob": None}
        b = block_map[bkey]
        if p.get("precip_mm_h") is not None:
            b["precip_mm"] = round(b["precip_mm"] + p["precip_mm_h"] * 0.25, 2)
        if p.get("wind_gusts_ms") is not None:
            g = round(p["wind_gusts_ms"] * 3.6)
            b["max_gust_kmh"] = max(b["max_gust_kmh"] or 0, g)
        if p.get("temp_c") is not None:
            b["temps"].append(p["temp_c"])
        if p.get("cape") is not None and p["cape"] >= 200:
            b["max_cape"] = max(b["max_cape"] or 0, p["cape"])
        if p.get("precip_prob") is not None:
            b["precip_prob"] = max(b["precip_prob"] or 0, p["precip_prob"])

    outlook = []
    for k in sorted(block_map):
        b = block_map[k]
        row = {"cas_local": to_prague_time(b["time_utc"])}
        if b["temps"]:
            row["teplota_min_C"] = round(min(b["temps"]), 1)
            row["teplota_max_C"] = round(max(b["temps"]), 1)
        if b["precip_mm"] >= 0.1:
            row["srazky_mm"] = b["precip_mm"]
        if b["precip_prob"] is not None:
            row["pravdepodobnost_srazek_pct"] = b["precip_prob"]
        if b["max_gust_kmh"] and b["max_gust_kmh"] >= 20:
            row["max_narazy_km_h"] = b["max_gust_kmh"]
        if b["max_cape"]:
            row["bou_potencial_J_kg"] = round(b["max_cape"])
        outlook.append(row)

    warnings_fmt = [
        {
            "jev":    w.get("event", ""),
            "barva":  w.get("color", ""),
            "od":     to_prague_time(w.get("onset_utc", "")),
            "do":     to_prague_time(w.get("expires_utc", "")),
        }
        for w in warnings
    ]

    prompt_data = {
        "lokace":               forecast.get("location"),
        "referencni_cas_local": to_prague_time(t0_str),
        "vystrahy_CHMU":        warnings_fmt,
        "detail_0_6h":          detailed,
        "vyhled_zbytek_dne":    outlook,
    }

    return json.dumps(prompt_data, ensure_ascii=False, indent=2)


def _rain_intensity(peak_mm_h: float) -> str:
    """Slovní popis intenzity srážek podle mm/h."""
    if peak_mm_h < 0.5:
        return "slabé přeháňky"
    if peak_mm_h < 2.5:
        return "slabý déšť"
    if peak_mm_h < 7.5:
        return "mírný déšť"
    if peak_mm_h < 15:
        return "vydatný déšť"
    return "silný déšť"


def _gusts_kmh(ms: float) -> int:
    """Převede m/s na km/h, zaokrouhlí na celých 10."""
    return round(ms * 3.6 / 10) * 10


def template_verdict(forecast: dict) -> str:
    """Sestaví lidsky srozumitelný verdikt ze šablony bez AI — vždy uspěje."""
    ts       = forecast.get("timeseries", [])
    warnings = forecast.get("warnings", [])

    nc_points  = [p for p in ts if p["source"] == "nowcast"]
    nwp_points = [p for p in ts if p["source"] == "nwp"]

    rain_nc = [(p["time_utc"], p["precip_mm_h"]) for p in nc_points
               if (p["precip_mm_h"] or 0) >= 0.1]
    peak_nc = max((p["precip_mm_h"] for p in nc_points if p["precip_mm_h"]), default=0.0)

    rain_nwp = [(p["time_utc"], p["precip_mm_h"]) for p in nwp_points
                if (p["precip_mm_h"] or 0) >= 0.1]
    gusts_vals = [p.get("wind_gusts_ms") for p in nwp_points if p.get("wind_gusts_ms")]
    peak_gusts = max(gusts_vals, default=None)

    p1 = []  # odstavec 1 — detail 0–6h
    p2 = []  # odstavec 2 — výhled

    # Teploty z NWP (prvních 6h)
    from datetime import timedelta
    try:
        t0_dt = datetime.fromisoformat(forecast.get("t0_utc", "")).replace(tzinfo=timezone.utc)
    except Exception:
        t0_dt = datetime.now(timezone.utc)
    cutoff_6h = t0_dt + timedelta(hours=6)
    nwp_6h = [p for p in nwp_points if datetime.fromisoformat(
        p["time_utc"] if "+" in p["time_utc"] else p["time_utc"] + "+00:00"
    ) <= cutoff_6h]
    temps_6h = [p["temp_c"] for p in nwp_6h if p.get("temp_c") is not None]
    temps_all = [p["temp_c"] for p in nwp_points if p.get("temp_c") is not None]

    # Výstraha
    if warnings:
        w = warnings[0]
        barva = w.get("color", "")
        color_cz = {"yellow": "žlutou", "orange": "oranžovou", "red": "červenou"}.get(barva, barva)
        od = to_prague_time(w.get("onset_utc", ""))
        do_cas = to_prague_time(w.get("expires_utc", ""))
        p1.append(f"ČHMÚ vydalo {color_cz} výstrahu ({w.get('event','')}), platnou od {od} do {do_cas}.")

    # Teploty v nejbližších 6 hodinách
    if temps_6h:
        tmin, tmax = round(min(temps_6h)), round(max(temps_6h))
        if tmin == tmax:
            p1.append(f"Teploty se pohybují kolem {tmax} °C.")
        else:
            p1.append(f"Teploty se pohybují mezi {tmin} a {tmax} °C.")

    # Srážky v nejbližších hodinách
    if rain_nc:
        arrival  = to_prague_time(rain_nc[0][0])
        end_rain = to_prague_time(rain_nc[-1][0])
        total_nc = round(sum(v for _, v in rain_nc) * (10 / 60))
        intenzita = _rain_intensity(peak_nc)
        total_str = "do 1 mm" if total_nc < 1 else f"kolem {total_nc} mm"
        p1.append(f"Srážky se očekávají od {arrival} do {end_rain} ({intenzita}, úhrn {total_str}).")
    else:
        p1.append("Srážky se v nejbližší době neočekávají.")

    # Vítr
    if peak_gusts and peak_gusts >= 8:
        p1.append(f"Vítr může v nárazech dosahovat kolem {_gusts_kmh(peak_gusts)} km/h.")

    # Výhled
    if rain_nwp:
        first_nwp = to_prague_time(rain_nwp[0][0])
        p2.append(f"V dalším výhledu jsou srážky možné přibližně od {first_nwp}.")
    else:
        p2.append("Do konce dne by srážky neměly výrazněji přibývat.")

    if temps_all:
        tmin_day, tmax_day = round(min(temps_all)), round(max(temps_all))
        p2.append(f"Denní teplotní rozsah {tmin_day}–{tmax_day} °C.")

    return " ".join(p1) + "\n\n" + " ".join(p2)


def looks_truncated(text: str) -> bool:
    """Vrátí True, pokud verdikt vypadá prázdný / příliš krátký / useknutý uprostřed věty."""
    if not text:
        return True
    t = text.strip()
    if len(t) < 25:
        return True
    # Věta by měla končit interpunkcí (. ! ? …) nebo uvozovkou
    if t[-1] not in ".!?…\"')":
        return True
    return False


def call_gemini(prompt_str: str, api_key: str) -> str:
    """
    Zavolá Gemini API s retry + exponential backoff.
    - 503 (UNAVAILABLE) / 429 (rate limit): zkus znovu, max 3 pokusy, prodleva ~2s, 4s, 8s.
    - Při 429 přepni od 2. pokusu na flash-lite (vyšší denní limit).
    - Po vyčerpání pokusů vyhodí výjimku (volající spadne na template_verdict).
    """
    import time
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    def _call(model: str) -> str:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=1200,
            temperature=0.2,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        )
        print(f"  config: model={model}, max_output_tokens=800, thinking_budget=0")
        response = client.models.generate_content(
            model=model,
            contents=prompt_str,
            config=config,
        )
        # Zaloguj důvod ukončení (MAX_TOKENS, STOP, ...)
        finish_reason = None
        try:
            finish_reason = response.candidates[0].finish_reason
        except Exception:
            pass
        print(f"  finish_reason: {finish_reason}")
        text = (response.text or "").strip()
        if finish_reason and str(finish_reason).upper().endswith("MAX_TOKENS"):
            print("  WARN: odpověď ukončena limitem MAX_TOKENS — text může být useknutý")
        return text

    max_attempts = 3
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        # Při rate limitu (429) přepni od 2. pokusu na flash-lite
        model = GEMINI_MODEL_PRIMARY
        if attempt > 1 and last_exc is not None:
            es = str(last_exc)
            if "429" in es or "quota" in es.lower() or "RESOURCE_EXHAUSTED" in es:
                model = GEMINI_MODEL_FALLBACK

        try:
            print(f"  Pokus {attempt}/{max_attempts} — {model}...")
            return _call(model)
        except Exception as e:
            es = str(e)
            retryable = (
                "503" in es or "UNAVAILABLE" in es
                or "429" in es or "quota" in es.lower() or "RESOURCE_EXHAUSTED" in es
            )
            last_exc = e
            if not retryable or attempt == max_attempts:
                raise
            delay = 2 ** attempt  # 2s, 4s, 8s
            print(f"  Chyba ({es[:80]}...) — retry za {delay}s")
            time.sleep(delay)

    # Sem se kód nedostane (buď return, nebo raise výše)
    raise last_exc


def main():
    forecast_path = DATA_DIR / "forecast.json"
    if not forecast_path.exists():
        print("ERROR: data/forecast.json nenalezen — spusť nejdřív fuse.py", file=sys.stderr)
        sys.exit(1)

    with open(forecast_path) as f:
        forecast = json.load(f)

    print("\n=== Příprava vstupu pro Gemini ===")
    prompt_str = build_prompt(forecast)
    print(prompt_str)

    api_key = os.environ.get("GEMINI_API_KEY", "")
    used_model = None
    verdict_text = None

    if api_key:
        print("\n=== Volám Gemini API ===")
        try:
            candidate = call_gemini(prompt_str, api_key)
            print(f"\nVERDIKT (Gemini):\n{candidate}")
            if looks_truncated(candidate):
                print("WARN: Gemini verdikt vypadá prázdný / useknutý — padám na šablonu", file=sys.stderr)
            else:
                verdict_text = candidate
                used_model = GEMINI_MODEL_PRIMARY
        except Exception as e:
            print(f"WARN: Gemini API selhalo: {e} — používám šablonový verdikt", file=sys.stderr)

    if verdict_text is None:
        if not api_key:
            print("\n⚠  GEMINI_API_KEY není nastaven — používám šablonový verdikt.")
        verdict_text = template_verdict(forecast)
        used_model = "template"
        print(f"\nVERDIKT (šablona):\n{verdict_text}")

    forecast["verdict"] = {
        "text":             verdict_text,
        "model":            used_model or GEMINI_MODEL_PRIMARY,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }

    with open(forecast_path, "w") as f:
        json.dump(forecast, f, indent=2, ensure_ascii=False)
    print(f"\n✓ Fáze 3b — Narrace OK → {forecast_path}")


if __name__ == "__main__":
    main()
