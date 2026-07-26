"""
Měřená kvalita ovzduší ze státní sítě imisního monitoringu → data/chmi_air.json.

Appka dnes ukazuje modelovanou kvalitu ovzduší z Open-Meteo CAMS. Tohle je
totéž, co u teploty udělaly stanice ČHMÚ proti modelu: skutečně naměřená
hodnota z nejbližší stanice místo interpolace.

Ověřeno sondami (běhy 30219708883 a 30220034606):

  air_quality/now/data/airquality_1h_avg_CZ.csv    18 kB, hodinově
    idRegistration, startTime, idValueType, value          472 řádků

  air_quality/now/metadata/metadata.json           1,5 MB, denně
    data.Localities[] → LocalityCode, Name,
                        Localization {LatAsNumber, LonAsNumber, Alt},
                        BasicInfo {Region, District},
                        MeasuringPrograms[] → Measurements[] →
                            IdRegistration, ComponentCode, ComponentName,
                            UnitAsASCII/UnitAsUNICODE, Interval, DateTo

Klíčová vazba, kvůli které to jde vůbec zpracovat: v hodinovém CSV není sloupec
s látkou. idRegistration je identifikátor MĚŘENÍ, tedy dvojice (stanice, látka),
a rozklíčovat ho jde jen přes Measurements[].IdRegistration. Sonda ověřila, že
470 ze 472 identifikátorů z CSV v registru skutečně je.

idValueType (podle metadata/ValueType.csv):
    5 vyřazeno pro nevěrohodnost      6 chybový kód operativních dat
    7 chybový kód verifikovaných dat  8 operativní data
    9 verifikovaná data              10, 11 substituce pod mezí detekce
  148 INDEX KVALITY OVZDUŠÍ — ne látka, ale hotový index ČHMÚ
Chybové kódy (5–7) se zahazují, 148 se ukládá zvlášť jako index.

Registr má 1,5 MB, ale stahuje se a parsuje v Actions; ven jde jen pár desítek
kB. Mapa se navíc cachuje, takže se stahuje jen když přibudou nová měření.

Výstup: data/chmi_air.json
"""

import csv
import io
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/air_quality/now"
DATA_CSV = f"{BASE}/data/airquality_1h_avg_CZ.csv"
META_JSON = f"{BASE}/metadata/metadata.json"
MAP_CACHE = DATA_DIR / "chmi_air_map.json"

TIMEOUT = (10, 60)
MAX_AGE_H = 4          # hodinová data se publikují se zpožděním ~50 min
MAP_MAX_AGE_H = 168    # registr se mění zřídka — stačí jednou týdně

VALUE_TYPES_OK = {8, 9, 10, 11}   # měřené hodnoty
VALUE_TYPE_INDEX = 148            # index kvality ovzduší ČHMÚ
VALUE_TYPES_BAD = {5, 6, 7}       # chybové kódy

# Látky, které dává smysl ukazovat. Ostatní se do výstupu nedostanou, ať
# JSON nebobtná o desítky uhlovodíků, které nikdo nečte.
COMPONENTS = {"SO2", "NO2", "NOx", "NO", "O3", "PM10", "PM2_5", "PM2.5", "CO", "C6H6"}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def build_map() -> dict:
    """
    {idRegistration: {code, name, unit, locality, lat, lon, elev, region}}

    Prochází se jen aktivní měření (DateTo je None) sledovaných látek.
    """
    r = SESSION.get(META_JSON, timeout=TIMEOUT)
    r.raise_for_status()
    meta = json.loads(r.content.decode("utf-8", "replace"))
    localities = ((meta.get("data") or {}).get("Localities")) or []

    out = {}
    for loc in localities:
        if not isinstance(loc, dict):
            continue
        pos = loc.get("Localization") or {}
        lat, lon = pos.get("LatAsNumber"), pos.get("LonAsNumber")
        if lat is None or lon is None:
            continue
        # "220 m" → 220
        elev = None
        alt = str(pos.get("Alt") or "").replace("m", "").strip()
        try:
            elev = float(alt)
        except ValueError:
            pass
        basic = loc.get("BasicInfo") or {}
        common = {
            "locality": (basic.get("LocalityName") or loc.get("Name") or "").strip(),
            "code": loc.get("LocalityCode"),
            "lat": round(float(lat), 5),
            "lon": round(float(lon), 5),
            "elev": elev,
            "region": (basic.get("Region") or "").strip() or None,
        }
        for prog in (loc.get("MeasuringPrograms") or []):
            for meas in ((prog or {}).get("Measurements") or []):
                if not isinstance(meas, dict):
                    continue
                if meas.get("DateTo"):
                    continue          # ukončené měření
                comp = (meas.get("ComponentCode") or "").strip()
                if comp not in COMPONENTS:
                    continue
                rid = meas.get("IdRegistration")
                if rid is None:
                    continue
                out[str(rid)] = {
                    **common,
                    "comp": comp,
                    "comp_name": (meas.get("ComponentName") or "").strip(),
                    "unit": (meas.get("UnitAsUNICODE")
                             or meas.get("UnitAsASCII") or "").strip(),
                }
    return out


