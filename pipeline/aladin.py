"""
ALADIN/ČHMÚ — numerická předpověď z opendata.chmi.cz (GRIB1, 1 km, 72 h).
Zdroj: https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/

Struktura (zjištěno sondou):
  CZ_1km/{00,06,12,18}/   — podadresáře podle hodiny běhu modelu (UTC)
  ALADCZ1K4opendata_{YYYYMMDDHH}_{VAR}.grb.bz2 — bz2 GRIB, jeden na proměnnou,
  uvnitř všechny časové kroky. VAR mj.: CLSTEMPERATURE (2m T),
  SURFPREC_TOTAL (srážky), CLSRAFAL_MOD_XFU (nárazy), SURFCAPE_POS_F00 (CAPE).

FÁZE 2 = SONDA GRIB: stáhni nejnovější běh CLSTEMPERATURE, rozbal, vypiš tvar
GRIB zpráv (kroky, geometrie mřížky, hodnota v Praze) — podle toho pak parser.
"""

import bz2
import re
import sys
from datetime import datetime, timezone

import requests

BASE = "https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/"
RUN_HOURS = ["18", "12", "06", "00"]
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})

PRAHA = (50.088, 14.42)


def list_dir(url: str) -> list[str]:
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+)"', r.text)
    return [h for h in hrefs if h not in ("../", "/") and not h.startswith("?")]


def latest_file(var: str) -> tuple[str, str] | None:
    """Najde nejnovější běh dané proměnné napříč hodinovými podadresáři.
    Vrací (url, run_iso) nebo None."""
    best = None  # (run_ts_int, url, run_iso)
    for hh in RUN_HOURS:
        try:
            files = list_dir(BASE + hh + "/")
        except Exception as e:
            print(f"  {hh}/ výpis selhal: {e}")
            continue
        for f in files:
            m = re.match(rf"ALADCZ1K4opendata_(\d{{10}})_{var}\.grb\.bz2$", f)
            if not m:
                continue
            ts = int(m.group(1))  # YYYYMMDDHH
            if best is None or ts > best[0]:
                iso = datetime.strptime(m.group(1), "%Y%m%d%H").replace(tzinfo=timezone.utc).isoformat()
                best = (ts, BASE + hh + "/" + f, iso)
    return (best[1], best[2]) if best else None


def probe():
    print("=== ALADIN sonda GRIB ===")
    found = latest_file("CLSTEMPERATURE")
    if not found:
        print("  CLSTEMPERATURE nenalezena")
        return
    url, run_iso = found
    print(f"  Nejnovější běh: {run_iso}\n  {url}")

    try:
        raw = SESSION.get(url, timeout=120).content
        grib = bz2.decompress(raw)
        print(f"  staženo {len(raw)//1024} kB, rozbaleno {len(grib)//1024} kB")
    except Exception as e:
        print(f"  stažení/rozbalení selhalo: {e}")
        return

    tmp = "/tmp/aladin_t.grib"
    open(tmp, "wb").write(grib)

    try:
        import eccodes as ec
    except Exception as e:
        print(f"  eccodes import selhal: {e}")
        return

    # geometrie z první zprávy + kroky/hodnoty všech zpráv
    with open(tmp, "rb") as f:
        n = 0
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            n += 1
            def g(k):
                try: return ec.codes_get(gid, k)
                except Exception: return "?"
            if n == 1:
                print(f"  geometrie: gridType={g('gridType')} Ni={g('Ni')} Nj={g('Nj')} "
                      f"latFirst={g('latitudeOfFirstGridPointInDegrees')} "
                      f"lonFirst={g('longitudeOfFirstGridPointInDegrees')} "
                      f"latLast={g('latitudeOfLastGridPointInDegrees')} "
                      f"lonLast={g('longitudeOfLastGridPointInDegrees')} "
                      f"iInc={g('iDirectionIncrementInDegrees')} jInc={g('jDirectionIncrementInDegrees')} "
                      f"shortName={g('shortName')} units={g('units')} "
                      f"scanNeg-i={g('iScansNegatively')} scanPos-j={g('jScansPositively')}")
                # hodnota v Praze přes nearest
                try:
                    nr = ec.codes_grib_find_nearest(gid, PRAHA[0], PRAHA[1])[0]
                    print(f"  Praha nearest: lat={nr.lat:.3f} lon={nr.lon:.3f} value={nr.value:.2f} (K?)")
                except Exception as e:
                    print(f"  find_nearest selhal: {e}")
            if n <= 8:
                print(f"    [msg {n}] step={g('stepRange')} startStep={g('startStep')} endStep={g('endStep')} "
                      f"validityDate={g('validityDate')} validityTime={g('validityTime')} "
                      f"dataDate={g('dataDate')} dataTime={g('dataTime')}")
            ec.codes_release(gid)
        print(f"  zpráv (časových kroků) celkem: {n}")


if __name__ == "__main__":
    probe()
    sys.exit(0)
