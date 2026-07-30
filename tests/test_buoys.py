"""
Testy pro pipeline/buoys.py — parsování NDBC.

Proč zrovna tyhle: formát je pevně sloupcovaný text bez oddělovačů, což je
přesně ten druh vstupu, kde se chyba projeví tiše a špatným číslem místo
výjimkou. Testy proto hlídají tři pasti:

  1. sloupce se musí hledat podle hlavičky, ne podle pozice — NDBC už jednou
     pořadí měnilo,
  2. "MM" znamená chybějící hodnotu, ne nulu a ne měsíc,
  3. stará hlášení se musí zahodit, jinak by mapa ukazovala včerejší teplotu
     jako aktuální.

Spouštění: python tests/test_buoys.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import buoys  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


HEADER = ("#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD "
          "APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE")
UNITS = ("#text      deg      deg   yr  mo dy hr mn degT  m/s   m/s    m  sec "
         "sec degT    hPa   hPa  degC  degC  degC  nmi     ft")


def row(stn, lat, lon, dt, wdir="180", wspd="5.0", pres="1013.0",
        atmp="21.5", wtmp="19.0", dewp="15.0"):
    return (f"{stn} {lat} {lon} {dt.year} {dt.month:02d} {dt.day:02d} "
            f"{dt.hour:02d} {dt.minute:02d} {wdir} {wspd} MM MM MM MM MM "
            f"{pres} MM {atmp} {wtmp} {dewp} MM MM")


def main():
    now = datetime(2026, 7, 30, 18, 0, tzinfo=timezone.utc)
    fresh = now - timedelta(minutes=30)
    old = now - timedelta(hours=9)
    print("=== buoys — parsování NDBC ===")

    text = "\n".join([
        HEADER, UNITS,
        row("41001", "34.700", "-72.200", fresh),
        row("STARA", "10.000", "20.000", old),
        row("BEZT", "1.000", "2.000", fresh, atmp="MM"),
        row("BEZPOL", "MM", "MM", fresh),
    ])
    recs = buoys.parse(text, now)
    ids = {r["id"] for r in recs}
    check("čerstvá bóje s teplotou projde", "ndbc-41001" in ids, str(ids))
    check("stará bóje se zahodí", "ndbc-STARA" not in ids, str(ids))
    check("bóje bez teploty se zahodí", "ndbc-BEZT" not in ids, str(ids))
    check("bóje bez polohy se zahodí", "ndbc-BEZPOL" not in ids, str(ids))

    r = next(x for x in recs if x["id"] == "ndbc-41001")
    check("teplota se přenese", r["temp"] == 21.5, str(r["temp"]))
    check("poloha se přenese", (r["lat"], r["lon"]) == (34.7, -72.2), str(r))
    check("čas je v UTC", r["time_utc"].startswith("2026-07-30T17:30"), r["time_utc"])
    check("rychlost větru se převede z m/s na km/h", r["wind_kmh"] == 18.0,
          str(r["wind_kmh"]))
    check("vlhkost se dopočítá z rosného bodu",
          r["humidity"] is not None and 60 <= r["humidity"] <= 75, str(r["humidity"]))
    check("nadmořská výška je 0 (bóje plave)", r["elev"] == 0, str(r["elev"]))
    check("source je ndbc — frontend podle něj bóje vynechá z reference",
          r["source"] == "ndbc", r["source"])
    check("jméno říká, že je to bóje", "bóje" in r["name"], r["name"])

    # --- "MM" nesmí propadnout jako číslo -----------------------------------
    text2 = "\n".join([HEADER, UNITS,
                       row("NOWIND", "50.0", "0.0", fresh, wspd="MM", pres="MM",
                           dewp="MM")])
    r2 = buoys.parse(text2, now)[0]
    check("chybějící vítr je None, ne nula", r2["wind_kmh"] is None, str(r2["wind_kmh"]))
    check("chybějící tlak je None", r2["pressure"] is None, str(r2["pressure"]))
    check("bez rosného bodu se vlhkost nepočítá", r2["humidity"] is None,
          str(r2["humidity"]))

    # --- změna pořadí sloupců se nesmí projevit špatnými čísly ---------------
    # ATMP a WTMP prohozené: kdyby se sloupce braly podle indexu, vrátilo by to
    # teplotu vody a nikdo by si toho nevšiml.
    swapped_hdr = HEADER.replace("ATMP  WTMP", "WTMP  ATMP")
    text3 = "\n".join([swapped_hdr, UNITS,
                       row("SWAP", "50.0", "0.0", fresh, atmp="9.9", wtmp="30.0")])
    r3 = buoys.parse(text3, now)[0]
    check("sloupce se berou podle hlavičky, ne podle pozice",
          r3["temp"] == 30.0, f"{r3['temp']} (očekáváno 30.0 z prohozené hlavičky)")

    # --- rozbitý vstup nesmí shodit pipeline --------------------------------
    check("prázdný vstup vrátí prázdno", buoys.parse("", now) == [])
    check("vstup bez hlavičky vrátí prázdno",
          buoys.parse("nesmysl\nnesmysl\n", now) == [])
    check("hlavička bez ATMP vrátí prázdno",
          buoys.parse("#STN LAT LON YYYY MM DD hh mm\n#x x x x x x x x\n"
                      "A 1 2 2026 07 30 17 30\n", now) == [])

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy buoys prošly")


if __name__ == "__main__":
    main()
