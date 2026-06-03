"""
ČHMÚ automatické stanice — stažení aktuálních pozorování.

Zkouší více URL patternů (opendata.chmi.cz), výstup: data/chmi_stations.json
Formát výstupu je kompatibilní s wu_stations.json (pole "stations").
"""

import json
import sys
import io
import csv
import requests
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = 15

# ── Kandidátní URL patterny ────────────────────────────────────────────────────
# ČHMÚ open data — hodinová pozorování (recent = posledních 24h, now = aktuální)
CANDIDATE_URLS = [
    # Nový portál opendata.chmi.cz
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/recent/data/",
    "https://opendata.chmi.cz/meteorology/climate/observation/10min/recent/data/",
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/now/data/",
    # Alternativní endpointy
    "https://opendata.chmi.cz/meteorology/synop/latest/",
    "https://opendata.chmi.cz/meteorology/synop/",
]

# Souhrnné soubory (celá ČR v jednom souboru)
COMBINED_CANDIDATES = [
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/recent/data/data.csv",
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/recent/data/all.csv",
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/recent/data/observations.csv",
    "https://opendata.chmi.cz/meteorology/climate/observation/1hour/recent/data/observations.json",
    "https://opendata.chmi.cz/meteorology/synop/latest/data.json",
    "https://opendata.chmi.cz/meteorology/synop/latest/data.csv",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0; +https://itsjakubmazur.github.io/nowcast/)",
    "Accept": "text/csv,application/json,text/plain,*/*",
}


def try_fetch(url: str) -> requests.Response | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        print(f"  {r.status_code} {url}", file=sys.stderr)
        if r.ok:
            return r
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def parse_csv_observations(text: str) -> list[dict]:
    """Pokusí se parsovat CSV s pozorováními. Vrátí seznam stanic."""
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return []

    print(f"  CSV sloupce: {list(rows[0].keys())}", file=sys.stderr)

    stations = []
    for row in rows:
        # Různé konvence pojmenování sloupců
        def g(*keys):
            for k in keys:
                v = row.get(k) or row.get(k.lower()) or row.get(k.upper())
                if v not in (None, "", "null", "NA", "-"):
                    try: return float(v)
                    except: return v
            return None

        station = {
            "id":       g("station_id", "StationId", "ID", "id", "WMO", "wmo_id"),
            "name":     g("station_name", "StationName", "NAME", "name", "Jméno"),
            "lat":      g("lat", "latitude", "LAT", "Lat"),
            "lon":      g("lon", "longitude", "LON", "Lon"),
            "time_utc": g("time", "datetime", "TIME", "Date", "valid_time"),
            "temp":     g("temp", "temperature", "T2M", "t2m", "TMP", "temp_2m"),
            "humidity": g("humidity", "rh", "RH", "relative_humidity"),
            "wind_kmh": g("wind_speed", "FF", "ff", "wspd"),
            "gust_kmh": g("wind_gust", "FX", "fx", "wgst"),
            "wind_dir": g("wind_dir", "DD", "dd", "wdir"),
            "pressure": g("pressure", "QFF", "qff", "mslp", "MSLP"),
            "precip_rate":  g("precip", "RR", "rr", "precipitation"),
            "precip_total": g("precip_sum", "RR_sum", "precip_total"),
        }

        # Přeskočit prázdné řádky
        if station["id"] is None and station["lat"] is None:
            continue

        # Převod wind m/s → km/h pokud hodnota vypadá jako m/s (< 30)
        for wk in ("wind_kmh", "gust_kmh"):
            v = station[wk]
            if isinstance(v, float) and 0 < v < 30:
                station[wk] = round(v * 3.6, 1)

        station["own"] = False
        stations.append(station)

    return stations


def parse_json_observations(data) -> list[dict]:
    """Pokusí se parsovat JSON s pozorováními."""
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        # Zkus různé klíče
        for k in ("features", "stations", "observations", "data", "items"):
            if k in data:
                items = data[k]
                break
        else:
            items = [data]
    else:
        return []

    stations = []
    for item in items:
        # GeoJSON feature
        if item.get("type") == "Feature":
            props = item.get("properties", {})
            geom  = item.get("geometry", {}).get("coordinates", [None, None])
            item  = {**props, "lon": geom[0], "lat": geom[1]}

        def g(*keys):
            for k in keys:
                v = item.get(k)
                if v not in (None, "", "null", "NA"):
                    try: return float(v)
                    except: return str(v)
            return None

        station = {
            "id":       g("station_id", "id", "ID", "wmo_id"),
            "name":     g("station_name", "name", "NAME"),
            "lat":      g("lat", "latitude"),
            "lon":      g("lon", "longitude"),
            "time_utc": g("time", "datetime", "valid_time"),
            "temp":     g("temp", "temperature", "t2m", "T2M"),
            "humidity": g("humidity", "rh", "RH"),
            "wind_kmh": g("wind_speed", "ff", "FF"),
            "gust_kmh": g("wind_gust", "fx", "FX"),
            "wind_dir": g("wind_dir", "dd", "DD"),
            "pressure": g("pressure", "qff", "QFF", "mslp"),
            "precip_rate":  g("precip", "rr", "RR"),
            "precip_total": g("precip_sum", "RR_sum"),
            "own": False,
        }
        if station["id"] is None and station["lat"] is None:
            continue
        stations.append(station)

    return stations


def main():
    print("\n=== ČHMÚ stanice — stažení pozorování ===")

    stations = []
    source_url = None

    # 1. Zkus souhrnné soubory (celá ČR v jednom)
    for url in COMBINED_CANDIDATES:
        r = try_fetch(url)
        if not r:
            continue
        ct = r.headers.get("content-type", "")
        text = r.text.strip()

        if not text:
            print(f"  Prázdná odpověď: {url}", file=sys.stderr)
            continue

        print(f"  Obsah ({len(text)} znaků, Content-Type: {ct}): {text[:200]}", file=sys.stderr)

        if "json" in ct or text.startswith("{") or text.startswith("["):
            try:
                parsed = json.loads(text)
                stations = parse_json_observations(parsed)
            except Exception as e:
                print(f"  JSON parse error: {e}", file=sys.stderr)
                continue
        else:
            stations = parse_csv_observations(text)

        if stations:
            source_url = url
            print(f"  ✓ Načteno {len(stations)} stanic z {url}", file=sys.stderr)
            break

    # 2. Zkus directory listing
    if not stations:
        for url in CANDIDATE_URLS:
            r = try_fetch(url)
            if r:
                print(f"  Directory listing ({len(r.text)} znaků):", file=sys.stderr)
                print(r.text[:500], file=sys.stderr)
                break

    if not stations:
        print("  ČHMÚ data nedostupná — ukládám prázdný soubor", file=sys.stderr)
        out = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": None,
            "stations": [],
            "error": "Nepodařilo se načíst data ze žádného ČHMÚ endpointu",
        }
    else:
        out = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": source_url,
            "count": len(stations),
            "stations": stations,
        }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "chmi_stations.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"  Uloženo: {path} ({len(stations)} stanic)", file=sys.stderr)


if __name__ == "__main__":
    main()
