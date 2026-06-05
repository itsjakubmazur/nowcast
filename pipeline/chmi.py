"""
ČHMÚ stanice — aktuální pozorování + akumulovaná historie.

Zdroj dat:
  now/data/ — 40 synoptických stanic, 10min + 1h záznamy (spolehlivé, rychlé)

Každý běh:
  1. Stáhne aktuální snímek z now/data/ (< 100 HTTP požadavků)
  2. Načte historii z live Pages URL (nebo začne novou)
  3. Přidá aktuální měření, ořízne na 48h okno
  4. Uloží chmi_stations.json + chmi_history.json
"""

import json
import re
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR    = Path(__file__).parent.parent / "data"
TIMEOUT     = 20
MAX_WORKERS = 16

BASE     = "https://opendata.chmi.cz/meteorology/climate"
NOW_DATA = f"{BASE}/now/data/"
NOW_META = f"{BASE}/now/metadata/"

HISTORY_HOURS = 48   # kolik hodin zpátky uchovávat v historii
PAGES_BASE    = "https://itsjakubmazur.github.io/nowcast"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept":     "application/json,text/html,*/*",
}

ELEM_10M = {
    "T":      "temp",
    "H":      "humidity",
    "P":      "pressure",
    "F":      "wind_ms",
    "Fmax":   "gust_ms",
    "D":      "wind_dir",
    "SRA10M": "precip_10m",
    "SSV10M": "solar",
}

ELEM_1H = {
    "T":    "temp",
    "H":    "humidity",
    "P":    "pressure",
    "F":    "wind_ms",
    "Fmax": "gust_ms",
    "D":    "wind_dir",
    "RR":   "precip_1h",
    "SCE":  "snow_cm",
    "SD":   "snow_cm",
    "Vis":  "visibility_m",
    "Td":   "dewpoint",
    "SSV":  "solar",
}


# ── HTTP helpers ───────────────────────────────────────────────────────────────

def fetch(url: str) -> "requests.Response | None":
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r
        print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def fetch_json(url: str) -> dict | None:
    r = fetch(url)
    if not r:
        return None
    try:
        return r.json()
    except Exception as e:
        print(f"  JSON parse {url}: {e}", file=sys.stderr)
        return None


def fetch_all(urls: list[tuple[str, str]]) -> dict[str, dict]:
    results = {}

    def _get(key_url):
        key, url = key_url
        data = fetch_json(url)
        return key, data

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(_get, ku): ku for ku in urls}
        for future in as_completed(futures):
            key, data = future.result()
            if data is not None:
                results[key] = data
    return results


# ── Metadata ──────────────────────────────────────────────────────────────────

def load_metadata(today: str, yesterday: str) -> dict[str, dict]:
    sources = [
        (f"{NOW_META}meta1-{today}.json",    "now-today"),
        (f"{NOW_META}meta1-{yesterday}.json", "now-yesterday"),
    ]
    merged: dict[str, dict] = {}
    for url, label in sources:
        r = fetch(url)
        if not r:
            continue
        try:
            values = r.json()["data"]["data"]["values"]
            # Auto-detekce lat/lon sloupce
            col3 = [float(row[3]) for row in values[:20] if len(row) >= 5]
            col4 = [float(row[4]) for row in values[:20] if len(row) >= 5]
            avg3 = sum(col3) / len(col3) if col3 else 0
            avg4 = sum(col4) / len(col4) if col4 else 0
            if abs(avg3 - 50) < abs(avg4 - 50):
                lat_col, lon_col = 3, 4
            else:
                lat_col, lon_col = 4, 3

            for row in values:
                if len(row) < 5:
                    continue
                wsi = str(row[0])
                m = re.search(r'(\d+)$', wsi)
                if not m:
                    continue
                sid = m.group(1)
                if sid in merged:
                    continue
                try:
                    lat = float(row[lat_col])
                    lon = float(row[lon_col])
                except (TypeError, ValueError):
                    continue
                elev = None
                try:
                    if len(row) > 5 and row[5] is not None:
                        elev = float(row[5])
                except (TypeError, ValueError):
                    pass
                merged[sid] = {
                    "name": str(row[2]) if row[2] else f"Stanice {sid}",
                    "lat":  lat,
                    "lon":  lon,
                    "elev": elev,
                }
            print(f"  Metadata {label}: {len(values)} řádků → {len(merged)} stanic", file=sys.stderr)
        except Exception as e:
            print(f"  Metadata chyba ({label}): {e}", file=sys.stderr)
    return merged


# ── Parsování ─────────────────────────────────────────────────────────────────

def _extract_by_dt(data: dict, elem_map: dict) -> dict[str, dict]:
    by_dt: dict[str, dict] = {}
    try:
        values = data["data"]["data"]["values"]
    except (KeyError, TypeError):
        return by_dt
    for row in values:
        if len(row) < 4:
            continue
        _sid, element, dt, val = row[0], row[1], row[2], row[3]
        key = elem_map.get(element)
        if key is None or val is None or val == "":
            continue
        try:
            fval = float(val)
            if fval != fval:
                continue
        except (TypeError, ValueError):
            continue
        by_dt.setdefault(dt, {}).setdefault(key, fval)
    return by_dt


def parse_station(sid: str, data_10m, data_1h) -> tuple[dict | None, dict | None]:
    by_dt: dict[str, dict] = {}
    if data_10m:
        for dt, elems in _extract_by_dt(data_10m, ELEM_10M).items():
            by_dt.setdefault(dt, {}).update({k: v for k, v in elems.items()
                                              if k not in by_dt.get(dt, {})})
    if data_1h:
        for dt, elems in _extract_by_dt(data_1h, ELEM_1H).items():
            by_dt.setdefault(dt, {}).update({k: v for k, v in elems.items()
                                              if k not in by_dt.get(dt, {})})
    if not by_dt:
        return None, None

    sorted_dts = sorted(by_dt.keys(), reverse=True)
    latest_dt, latest = sorted_dts[0], by_dt[sorted_dts[0]]
    for dt in sorted_dts:
        if "temp" in by_dt[dt] or "humidity" in by_dt[dt]:
            latest_dt, latest = dt, by_dt[dt]
            break

    def ms_to_kmh(v):
        return round(v * 3.6, 1) if v is not None else None

    precip_1h = latest.get("precip_1h")
    if precip_1h is None:
        vals_10m = [by_dt[dt].get("precip_10m")
                    for dt in sorted(by_dt.keys(), reverse=True)[:6]
                    if by_dt[dt].get("precip_10m") is not None]
        if len(vals_10m) >= 3:
            precip_1h = round(sum(vals_10m), 2)

    obs = {
        "id":           f"0-20000-0-{sid}",
        "time_utc":     latest_dt,
        "temp":         latest.get("temp"),
        "humidity":     latest.get("humidity"),
        "pressure":     latest.get("pressure"),
        "wind_kmh":     ms_to_kmh(latest.get("wind_ms")),
        "gust_kmh":     ms_to_kmh(latest.get("gust_ms")),
        "wind_dir":     latest.get("wind_dir"),
        "precip_1h":    precip_1h,
        "precip_10m":   latest.get("precip_10m"),
        "snow_cm":      latest.get("snow_cm"),
        "solar":        latest.get("solar"),
        "dewpoint":     latest.get("dewpoint"),
        "visibility_m": latest.get("visibility_m"),
        "own":          False,
    }

    # Nejnovější hodnota pro historii (jeden řádek per běh)
    history_entry = {"dt": latest_dt}
    for key in ("temp", "humidity", "pressure", "solar", "dewpoint",
                "precip_1h", "precip_10m", "snow_cm", "visibility_m"):
        if latest.get(key) is not None:
            history_entry[key] = latest[key]
    if latest.get("wind_ms") is not None:
        history_entry["wind_kmh"] = ms_to_kmh(latest["wind_ms"])
    if latest.get("gust_ms") is not None:
        history_entry["gust_kmh"] = ms_to_kmh(latest["gust_ms"])
    if latest.get("wind_dir") is not None:
        history_entry["wind_dir"] = latest["wind_dir"]

    return obs, history_entry


# ── Historie ──────────────────────────────────────────────────────────────────

def load_history() -> dict:
    """Načte historii z live Pages nebo z lokálního souboru."""
    local = DATA_DIR / "chmi_history.json"
    # Zkus live Pages první
    try:
        r = requests.get(f"{PAGES_BASE}/data/chmi_history.json",
                         headers=HEADERS, timeout=10)
        if r.ok:
            data = r.json()
            print(f"  Historie z Pages: {sum(len(s.get('series', [])) for s in data.get('stations', {}).values())} záznamů", file=sys.stderr)
            return data
    except Exception as e:
        print(f"  Pages historie nedostupná: {e}", file=sys.stderr)
    # Fallback: lokální soubor (při lokálním spuštění)
    if local.exists():
        try:
            return json.loads(local.read_text())
        except Exception:
            pass
    return {"stations": {}}


def append_history(history: dict, stations: list,
                   entries: dict[str, dict], cutoff_dt: str) -> dict:
    """Přidá aktuální měření do historie a ořízne na HISTORY_HOURS."""
    for obs in stations:
        sid = obs["id"]
        entry = entries.get(sid.split("-")[-1])
        if entry is None:
            continue
        if sid not in history["stations"]:
            history["stations"][sid] = {
                "name":   obs["name"],
                "lat":    obs["lat"],
                "lon":    obs["lon"],
                "series": [],
            }
        series = history["stations"][sid]["series"]
        # Nepřidávej duplikát (stejný dt)
        if not series or series[-1].get("dt") != entry["dt"]:
            series.append(entry)
        # Ořízni na okno
        history["stations"][sid]["series"] = [
            e for e in series if e.get("dt", "") >= cutoff_dt
        ]
    return history


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n=== ČHMÚ stanice — now/ (aktuální + historie) ===")

    now_utc   = datetime.now(timezone.utc)
    today     = now_utc.strftime("%Y%m%d")
    yesterday = (now_utc - timedelta(days=1)).strftime("%Y%m%d")
    cutoff_dt = (now_utc - timedelta(hours=HISTORY_HOURS)).isoformat(timespec="minutes")

    print(f"  UTC: {now_utc.isoformat(timespec='minutes')}", file=sys.stderr)

    # 1. Metadata z now/
    metadata = load_metadata(today, yesterday)
    if not metadata:
        print("  !! Metadata nedostupná", file=sys.stderr)
        _save_empty("Metadata nedostupná")
        return

    # 2. Seznam stanic z now/data/ directory
    r = fetch(NOW_DATA)
    now_ids = []
    if r:
        text = r.text
        ids = set()
        for date in (today, yesterday):
            for prefix in ("10m", "1h"):
                p = re.compile(rf'{prefix}-0-20000-0-(\d+)-{date}\.json')
                ids.update(p.findall(text))
        now_ids = [sid for sid in ids if sid in metadata]
    print(f"  now/ stanice: {len(now_ids)}", file=sys.stderr)

    if not now_ids:
        _save_empty("Žádné now/ stanice")
        return

    # 3. Stáhni 10m + 1h soubory pro now/ stanice (max ~160 požadavků)
    urls = []
    for sid in now_ids:
        for d in (today, yesterday):
            urls.append((f"10m_{sid}_{d}", f"{NOW_DATA}10m-0-20000-0-{sid}-{d}.json"))
            urls.append((f"1h_{sid}_{d}",  f"{NOW_DATA}1h-0-20000-0-{sid}-{d}.json"))

    print(f"  Stahuji {len(urls)} souborů…", file=sys.stderr)
    fetched = fetch_all(urls)
    print(f"  Staženo {len(fetched)} souborů", file=sys.stderr)

    def best(prefix, sid):
        for d in (today, yesterday):
            key = f"{prefix}_{sid}_{d}"
            if key in fetched:
                return fetched[key]
        return None

    # 4. Parsování
    stations   = []
    history_entries = {}
    ok = err   = 0

    for sid in now_ids:
        obs, h_entry = parse_station(sid, best("10m", sid), best("1h", sid))
        if obs is None:
            err += 1
            continue
        m = metadata[sid]
        obs["name"] = m["name"]
        obs["lat"]  = m["lat"]
        obs["lon"]  = m["lon"]
        obs["elev"] = m.get("elev")
        stations.append(obs)
        if h_entry:
            history_entries[sid] = h_entry
        ok += 1

    print(f"  Zpracováno: {ok} OK, {err} chyb", file=sys.stderr)

    # 5. Historie — načti, přidej, ulož
    history = load_history()
    history = append_history(history, stations, history_entries, cutoff_dt)
    history["updated_at_utc"] = now_utc.isoformat()
    total_entries = sum(len(s.get("series", [])) for s in history["stations"].values())
    print(f"  Historie: {len(history['stations'])} stanic, {total_entries} záznamů", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    (DATA_DIR / "chmi_stations.json").write_text(json.dumps({
        "generated_at_utc": now_utc.isoformat(),
        "count":    len(stations),
        "stations": stations,
    }, indent=2, ensure_ascii=False))
    print(f"  ✓ chmi_stations.json — {len(stations)} stanic", file=sys.stderr)

    (DATA_DIR / "chmi_history.json").write_text(
        json.dumps(history, ensure_ascii=False))
    print(f"  ✓ chmi_history.json — {total_entries} záznamů", file=sys.stderr)


def _save_empty(error_msg: str):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    empty = {"generated_at_utc": datetime.now(timezone.utc).isoformat(),
             "error": error_msg, "stations": []}
    (DATA_DIR / "chmi_stations.json").write_text(
        json.dumps(empty, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
