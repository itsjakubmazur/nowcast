"""
Weather Underground PWS — aktuální data ze soukromých stanic.
Stahuje pozorování pro vlastní stanice (IBRNO445, IVENDR18) a okolní stanice.
Výstup: data/wu_stations.json
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR

API_KEY  = os.environ.get("WU_API_KEY", "")
BASE_URL = "https://api.weather.com"
TIMEOUT  = (5, 20)

# Vlastní stanice
OWN_STATIONS = ["IBRNO445", "IVENDR18"]


def fetch_obs(station_ids: list[str]) -> list[dict]:
    """Stáhne aktuální pozorování pro seznam stanic."""
    if not API_KEY:
        print("  WU_API_KEY není nastaven — přeskakuji", file=sys.stderr)
        return []

    ids_str = ",".join(station_ids)
    url = (f"{BASE_URL}/v2/pws/observations/current"
           f"?stationId={ids_str}&format=json&units=m&apiKey={API_KEY}&numericPrecision=decimal")
    try:
        r = requests.get(url, timeout=TIMEOUT, allow_redirects=True)
        print(f"  WU HTTP {r.status_code} url={r.url[:80]} len={len(r.text)} history={[x.status_code for x in r.history]}", file=sys.stderr)
        if not r.ok:
            print(f"  WU fetch HTTP {r.status_code} ({ids_str}): {r.text[:200]}", file=sys.stderr)
            return []
        if not r.text.strip():
            print(f"  WU fetch prázdná odpověď ({ids_str})", file=sys.stderr)
            return []
        return r.json().get("observations", [])
    except Exception as e:
        print(f"  WU fetch chyba ({ids_str}): {e}", file=sys.stderr)
        return []


def fetch_nearby(lat: float, lon: float, limit: int = 20) -> list[dict]:
    """Stáhne okolní stanice a jejich aktuální pozorování."""
    if not API_KEY:
        return []

    # Krok 1: najdi okolní stanice
    nearby_url = (f"{BASE_URL}/v2/pws/nearby"
                  f"?geocode={lat:.4f},{lon:.4f}&limit={limit}"
                  f"&format=json&units=m&apiKey={API_KEY}")
    try:
        r = requests.get(nearby_url, timeout=TIMEOUT)
        r.raise_for_status()
        nearby = r.json().get("location", {}).get("stationIdentifier", [])
        if not nearby:
            return []
    except Exception as e:
        print(f"  WU nearby chyba: {e}", file=sys.stderr)
        return []

    # Krok 2: aktuální data pro okolní stanice (po 10)
    obs = []
    for i in range(0, len(nearby), 10):
        batch = nearby[i:i + 10]
        obs.extend(fetch_obs(batch))
    return obs


def parse_obs(o: dict, own: bool = False) -> dict | None:
    """Přeloží WU observation do kompaktního záznamu pro frontend."""
    m = o.get("metric", {})
    lat = o.get("lat")
    lon = o.get("lon")
    if lat is None or lon is None:
        return None
    return {
        "id":        o.get("stationID", ""),
        "name":      o.get("neighborhood", o.get("stationID", "")),
        "own":       own,
        "lat":       round(float(lat), 5),
        "lon":       round(float(lon), 5),
        "time_utc":  o.get("obsTimeUtc", ""),
        "temp":      m.get("temp"),
        "feels":     m.get("heatIndex") or m.get("windChill"),
        "humidity":  o.get("humidity"),
        "wind_kmh":  m.get("windSpeed"),
        "gust_kmh":  m.get("windGust"),
        "wind_dir":  o.get("winddir"),
        "pressure":  m.get("pressure"),
        "precip_rate":  m.get("precipRate"),
        "precip_total": m.get("precipTotal"),
        "elev":      m.get("elev"),
    }


def main():
    print("\n=== WU PWS — stahování dat ze soukromých stanic ===")

    if not API_KEY:
        print("  WU_API_KEY není nastaven — ukládám prázdný soubor")
        out = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "stations": [],
            "error": "WU_API_KEY není nastaven",
        }
        path = DATA_DIR / "wu_stations.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        return

    # Vlastní stanice
    print(f"  Stahuji vlastní stanice: {', '.join(OWN_STATIONS)}")
    own_obs = fetch_obs(OWN_STATIONS)
    stations = []
    own_lat, own_lon = None, None

    for o in own_obs:
        parsed = parse_obs(o, own=True)
        if parsed:
            stations.append(parsed)
            if own_lat is None:
                own_lat = parsed["lat"]
                own_lon = parsed["lon"]
            print(f"  ✓ {parsed['id']:12s}  {parsed['temp']}°C  "
                  f"hum {parsed['humidity']}%  vítr {parsed['wind_kmh']} km/h")

    # Okolní stanice (okolo první vlastní)
    if own_lat is not None:
        print(f"  Hledám okolní stanice okolo {own_lat:.3f}, {own_lon:.3f}")
        nearby_obs = fetch_nearby(own_lat, own_lon, limit=25)
        # Vyřaď vlastní stanice z výsledků
        own_ids = set(OWN_STATIONS)
        count = 0
        for o in nearby_obs:
            if o.get("stationID") in own_ids:
                continue
            parsed = parse_obs(o, own=False)
            if parsed:
                stations.append(parsed)
                count += 1
        print(f"  Okolní stanice: {count}")

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "stations": stations,
    }
    path = DATA_DIR / "wu_stations.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"✓ WU OK — {len(stations)} stanic → {path}")


if __name__ == "__main__":
    main()
