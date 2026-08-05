"""
Dlouhá měsíční historie stanice — monthly_series() v chmi_stats.py.

Proč to má vlastní test: modul si kompletní měsíční soubory ČHMÚ stahoval
odjakživa, ale dělal z nich jen rekordy a 30leté normály a samotnou řadu
zahodil. Normál řekne, jaký je srpen průměrně; neřekne, že posledních deset
srpnů bylo nad ním. Právě ta řada je "vývoj hodnot".

Testuje se na tvaru, který opravdu chodí z opendata.chmi.cz (viz extract_rows):
řádky nesou kód prvku, charakteristiku (AVG/MAX/MIN/SUM) a datum buď jako
YYYY-MM, nebo rozsekané do sloupců.
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
    print("\n=== monthly_series ===")

    # (out_key, characteristic, dt, val) — tvar, který vrací extract_rows
    rows = [
        ("temp_avg", "AVG", "1961-08", 17.2),
        ("precip",   "SUM", "1961-08", 80.0),
        ("temp_avg", "AVG", "1962-08", 18.4),
        ("precip",   "SUM", "1962-08", 55.5),
        ("temp_avg", "AVG", "1961-01", -2.1),
        ("temp_max", "AVG", "1961-08", 23.9),
        ("temp_min", "AVG", "1961-08", 11.0),
        ("sunshine_h", "SUM", "1961-08", 210.0),
    ]
    s = cs.monthly_series(rows)
    check("řada vznikla", s is not None)
    check("měsíce jsou setříděné",
          s["months"] == ["1961-01", "1961-08", "1962-08"])
    check("průměrná teplota sedí na měsíce", s["t_avg"] == [-2.1, 17.2, 18.4])
    check("chybějící hodnota je None, ne posun řady", s["precip"] == [None, 80.0, 55.5])
    check("max i min se přenesly", s["t_max"] == [None, 23.9, None]
          and s["t_min"] == [None, 11.0, None])
    # Svit a sníh se do dlouhé řady schválně NEUKLÁDAJÍ — jejich extrémy jsou
    # v records a měsíční průměry v monthly_normals. Šest polí místo čtyř by
    # přes 292 stanic znamenalo jednotky megabajtů navíc na každý deploy za
    # data, která nic nekreslí.
    check("svit ani sníh v dlouhé řadě nejsou", "sun" not in s and "snow" not in s)

    # Prázdné pole se nezapisuje — jinak by soubor nesl sloupce samých null.
    s2 = cs.monthly_series([("temp_avg", "AVG", "2000-05", 14.0)])
    check("sloupec bez jediné hodnoty se vynechá",
          "t_max" not in s2 and "precip" not in s2)

    # Denní řádky aktuálního měsíce (YYYY-MM-DD) chodí ze stejného zdroje
    # a nesmí řadu rozsekat na dny.
    s3 = cs.monthly_series([
        ("temp_avg", "AVG", "2026-08", 19.0),
        ("temp_max", "MAX", "2026-08-03", 31.2),   # denní extrém
    ])
    check("denní řádek nezaloží vlastní měsíc", s3["months"] == ["2026-08"])

    # Strop délky: nejstarší české řady sahají do 19. století, ale pro otázku
    # "je tenhle měsíc nezvyklý?" nemá smysl tahat data, u kterých se měnila
    # metodika i umístění stanice.
    dlouha = [("temp_avg", "AVG", f"{y}-{m:02d}", 10.0)
              for y in range(1800, 2026) for m in range(1, 13)]
    s4 = cs.monthly_series(dlouha)
    check(f"řada je useknutá na {cs.MAX_MONTHS // 12} let ({len(s4['months'])} měsíců)",
          len(s4["months"]) == cs.MAX_MONTHS)
    check("useknutí bere KONEC řady, ne začátek", s4["months"][-1] == "2025-12")

    # Bez rozpoznatelného data nemá řada co ukázat.
    check("bez měsíčních dat vrátí None",
          cs.monthly_series([("temp_avg", "AVG", "??", 1.0)]) is None)
    check("prázdný vstup vrátí None", cs.monthly_series([]) is None)

    # Paralelní pole musí mít stejnou délku jako months — jinak by graf
    # posunul hodnoty k jiným rokům, což je horší než je neukázat vůbec.
    lens = {k: len(v) for k, v in s.items() if isinstance(v, list)}
    check(f"všechny sloupce mají délku months ({lens})",
          len(set(lens.values())) == 1)

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy chmi_history prošly")


if __name__ == "__main__":
    main()
