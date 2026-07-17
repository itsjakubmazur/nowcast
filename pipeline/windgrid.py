"""
Fáze 4d — Větrné pole pro animované částice (leaflet-velocity)

Stáhne aktuální vítr (10 m) na pravidelné mřížce přes ČR a okolí z Open-Meteo
a uloží data/wind_grid.json ve formátu, který čte leaflet-velocity (GRIB-like
JSON: U komponenta + V komponenta, řádky od severu k jihu, západ→východ).

Jeden běh = ~2 requesty (batch po 100 lokacích), pár sekund. Běží při každém
průchodu pipeline — vítr se mění pomalu, ale ať je vrstva vždy čerstvá.
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

# záměrně bez importu ingest.py — ten tahá h5py, které tenhle skript nepotřebuje
DATA_DIR = Path(__file__).parent.parent / "data"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# Mřížka: musí být PRAVIDELNÁ v obou osách (leaflet-velocity interpoluje
# bilineárně z rovnoměrného gridu). Pokrývá ČR s přesahem, ať částice
# nekončí na hranici výřezu.
LON_MIN, LON_MAX, DLON = 11.5, 19.5, 0.5    # 17 sloupců
LAT_MAX, LAT_MIN, DLAT = 51.50, 48.25, 0.25 # 14 řádků, od severu k jihu
OM_BATCH = 100


def build_points():
    """Body v pořadí, v jakém je čte leaflet-velocity: řádky sever→jih, v řádku západ→východ."""
    pts = []
    ny = int(round((LAT_MAX - LAT_MIN) / DLAT)) + 1
    nx = int(round((LON_MAX - LON_MIN) / DLON)) + 1
    for iy in range(ny):
        lat = LAT_MAX - iy * DLAT
        for ix in range(nx):
            lon = LON_MIN + ix * DLON
            pts.append((round(lat, 4), round(lon, 4)))
    return pts, nx, ny


def fetch_wind(points):
    """Vrátí seznam (speed_kmh, dir_deg) ve stejném pořadí jako points; None při výpadku."""
    out = [None] * len(points)
    for start in range(0, len(points), OM_BATCH):
        chunk = points[start:start + OM_BATCH]
        params = {
            "latitude": ",".join(str(p[0]) for p in chunk),
            "longitude": ",".join(str(p[1]) for p in chunk),
            "current": "wind_speed_10m,wind_direction_10m",
            "timezone": "UTC",
        }
        try:
            r = requests.get(OPEN_METEO_URL, params=params, timeout=(5, 30))
            r.raise_for_status()
            data = r.json()
            items = data if isinstance(data, list) else [data]
            for i, item in enumerate(items):
                cur = item.get("current", {})
                spd, wdir = cur.get("wind_speed_10m"), cur.get("wind_direction_10m")
                if spd is not None and wdir is not None:
                    out[start + i] = (float(spd), float(wdir))
        except Exception as e:
            print(f"  wind batch {start // OM_BATCH}: chyba {e}", file=sys.stderr)
    return out


def main():
    points, nx, ny = build_points()
    print(f"=== Větrné pole ({nx}×{ny} bodů, {LON_MIN}–{LON_MAX}E / {LAT_MIN}–{LAT_MAX}N) ===")
    winds = fetch_wind(points)
    n_ok = sum(1 for w in winds if w)
    print(f"  Získáno {n_ok}/{len(points)} bodů")
    if n_ok < len(points) * 0.6:
        print("  Příliš málo dat — wind_grid.json nepřepisuji", file=sys.stderr)
        raise SystemExit(0)  # měkké selhání: stará vrstva zůstane

    u_data, v_data = [], []
    for w in winds:
        if not w:
            u_data.append(0.0)
            v_data.append(0.0)
            continue
        spd_ms = w[0] / 3.6
        theta = math.radians(w[1])  # meteorologický směr = ODKUD fouká
        u_data.append(round(-spd_ms * math.sin(theta), 2))
        v_data.append(round(-spd_ms * math.cos(theta), 2))

    ref_time = datetime.now(timezone.utc).isoformat()
    header_common = {
        "nx": nx, "ny": ny,
        "lo1": LON_MIN, "la1": LAT_MAX,   # levý horní roh (sever, západ)
        "lo2": LON_MAX, "la2": LAT_MIN,
        "dx": DLON, "dy": DLAT,
        "refTime": ref_time,
        "parameterCategory": 2,           # momentum
        "parameterUnit": "m.s-1",
    }
    out = [
        {"header": {**header_common, "parameterNumber": 2, "parameterNumberName": "eastward_wind"}, "data": u_data},
        {"header": {**header_common, "parameterNumber": 3, "parameterNumberName": "northward_wind"}, "data": v_data},
    ]
    path = DATA_DIR / "wind_grid.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"✓ Fáze 4d — wind_grid.json ({path.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    main()
