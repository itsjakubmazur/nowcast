"""
Testy pro pipeline/carry_over.py — přenos souborů z posledního nasazení.

Proč: tenhle krok drží web kompletní i v běhu, který stanice nevyrábí.
Kdyby přenášel i zastaralá data, bylo by to horší než chybějící panel —
appka by tvářila včerejší měření jako aktuální. Testy hlídají právě tu mez.

Spouštění: python tests/test_carry_over.py
"""

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
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

    # ── Co je v cache Actions, musí být i v CARRY ──────────────────────────
    # Cache je přesně to, čemu tenhle modul nevěří (viz jeho docstring), takže
    # každý soubor, který se z ní obnovuje, musí mít i záložní cestu. Šest
    # souborů ji nemělo — mimo jiné wu_history.json, kvůli čemuž se historie
    # vlastních stanic při každém výpadku cache mazala a začínala od nuly.
    wf = (ROOT / ".github/workflows/nowcast.yml").read_text()
    m = re.search(r"Restore station data.*?path: \|\n(.*?)\n\s+key:", wf, re.S)
    check("krok Restore station data se v workflow našel", m is not None)
    if m:
        cached = [l.strip()[len("data/"):] for l in m.group(1).split("\n") if l.strip()]
        # Adresáře řeší carry_dir/carry_series, ne slovník CARRY.
        dirs = {"metar", "chmi_series", "chmi_history"}
        chybi = [c for c in cached if c not in dirs and c not in co.CARRY]
        check(f"každý cachovaný soubor má i carry ({', '.join(chybi) or 'ok'})",
              not chybi)

    # ── Rejstřík dlaždic je pole OBJEKTŮ, ne řetězců ───────────────────────
    # Na tomhle se carry_dir spálil: metar.py zapisuje {"tile": "9_18",
    # "count": 42}, ale smyčka to četla jako řetězce, takže URL vycházela ze
    # str(dict) a všech ~313 požadavků skončilo 404. V logu stálo "0/313"
    # a nikdo si toho nevšiml, protože cache to většinou zamaskovala.
    ids = [(t.get("tile") if isinstance(t, dict) else t)
           for t in [{"tile": "9_18", "count": 42}, {"tile": "5_3", "count": 7}]]
    check("z rejstříku se vytáhnou ID dlaždic, ne str(dict)",
          ids == ["9_18", "5_3"])
    src = (ROOT / "pipeline/carry_over.py").read_text()
    check("carry_dir počítá s objekty v rejstříku",
          't.get("tile") if isinstance(t, dict)' in src)
    check("carry_series přenáší i řady stanic (historie)",
          "def carry_series" in src and "chmi_series_index.json" in src)
    check("dlouhá měsíční historie se taky přenáší",
          'carry_dir("chmi_history"' in src)
    check("nulový přenos se hlásí do stderr, ne mlčky",
          "NEPŘENESLA SE ANI JEDNA" in src)

    print()
    if FAILS:
        print(f"\u2717 {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("\u2713 všechny testy carry_over prošly")


if __name__ == "__main__":
    main()
