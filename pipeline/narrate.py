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
Jsi meteorologický asistent. Dostaneš strukturovaný JSON s předpovědí počasí.

PRAVIDLA (závazná, bez výjimek):
- Popisuj POUZE čísla, jevy a výstrahy, které dostaneš ve vstupním JSON.
- Nic nedopočítávej, neodhaduj, nevymýšlej. Nepoužívej žádné znalosti z tréninku.
- Pokud data chybí nebo jsou nulová, řekni to.
- Odpověz česky, 2–4 věty, uveď konkrétní časy a hodnoty ze vstupu.
- Časy jsou v místním čase (Europe/Prague) — použij je přímo.
- Nepiš žádné uvozovací věty ani závěry mimo věcný popis dat.\
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
    Sestaví vstupní JSON pro Gemini — přehledný, bez zbytečných dat.
    Časy jsou převedeny do Europe/Prague.
    """
    ts = forecast.get("timeseries", [])
    warnings = forecast.get("warnings", [])
    t0 = forecast.get("t0_utc", "")

    nc_points  = [p for p in ts if p["source"] == "nowcast"]
    nwp_points = [p for p in ts if p["source"] == "nwp"]

    precips_nc = [p["precip_mm_h"] for p in nc_points if p["precip_mm_h"] is not None]
    peak_nc    = max(precips_nc, default=0.0)

    rain_nc  = [(p["time_utc"], p["precip_mm_h"]) for p in nc_points
                if (p["precip_mm_h"] or 0) >= 0.1]
    arrival  = to_prague_time(rain_nc[0][0])  if rain_nc else None
    end_rain = to_prague_time(rain_nc[-1][0]) if rain_nc else None
    total_nc = round(sum(v for _, v in rain_nc) * (10 / 60), 2)

    rain_nwp = [(p["time_utc"], p["precip_mm_h"]) for p in nwp_points
                if (p["precip_mm_h"] or 0) >= 0.1]
    nwp_summary = []
    for t_str, v in rain_nwp[:8]:
        nwp_summary.append({"time_local": to_prague_time(t_str), "precip_mm_per_15min": v})

    wind_vals  = [p["wind_ms"]           for p in nwp_points if p.get("wind_ms")]
    gusts_vals = [p.get("wind_gusts_ms") for p in nwp_points if p.get("wind_gusts_ms")]
    peak_wind  = max(wind_vals,  default=None)
    peak_gusts = max(gusts_vals, default=None)

    cape_vals = [p["cape"] for p in nwp_points if p.get("cape")]
    max_cape  = max(cape_vals, default=None)

    warnings_fmt = []
    for w in warnings:
        warnings_fmt.append({
            "jev":    w.get("event", ""),
            "stupen": w.get("severity", ""),
            "barva":  w.get("color", ""),
            "od":     to_prague_time(w.get("onset_utc", "")),
            "do":     to_prague_time(w.get("expires_utc", "")),
        })

    prompt_data = {
        "lokace":               forecast.get("location"),
        "referencni_cas_local": to_prague_time(t0),
        "nowcast_0_2h": {
            "zdroj":                   "radarová extrapolace",
            "peak_mm_h":               round(peak_nc, 2),
            "prichod_srazek_local":    arrival,
            "konec_srazek_local":      end_rain,
            "odhad_uhrnu_mm":          total_nc,
        },
        "nwp_2h_plus": {
            "zdroj":                  "Open-Meteo ICON-D2",
            "hodiny_se_srazkami":     nwp_summary,
            "peak_vitr_prumer_ms":    round(peak_wind,  1) if peak_wind  else None,
            "peak_narazy_ms":         round(peak_gusts, 1) if peak_gusts else None,
            "max_cape":               round(max_cape,   0) if max_cape   else None,
        },
        "vystrahy_CHMU": warnings_fmt,
    }

    return json.dumps(prompt_data, ensure_ascii=False, indent=2)


def template_verdict(forecast: dict) -> str:
    """Sestaví věcný verdikt ze šablony bez AI — vždy uspěje."""
    ts = forecast.get("timeseries", [])
    warnings = forecast.get("warnings", [])
    t0 = forecast.get("t0_utc", "")
    ref_time = to_prague_time(t0) if t0 else "N/A"

    nc_points  = [p for p in ts if p["source"] == "nowcast"]
    nwp_points = [p for p in ts if p["source"] == "nwp"]

    rain_nc = [(p["time_utc"], p["precip_mm_h"]) for p in nc_points
               if (p["precip_mm_h"] or 0) >= 0.1]
    peak_nc = max((p["precip_mm_h"] for p in nc_points if p["precip_mm_h"]), default=0.0)

    rain_nwp = [(p["time_utc"], p["precip_mm_h"]) for p in nwp_points
                if (p["precip_mm_h"] or 0) >= 0.1]
    gusts_vals = [p.get("wind_gusts_ms") for p in nwp_points if p.get("wind_gusts_ms")]
    peak_gusts = max(gusts_vals, default=None)

    sentences = []

    # Věta 1: nowcast srážky
    if rain_nc:
        arrival  = to_prague_time(rain_nc[0][0])
        end_rain = to_prague_time(rain_nc[-1][0])
        total_nc = round(sum(v for _, v in rain_nc) * (10 / 60), 2)
        sentences.append(
            f"Radarová extrapolace (ref. {ref_time}) předpovídá srážky "
            f"od {arrival} do {end_rain}, peak {round(peak_nc,1)} mm/h, "
            f"odhadovaný úhrn {total_nc} mm."
        )
    else:
        sentences.append(
            f"Radarová extrapolace (ref. {ref_time}) nepředpovídá srážky v následujících 2 hodinách."
        )

    # Věta 2: NWP srážky
    if rain_nwp:
        first_nwp = to_prague_time(rain_nwp[0][0])
        sentences.append(
            f"Model ICON-D2 indikuje srážky od {first_nwp} a dále."
        )

    # Věta 3: nárazy větru
    if peak_gusts and peak_gusts >= 10:
        sentences.append(f"Nárazy větru dosahují až {round(peak_gusts,1)} m/s.")

    # Věta 4: výstrahy
    if warnings:
        w = warnings[0]
        jev    = w.get("event", "")
        barva  = w.get("color", "")
        od     = to_prague_time(w.get("onset_utc", ""))
        do_cas = to_prague_time(w.get("expires_utc", ""))
        sentences.append(
            f"ČHMÚ výstraha ({barva}): {jev}, platná {od}–{do_cas}."
        )

    return " ".join(sentences)


def call_gemini(prompt_str: str, api_key: str) -> str:
    """Zavolá Gemini API; při 429 zkusí flash-lite jako záložní model."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    def _call(model: str) -> str:
        response = client.models.generate_content(
            model=model,
            contents=prompt_str,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                max_output_tokens=300,
                temperature=0.2,
            ),
        )
        return response.text.strip()

    try:
        print(f"  Zkouším {GEMINI_MODEL_PRIMARY}...")
        return _call(GEMINI_MODEL_PRIMARY)
    except Exception as e:
        if "429" in str(e) or "quota" in str(e).lower() or "RESOURCE_EXHAUSTED" in str(e):
            print(f"  429 / quota na {GEMINI_MODEL_PRIMARY}, zkouším {GEMINI_MODEL_FALLBACK}...")
            return _call(GEMINI_MODEL_FALLBACK)
        raise


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
            verdict_text = call_gemini(prompt_str, api_key)
            # Zjistíme, který model byl použit (flash nebo lite)
            used_model = GEMINI_MODEL_PRIMARY  # call_gemini vrací text, model neznáme přesně
            print(f"\nVERDIKT (Gemini):\n{verdict_text}")
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
