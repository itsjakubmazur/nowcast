"""
Fáze 3b — Narrace (Claude API)
- Načte forecast.json
- Sestaví strukturovaný vstup pro Claude (časy v Europe/Prague)
- Zavolá Claude API s tvrdým guardrailem (nebo vypíše vstup pro kontrolu)
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

# claude-haiku-4-5: levný a rychlý, vhodný pro 10min cron
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

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
    Sestaví vstupní JSON pro Claude — přehledný, bez zbytečných dat.
    Časy jsou převedeny do Europe/Prague.
    """
    ts = forecast.get("timeseries", [])
    warnings = forecast.get("warnings", [])
    nc_source = forecast.get("nowcast_source", {})
    t0 = forecast.get("t0_utc", "")

    # Souhrnné statistiky z nowcastu
    nc_points  = [p for p in ts if p["source"] == "nowcast"]
    nwp_points = [p for p in ts if p["source"] == "nwp"]

    precips_nc = [p["precip_mm_h"] for p in nc_points if p["precip_mm_h"] is not None]
    peak_nc    = max(precips_nc, default=0.0)

    # Najdi okno se srážkami v nowcastu (> 0.1 mm/h)
    rain_nc    = [(p["time_utc"], p["precip_mm_h"]) for p in nc_points
                  if (p["precip_mm_h"] or 0) >= 0.1]
    arrival    = to_prague_time(rain_nc[0][0])  if rain_nc else None
    end_rain   = to_prague_time(rain_nc[-1][0]) if rain_nc else None
    total_nc   = round(sum(v for _, v in rain_nc) * (10 / 60), 2)  # mm (10min kroky)

    # NWP přehled: hodiny s > 0.1 mm/h
    rain_nwp = [(p["time_utc"], p["precip_mm_h"]) for p in nwp_points
                if (p["precip_mm_h"] or 0) >= 0.1]
    nwp_summary = []
    for t_str, v in rain_nwp[:8]:  # max 8 bodů aby prompt nebyl obří
        nwp_summary.append({"time_local": to_prague_time(t_str), "precip_mm_per_15min": v})

    # Vítr z NWP
    wind_vals = [(p["wind_ms"], p["wind_dir"]) for p in nwp_points if p.get("wind_ms")]
    peak_wind = max((w for w, _ in wind_vals), default=None)

    # CAPE (konvekce)
    cape_vals = [p["cape"] for p in nwp_points if p.get("cape")]
    max_cape  = max(cape_vals, default=None)

    # Výstrahy — formátuj platnost v Prague čase
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
        "lokace":       forecast.get("location"),
        "referencni_cas_local": to_prague_time(t0),
        "nowcast_0_2h": {
            "zdroj":         "radarová extrapolace",
            "peak_mm_h":     round(peak_nc, 2),
            "prichod_srazek_local": arrival,
            "konec_srazek_local":   end_rain,
            "odhad_uhrnu_mm":       total_nc,
        },
        "nwp_2h_plus": {
            "zdroj":         "Open-Meteo ICON-D2",
            "hodiny_se_srazkami": nwp_summary,
            "peak_vitr_ms":       round(peak_wind, 1) if peak_wind else None,
            "max_cape":           round(max_cape, 0) if max_cape else None,
        },
        "vystrahy_CHMU": warnings_fmt,
    }

    return json.dumps(prompt_data, ensure_ascii=False, indent=2)


def call_claude(prompt_str: str, api_key: str) -> str:
    """Zavolá Claude API a vrátí text verdiktu."""
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    msg = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=300,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt_str}],
    )
    return msg.content[0].text.strip()


def main():
    forecast_path = DATA_DIR / "forecast.json"
    if not forecast_path.exists():
        print("ERROR: data/forecast.json nenalezen — spusť nejdřív fuse.py", file=sys.stderr)
        sys.exit(1)

    with open(forecast_path) as f:
        forecast = json.load(f)

    print("\n=== Příprava vstupu pro Claude ===")
    prompt_str = build_prompt(forecast)
    print(prompt_str)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")

    if not api_key:
        print("\n⚠  ANTHROPIC_API_KEY není nastaven.")
        print("   Výše je přesný JSON, který by se Claudovi poslal.")
        print("   Nastav GitHub Secret ANTHROPIC_API_KEY a spusť znovu.")
        forecast["verdict"] = {
            "text":  None,
            "note":  "ANTHROPIC_API_KEY není nastaven — verdikt nevygenerován",
            "model": CLAUDE_MODEL,
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        }
    else:
        print("\n=== Volám Claude API ===")
        try:
            verdict_text = call_claude(prompt_str, api_key)
            print(f"\nVERDIKT:\n{verdict_text}")
            forecast["verdict"] = {
                "text":             verdict_text,
                "model":            CLAUDE_MODEL,
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            print(f"ERROR: Claude API selhalo: {e}", file=sys.stderr)
            forecast["verdict"] = {
                "text":  None,
                "error": str(e),
                "model": CLAUDE_MODEL,
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            }

    with open(forecast_path, "w") as f:
        json.dump(forecast, f, indent=2, ensure_ascii=False)
    print(f"\n✓ Fáze 3b — Narrace OK → {forecast_path}")


if __name__ == "__main__":
    main()