def load_map() -> dict:
    """Registr z cache, jinak stažený znovu. Cache šetří 1,5 MB v každém běhu."""
    if MAP_CACHE.exists():
        try:
            cached = json.loads(MAP_CACHE.read_text())
            built = datetime.fromisoformat(cached["built_utc"])
            if datetime.now(timezone.utc) - built < timedelta(hours=MAP_MAX_AGE_H):
                return cached["map"]
        except Exception:
            pass
    m = build_map()
    if m:
        MAP_CACHE.write_text(json.dumps(
            {"built_utc": datetime.now(timezone.utc).isoformat(), "map": m},
            ensure_ascii=False, separators=(",", ":")))
    return m


def main():
    now = datetime.now(timezone.utc)

    try:
        reg = load_map()
    except Exception as e:
        print(f"chmi_air.py: registr stanic selhal ({e}) — vynechávám", file=sys.stderr)
        return
    if not reg:
        print("chmi_air.py: registr je prázdný — vynechávám", file=sys.stderr)
        return

    try:
        r = SESSION.get(DATA_CSV, timeout=TIMEOUT)
        r.raise_for_status()
        rows = list(csv.DictReader(
            io.StringIO(r.content.decode("utf-8", "replace")), skipinitialspace=True))
    except Exception as e:
        print(f"chmi_air.py: hodinová data selhala ({e}) — vynechávám", file=sys.stderr)
        return

    stations, indexes = {}, {}
    skipped_bad = skipped_unknown = 0
    newest = None

    for row in rows:
        rid = (row.get("idRegistration") or "").strip()
        try:
            vtype = int((row.get("idValueType") or "").strip())
            value = float((row.get("value") or "").strip())
        except ValueError:
            continue
        if vtype in VALUE_TYPES_BAD:
            skipped_bad += 1
            continue

        try:
            t = datetime.fromisoformat((row.get("startTime") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        age_h = (now - t).total_seconds() / 3600
        if age_h > MAX_AGE_H or age_h < -1:
            continue
        newest = t if newest is None or t > newest else newest

        info = reg.get(rid)
        if info is None:
            skipped_unknown += 1
            continue

        key = info["code"] or rid
        st = stations.setdefault(key, {
            "code": info["code"], "name": info["locality"],
            "lat": info["lat"], "lon": info["lon"], "elev": info["elev"],
            "region": info["region"], "time_utc": t.isoformat(), "v": {},
        })
        if vtype == VALUE_TYPE_INDEX:
            indexes[key] = round(value, 2)
        else:
            st["v"][info["comp"]] = {"val": round(value, 1), "unit": info["unit"]}

    # Index se přidá k té stanici, ke které patří; stanice bez jediné látky
    # ani indexu do výstupu nepatří.
    for key, idx in indexes.items():
        if key in stations:
            stations[key]["index"] = idx
    stations = {k: s for k, s in stations.items() if s["v"] or "index" in s}

    if not stations:
        print("chmi_air.py: žádná čerstvá měření — vynechávám", file=sys.stderr)
        return

    out = {
        "generated_at_utc": now.isoformat(),
        "observed_utc": newest.isoformat() if newest else None,
        "age_min": round((now - newest).total_seconds() / 60) if newest else None,
        "source": "ČHMÚ — státní síť imisního monitoringu (air_quality/now)",
        "count": len(stations),
        "components": sorted({c for s in stations.values() for c in s["v"]}),
        "stations": list(stations.values()),
    }
    path = DATA_DIR / "chmi_air.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_air.py: {len(stations)} stanic, {len(out['components'])} látek, "
          f"{len(indexes)} indexů, stáří {out['age_min']} min "
          f"(zahozeno {skipped_bad} chybových, {skipped_unknown} neznámých), "
          f"{path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
