"""
METAR — letištní meteostanice jako doplněk řídké sítě ČHMÚ.

Proč: ČHMÚ v now/ publikuje jen ~40 stanic na celou ČR (rozestup ~50 km) a
WU síť tímhle klíčem nejde procházet (vlastní stanice ANO, ale /pws/nearby
vrací 401), takže hodnocení modelů i kontrola biasu se pro většinu míst
nikdy nerozjely.
Letiště hlásí METAR každých 30 min, zdarma, bez klíče (NOAA Aviation Weather),
a v ČR + těsném pohraničí jich je několik desítek — síť se tím zahustí.

Zdroj: https://aviationweather.gov/api/data/metar?bbox=...&format=json
Výstup: data/metar_stations.json ve STEJNÉM tvaru jako chmi_stations.json
(name/lat/lon/elev/temp/humidity/wind_kmh/time_utc), takže frontend je jen
přisype k ostatním stanicím.
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR

API = "https://aviationweather.gov/api/data/metar"
# ČR + pásmo pohraničí (DE/PL/AT/SK letiště pomůžou u hranic)
BBOX = "48.3,11.8,51.3,19.2"          # lat0,lon0,lat1,lon1
MAX_AGE_MIN = 150                      # starší hlášení nemá pro "teď" cenu
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def _num(v):
    """METAR pole chodí jako číslo, string i None — vrať float nebo None."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def rh_from_dewpoint(t_c, td_c):
    """Relativní vlhkost z teploty a rosného bodu (Magnus)."""
    if t_c is None or td_c is None:
        return None
    a, b = 17.625, 243.04
    try:
        rh = 100 * math.exp(a * td_c / (b + td_c)) / math.exp(a * t_c / (b + t_c))
        return round(max(0.0, min(100.0, rh)))
    except (ValueError, OverflowError, ZeroDivisionError):
        return None


def parse_time(m) -> str | None:
    """reportTime bývá 'YYYY-MM-DD HH:MM:SS' (UTC), obsTime unix epoch."""
    rt = m.get("reportTime")
    if isinstance(rt, str) and len(rt) >= 16:
        try:
            return datetime.strptime(rt[:19], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    ot = m.get("obsTime")
    if isinstance(ot, (int, float)) and ot > 0:
        return datetime.fromtimestamp(ot, timezone.utc).isoformat()
    return None


def main():
    now = datetime.now(timezone.utc)
    print("=== METAR (letištní stanice, NOAA) ===", file=sys.stderr)
    try:
        r = SESSION.get(API, params={"bbox": BBOX, "format": "json"}, timeout=(10, 45))
        r.raise_for_status()
        raw = r.json()
    except Exception as e:
        print(f"  METAR fetch selhal: {e} — nechávám starý soubor", file=sys.stderr)
        return

    if not isinstance(raw, list):
        print(f"  Neočekávaný tvar odpovědi: {type(raw).__name__} — končím", file=sys.stderr)
        return
    print(f"  Hlášení v bboxu: {len(raw)}", file=sys.stderr)
    if raw:
        print(f"  [diag] klíče: {sorted(raw[0].keys())}", file=sys.stderr)

    stations, skipped = [], 0
    for m in raw:
        lat, lon = _num(m.get("lat")), _num(m.get("lon"))
        temp = _num(m.get("temp"))
        icao = m.get("icaoId") or m.get("station_id")
        t_iso = parse_time(m)
        if lat is None or lon is None or temp is None or not icao or not t_iso:
            skipped += 1
            continue
        age_min = (now - datetime.fromisoformat(t_iso)).total_seconds() / 60
        if age_min > MAX_AGE_MIN or age_min < -30:
            skipped += 1
            continue

        wspd_kt = _num(m.get("wspd"))          # uzly
        wdir = _num(m.get("wdir"))             # může být "VRB"
        name = (m.get("name") or icao).split(",")[0].strip()
        stations.append({
            "id": f"metar-{icao}",
            "name": f"{name} (letiště)",
            "lat": round(lat, 4), "lon": round(lon, 4),
            "elev": _num(m.get("elev")),
            "time_utc": t_iso,
            "temp": round(temp, 1),
            "humidity": rh_from_dewpoint(temp, _num(m.get("dewp"))),
            "wind_kmh": round(wspd_kt * 1.852, 1) if wspd_kt is not None else None,
            "wind_dir": round(wdir) if wdir is not None else None,
            "pressure": _num(m.get("altim")),
            "source": "metar",
            "own": False,
        })

    # jedno letiště může hlásit víckrát — nech nejnovější
    best = {}
    for s in stations:
        prev = best.get(s["id"])
        if prev is None or s["time_utc"] > prev["time_utc"]:
            best[s["id"]] = s
    stations = sorted(best.values(), key=lambda s: s["name"])

    out = {
        "generated_at_utc": now.isoformat(),
        "count": len(stations),
        "source": "NOAA Aviation Weather (METAR)",
        "stations": stations,
    }
    path = DATA_DIR / "metar_stations.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"  ✓ metar_stations.json — {len(stations)} stanic "
          f"(přeskočeno {skipped}), {path.stat().st_size // 1024} kB", file=sys.stderr)
    for s in stations[:25]:
        print(f"    {s['name'][:34]:36s} {s['lat']:.2f},{s['lon']:.2f}  "
              f"{s['temp']}°C  {s['time_utc'][11:16]}Z", file=sys.stderr)


if __name__ == "__main__":
    main()
