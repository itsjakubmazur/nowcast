"""
Weather Underground PWS — aktuální data ze soukromých stanic.
Stahuje pozorování pro vlastní stanice (IBRNO445, IVENDR18) a okolní stanice.
Každý běh akumuluje historii do wu_history.json (načte z Pages, přidá, uloží).
Výstup: data/wu_stations.json, data/wu_history.json
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR

API_KEY  = os.environ.get("WU_API_KEY", "")
BASE_URL = "https://api.weather.com"
TIMEOUT  = (5, 20)
HEADERS  = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}

PAGES_BASE    = "https://itsjakubmazur.github.io/nowcast"
HISTORY_HOURS = 48

# Vlastní stanice
OWN_STATIONS = ["IBRNO445", "IVENDR18"]


def fetch_obs(station_ids: list[str]) -> list[dict]:
    """Stáhne aktuální pozorování pro seznam stanic (každou zvlášť)."""
    if not API_KEY:
        print("  WU_API_KEY není nastaven — přeskakuji", file=sys.stderr)
        return []

    results = []
    for sid in station_ids:
        url = (f"{BASE_URL}/v2/pws/observations/current"
               f"?stationId={sid}&format=json&units=m&apiKey={API_KEY}&numericPrecision=decimal")
        try:
            r = requests.get(url, timeout=TIMEOUT)
            if not r.ok:
                print(f"  WU fetch HTTP {r.status_code} ({sid}): {r.text[:200]}", file=sys.stderr)
                continue
            if not r.text.strip():
                print(f"  WU fetch prázdná odpověď ({sid})", file=sys.stderr)
                continue
            results.extend(r.json().get("observations", []))
        except Exception as e:
            print(f"  WU fetch chyba ({sid}): {e}", file=sys.stderr)
    return results


def _ids_from_v2(lat, lon, limit):
    """Starší /v2/pws/nearby — na běžném (free) klíči vrací 401."""
    url = (f"{BASE_URL}/v2/pws/nearby?geocode={lat:.4f},{lon:.4f}&limit={limit}"
           f"&format=json&units=m&apiKey={API_KEY}")
    r = requests.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json().get("location", {}).get("stationIdentifier", []) or []


def _ids_from_v3(lat, lon, limit):
    """Novější Location Services — jiný produkt, jiná oprávnění; často projde
    i tam, kde v2/pws/nearby vrací 401."""
    url = (f"{BASE_URL}/v3/location/near?geocode={lat:.4f},{lon:.4f}"
           f"&product=pws&format=json&apiKey={API_KEY}")
    r = requests.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    loc = r.json().get("location", {}) or {}
    ids = loc.get("stationId") or loc.get("stationIdentifier") or []
    return list(ids)[:limit]


def fetch_nearby(lat: float, lon: float, limit: int = 20) -> list[dict]:
    """Stáhne okolní stanice a jejich aktuální pozorování.

    POZOR na interpretaci chyby: 401 z /v2/pws/nearby NEznamená neplatný klíč —
    čtení pozorování (/v2/pws/observations) běžným klíčem funguje, jen
    vyhledávání okolních stanic je jinak licencované. Proto fallback na v3 a
    hláška, která nesvádí k závěru "klíč je rozbitý".
    """
    if not API_KEY:
        return []

    nearby, errs = [], []
    for name, fn in (("v2/pws/nearby", _ids_from_v2), ("v3/location/near", _ids_from_v3)):
        try:
            nearby = fn(lat, lon, limit)
            if nearby:
                print(f"  Okolní stanice přes {name}: {len(nearby)}", file=sys.stderr)
                break
        except Exception as e:
            errs.append(f"{name}: {e}")
    if not nearby:
        for e in errs:
            print(f"  WU hledání okolních stanic — {e}", file=sys.stderr)
        print("  (vlastní stanice se stahují dál; okolní WU síť tímhle klíčem "
              "nejde procházet — nahrazuje ji METAR + ČHMÚ)", file=sys.stderr)
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
        "solar_radiation": o.get("solarRadiation"),
        "uv":          o.get("uv"),
        "elev":        m.get("elev"),
    }


def _hist_size(doc) -> int:
    return sum(len(s.get("series", [])) for s in (doc or {}).get("stations", {}).values())


def load_wu_history() -> dict:
    """
    Historie se bere z toho zdroje, který jí má VÍC — ne z toho, který
    odpoví první.

    Dřív se brala z Pages a lokální kopie se použila jen tehdy, když Pages
    vůbec neodpověděly. To mělo dva důsledky a oba mazaly data:

      1. Když wu_history.json na Pages chyběl (fast běh ho nevyrobil a nebyl
         v carry seznamu), fetch skončil 404 → historie začala od nuly
         a předchozí měsíce se přepsaly prázdnem. Tohle je důvod, proč
         historie vlastních stanic nikdy nenarostla.
      2. Když cache obnovila plnou lokální kopii, ale na Pages ležela
         zkrácená, vyhrála ta zkrácená.

    Porovnání počtu záznamů obojí řeší: ať se stane cokoli, bere se ta větší.
    Sloučit je nejde spolehlivě (obě strany mají stejné klíče s jinou délkou
    řady), a větší z nich je vždycky nadmnožina té menší — obě rostou ze
    stejného zdroje.
    """
    local_doc = None
    local = DATA_DIR / "wu_history.json"
    if local.exists():
        try:
            local_doc = json.loads(local.read_text())
        except Exception:
            local_doc = None

    pages_doc = None
    try:
        r = requests.get(f"{PAGES_BASE}/data/wu_history.json",
                         headers=HEADERS, timeout=10)
        if r.ok:
            pages_doc = r.json()
    except Exception as e:
        print(f"  WU Pages historie nedostupná: {e}", file=sys.stderr)

    n_local, n_pages = _hist_size(local_doc), _hist_size(pages_doc)
    print(f"  WU historie: lokálně {n_local}, na Pages {n_pages} záznamů",
          file=sys.stderr)
    if n_pages == 0 and n_local == 0 and (pages_doc or local_doc) is None:
        print("  WU historie: ZAČÍNÁM OD NULY — ani jeden zdroj nemá data",
              file=sys.stderr)
    best = local_doc if n_local >= n_pages else pages_doc
    return best if best and best.get("stations") is not None else {"stations": {}}


def append_wu_history(history: dict, stations: list, cutoff_dt: str) -> dict:
    for obs in stations:
        sid = obs["id"]
        if not obs.get("time_utc"):
            continue
        if sid not in history["stations"]:
            history["stations"][sid] = {
                "name":   obs["name"],
                "own":    obs.get("own", False),
                "lat":    obs["lat"],
                "lon":    obs["lon"],
                "series": [],
            }
        entry = {"dt": obs["time_utc"]}
        for key in ("temp", "humidity", "pressure", "wind_kmh", "gust_kmh",
                    "wind_dir", "precip_rate", "precip_total", "solar_radiation", "uv"):
            if obs.get(key) is not None:
                entry[key] = obs[key]
        series = history["stations"][sid]["series"]
        if not series or series[-1].get("dt") != entry["dt"]:
            series.append(entry)
        history["stations"][sid]["series"] = [
            e for e in series if e.get("dt", "") >= cutoff_dt
        ]
    return history


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

    now_utc   = datetime.now(timezone.utc)
    cutoff_dt = (now_utc - timedelta(hours=HISTORY_HOURS)).isoformat(timespec="minutes")

    out = {
        "generated_at_utc": now_utc.isoformat(),
        "stations": stations,
    }
    path = DATA_DIR / "wu_stations.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"✓ WU OK — {len(stations)} stanic → {path}")

    # Historie
    history = load_wu_history()
    history = append_wu_history(history, stations, cutoff_dt)
    history["updated_at_utc"] = now_utc.isoformat()
    total = sum(len(s.get("series", [])) for s in history["stations"].values())
    hist_path = DATA_DIR / "wu_history.json"
    hist_path.write_text(json.dumps(history, ensure_ascii=False))
    print(f"  ✓ wu_history.json — {total} záznamů", file=sys.stderr)


if __name__ == "__main__":
    main()
