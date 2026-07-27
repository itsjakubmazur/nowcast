"""
Testy pro pipeline/carry_over.py — přenos souborů z posledního nasazení.

Proč: tenhle krok drží web kompletní i v běhu, který stanice nevyrábí.
Kdyby přenášel i zastaralá data, bylo by to horší než chybějící panel —
appka by tvářila včerejší měření jako aktuální. Testy hlídají právě tu mez.

Spouštění: python tests/test_carry_over.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import carry_over as co  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  \u2713 {name}")
    else:
        print(f"  \u2717 {name}  {detail}")
        FAILS.append(name)


def main():
    now = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)
    print("=== carry_over \u2014 stáří a výběr souborů ===")

    # Různé moduly pojmenovaly čas vzniku různě — všechny se musí přečíst.
    for key in ("generated_at_utc", "run_utc", "updated_at_utc", "obs_utc", "built_utc"):
        doc = {key: (now - timedelta(hours=3)).isoformat()}
        check(f"stáří se přečte z pole {key}",
              abs((co.age_hours(doc, now) or 0) - 3) < 0.01,
              str(co.age_hours(doc, now)))

    check("čas se Z na konci se přečte",
          abs((co.age_hours({"generated_at_utc": "2026-07-27T09:00:00Z"}, now) or 0) - 3) < 0.01)
    check("naivní čas se bere jako UTC, ne jako lokální",
          abs((co.age_hours({"generated_at_utc": "2026-07-27T09:00:00"}, now) or 0) - 3) < 0.01)
    check("bez časového pole vrátí None", co.age_hours({"neco": 1}, now) is None)
    check("rozbitý čas vrátí None",
          co.age_hours({"generated_at_utc": "nesmysl"}, now) is None)
    check("neslovníkový vstup nespadne", co.age_hours([], now) is None)

    # Meze stáří musí odpovídat povaze dat.
    check("stanice mají krátkou mez (\u2264 6 h)", co.CARRY["chmi_stations.json"] <= 6)
    check("srážkoměry mají krátkou mez (\u2264 6 h)", co.CARRY["chmi_rain.json"] <= 6)
    check("ovzduší má krátkou mez (\u2264 6 h)", co.CARRY["chmi_air.json"] <= 6)
    check("normály 1991\u20132020 jsou statické, mez je dlouhá",
          co.CARRY["chmi_normals.json"] >= 24 * 300)
    check("ALADIN vydrží den (4 běhy denně)", 12 <= co.CARRY["aladin.json"] <= 48)

    # Soubory, kvůli kterým to celé vzniklo, tam MUSÍ být.
    for must in ("chmi_stations.json", "aladin.json", "metar_stations.json"):
        check(f"{must} je v seznamu k přenosu", must in co.CARRY)

    print()
    if FAILS:
        print(f"\u2717 {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("\u2713 všechny testy carry_over prošly")


if __name__ == "__main__":
    main()
