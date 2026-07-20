"""
ALADIN/ČHMÚ — numerická předpověď z opendata.chmi.cz (GRIB1, 1 km, 72 h).
Zdroj: https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/

FÁZE 1 = SONDA: sandbox na opendata.chmi.cz nedosáhne (proxy 403), takže
skutečnou strukturu adresáře i GRIB polí zjišťujeme diagnostickým během v CI
(stejný postup jako u chmi_stats/hydro). Tenhle skript zatím jen VYPÍŠE, co
na serveru je, ať podle reálného tvaru napíšu parser. Výstup se čte z CI logu.
"""

import re
import sys
from pathlib import Path

import requests

BASE = "https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def list_dir(url: str) -> list[str]:
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    # Apache/nginx directory index — vytáhni všechny href, kromě "../"
    hrefs = re.findall(r'href="([^"]+)"', r.text)
    return [h for h in hrefs if h not in ("../", "/") and not h.startswith("?")]


def probe():
    print(f"=== ALADIN sonda ===\nBASE: {BASE}")
    try:
        top = list_dir(BASE)
    except Exception as e:
        print(f"  CHYBA výpisu adresáře: {e}")
        return
    print(f"  Položek v CZ_1km/: {len(top)}")
    for h in top[:60]:
        print(f"    {h}")

    # Najdi kandidáty na GRIB (přípony .grb/.grib/.grb1/.grib2 nebo bez přípony)
    gribs = [h for h in top if re.search(r"\.gri?b\d?$", h, re.I)]
    subdirs = [h for h in top if h.endswith("/")]

    # Když jsou tam podadresáře, mrkni do prvního a posledního
    if subdirs and not gribs:
        for sd in [subdirs[0], subdirs[-1]]:
            print(f"\n  → podadresář {sd}")
            try:
                inner = list_dir(BASE + sd)
                print(f"    položek: {len(inner)}")
                for h in inner[:40]:
                    print(f"      {h}")
                gsub = [h for h in inner if re.search(r"\.gri?b\d?$", h, re.I)]
                if gsub:
                    gribs = [sd + gsub[-1]]  # poslední soubor v podadresáři
                    break
            except Exception as e:
                print(f"    CHYBA: {e}")

    if not gribs:
        print("\n  Žádný GRIB nenalezen — struktura viz výše.")
        return

    target = gribs[-1]
    url = BASE + target
    print(f"\n=== Stahuju vzorek: {target} ===")
    try:
        r = SESSION.get(url, timeout=90)
        r.raise_for_status()
        raw = r.content
        print(f"  velikost: {len(raw)//1024} kB")
    except Exception as e:
        print(f"  CHYBA stažení: {e}")
        return

    tmp = Path("/tmp/aladin_probe.grib")
    tmp.write_bytes(raw)

    try:
        import eccodes as ec
    except Exception as e:
        print(f"  eccodes import selhal: {e}")
        return

    with open(tmp, "rb") as f:
        n = 0
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            n += 1
            if n <= 12:
                def g(k):
                    try:
                        return ec.codes_get(gid, k)
                    except Exception:
                        return "?"
                print(f"  [msg {n}] shortName={g('shortName')} name={g('name')!r} "
                      f"typeOfLevel={g('typeOfLevel')} level={g('level')} "
                      f"step={g('stepRange')} dataDate={g('dataDate')} dataTime={g('dataTime')} "
                      f"Ni={g('Ni')} Nj={g('Nj')} "
                      f"latFirst={g('latitudeOfFirstGridPointInDegrees')} "
                      f"lonFirst={g('longitudeOfFirstGridPointInDegrees')} "
                      f"latLast={g('latitudeOfLastGridPointInDegrees')} "
                      f"lonLast={g('longitudeOfLastGridPointInDegrees')} "
                      f"gridType={g('gridType')}")
            ec.codes_release(gid)
        print(f"  GRIB zpráv celkem: {n}")


if __name__ == "__main__":
    probe()
    sys.exit(0)
