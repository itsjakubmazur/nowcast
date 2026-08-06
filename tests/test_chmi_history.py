"""
Kompletní historie stanice — build_series() v chmi_stats.py.

Modul si měsíční soubory ČHMÚ za celé období měření stahoval odjakživa, ale
dělal z nich jen rekordy a 30leté normály; samotnou řadu zahodil. První pokus
o nápravu ji ukládal ořezanou nadvakrát — jen čtyři veličiny a jen posledních
80 let. Teď se ukládá VŠECHNO, co ČHMÚ pro stanici nabízí: každá dvojice
(prvek, charakteristika) za celou dobu měření, měsíčně i ročně.

Testuje se na tvaru, který opravdu chodí z opendata.chmi.cz (viz extract_rows):
čtveřice (klíč prvku, charakteristika, datum, hodnota).
"""

import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

import chmi_stats as cs   # noqa: E402

FAILS = []


def check(label, cond):
    print(f"  {'✓' if cond else '✗'} {label}")
    if not cond:
        FAILS.append(label)


def main():
    print("\n=== build_series — měsíční osa ===")

    rows = [
        ("temp_avg", "AVG", "1961-08", 17.2),
        ("temp_max", "AVG", "1961-08", 23.9),
        ("temp_max", "MAX", "1961-08", 31.5),     # jiná veličina než AVG!
        ("temp_min", "MIN", "1961-08", 8.0),
        ("precip",   "SUM", "1961-08", 80.0),
        ("sunshine_h", "SUM", "1961-08", 210.0),
        ("snow_cm",  "MAX", "1961-01", 42.0),
        ("gust_kmh", "MAX", "1961-08", 90.0),
        ("temp_avg", "AVG", "1962-08", 18.4),
        ("temp_avg", "AVG", "1961-01", -2.1),
    ]
    s = cs.build_series(rows, "month")
    check("řada vznikla", s is not None)
    check("osa období je setříděná",
          s["periods"] == ["1961-01", "1961-08", "1962-08"])

    # Tohle je jádro věci: dřív se ukládaly čtyři vybrané veličiny, teď
    # všechno, co v datech je — včetně rozlišení TMA/AVG proti TMA/MAX.
    check("průměrné denní maximum a absolutní maximum jsou DVĚ různé řady",
          "temp_max_AVG" in s["series"] and "temp_max_MAX" in s["series"]
          and s["series"]["temp_max_AVG"]["v"] != s["series"]["temp_max_MAX"]["v"])
    check("uloží se i svit, sníh a nárazy větru",
          {"sunshine_h_SUM", "snow_cm_MAX", "gust_kmh_MAX"} <= set(s["series"]))
    check(f"veličin je {len(s['series'])}, ne čtyři", len(s["series"]) >= 8)

    check("hodnoty sedí na období",
          s["series"]["temp_avg_AVG"]["v"] == [-2.1, 17.2, 18.4])
    check("chybějící hodnota je None, ne posun řady",
          s["series"]["precip_SUM"]["v"] == [None, 80.0, None])

    check("každá řada má lidský popisek",
          s["series"]["temp_avg_AVG"]["label"] == "Průměrná teplota")
    check("každá řada má jednotku",
          s["series"]["precip_SUM"]["unit"] == "mm"
          and s["series"]["temp_avg_AVG"]["unit"] == "°C"
          and s["series"]["gust_kmh_MAX"]["unit"] == "km/h")

    # Invariant, na kterém všechno stojí: kdyby se délky rozešly, graf by
    # přiřadil hodnoty k jiným rokům — což je horší než je neukázat.
    lens = {k: len(v["v"]) for k, v in s["series"].items()}
    check(f"všechny řady mají délku osy ({len(set(lens.values()))} různých délek)",
          set(lens.values()) == {len(s["periods"])})

    print("\n=== žádné ořezávání ===")
    # Nejstarší české řady sahají do 19. století. Dřív se usekávaly na 80 let.
    dlouha = [("temp_avg", "AVG", f"{y}-{m:02d}", 10.0)
              for y in range(1775, 2026) for m in range(1, 13)]
    s2 = cs.build_series(dlouha, "month")
    check(f"řada od roku 1775 zůstává celá ({len(s2['periods'])} měsíců)",
          len(s2["periods"]) == 251 * 12)
    check("začátek řady se nezahazuje", s2["periods"][0] == "1775-01")
    check("nikde nezůstal strop délky", not hasattr(cs, "MAX_MONTHS"))

    print("\n=== agregace jemnějších záznamů ===")
    # Denní řádky aktuálního měsíce chodí ze stejného zdroje a nesmí založit
    # vlastní období v měsíční ose.
    s3 = cs.build_series([
        ("temp_avg", "AVG", "2026-08", 19.0),
        ("temp_max", "MAX", "2026-08-03", 31.2),
        ("temp_max", "MAX", "2026-08-11", 34.7),   # vyšší — musí vyhrát
        ("temp_min", "MIN", "2026-08-04", 12.0),
        ("temp_min", "MIN", "2026-08-19", 9.5),    # nižší — musí vyhrát
        ("precip",   "SUM", "2026-08-05", 10.0),
        ("precip",   "SUM", "2026-08-06", 5.5),    # úhrny se sčítají
    ], "month")
    check("denní řádek nezaloží vlastní měsíc", s3["periods"] == ["2026-08"])
    check("u MAX vyhraje nejvyšší denní hodnota",
          s3["series"]["temp_max_MAX"]["v"] == [34.7])
    check("u MIN vyhraje nejnižší denní hodnota",
          s3["series"]["temp_min_MIN"]["v"] == [9.5])
    check("u SUM se denní úhrny sečtou",
          s3["series"]["precip_SUM"]["v"] == [15.5])

    print("\n=== roční osa ===")
    y = cs.build_series([
        ("temp_avg", "AVG", "1961-08", 17.2),
        ("temp_avg", "AVG", "1961-01", -2.1),
        ("precip",   "SUM", "1961-08", 80.0),
        ("precip",   "SUM", "1961-01", 40.0),
        ("temp_avg", "AVG", "1962", 9.1),
    ], "year")
    check("roční osa jsou roky", y["periods"] == ["1961", "1962"])
    check("roční úhrn se sečte z měsíců",
          y["series"]["precip_SUM"]["v"] == [120.0, None])

    print("\n=== okrajové případy ===")
    check("bez rozpoznatelného data vrátí None",
          cs.build_series([("temp_avg", "AVG", "??", 1.0)], "month") is None)
    check("prázdný vstup vrátí None", cs.build_series([], "month") is None)
    check("monthly_series zůstal jako obal",
          cs.monthly_series(rows)["periods"] == s["periods"])

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy chmi_history prošly")


if __name__ == "__main__":
    main()
