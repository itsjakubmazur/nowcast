"""
ČHMÚ stanice — aktuální pozorování + 48h série přímo z API.

Zdroj: now/data/ — 40 synoptických stanic, 10min + 1h záznamy.
Denní soubory obsahují celý den → stáhneme dnes + včera = ~48h série bez akumulace.

Výstup:
  data/chmi_stations.json  — aktuální hodnoty
  data/chmi_series.json    — 48h časové řady pro grafy
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

def fetch(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r
        print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def fetch_json(url):
    r = fetch(url)
    if not r:
        return None
    try:
        return r.json()
    except Exception as e:
        print(f"  JSON parse {url}: {e}", file=sys.stderr)
        return None


def fetch_all(urls):
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

def load_metadata(today, yesterday):
    sources = [
        (f"{NOW_META}meta1-{today}.json",    "now-today"),
        (f"{NOW_META}meta1-{yesterday}.json", "now-yesterday"),
    ]
    merged = {}
    for url, label in sources:
        r = fetch(url)
        if not r:
            continue
        try:
            values = r.json()["data"]["data"]["values"]
            col3 = [float(row[3]) for row in values[:20] if len(row) >= 5]
            col4 = [float(row[4]) for row in values[:20] if len(row) >= 5]
            avg3 = sum(col3) / len(col3) if col3 else 0
            avg4 = sum(col4) / len(col4) if col4 else 0
            lat_col, lon_col = (3, 4) if abs(avg3 - 50) < abs(avg4 - 50) else (4, 3)

            for row in values:
                if len(row) < 5:
                    continue
                m = re.search(r'(\d+)$', str(row[0]))
                if not m:
                    continue
                sid = m.group(1)
                if sid in merged:
                    continue
                try:
                    lat, lon = float(row[lat_col]), float(row[lon_col])
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
                    "lat": lat, "lon": lon, "elev": elev,
                }
            print(f"  Metadata {label}: {len(values)} řádků → {len(merged)} stanic", file=sys.stderr)
        except Exception as e:
            print(f"  Metadata chyba ({label}): {e}", file=sys.stderr)
    return merged


# ── Parsování ─────────────────────────────────────────────────────────────────

def _extract_by_dt(data, elem_map):
    """Z JSON pivot souboru vrátí {dt: {elem_key: value}}."""
    by_dt = {}
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


def parse_station(sid, data_10m, data_1h, cutoff_dt):
    """
    Vrátí (current_obs, series_list).
    Serie = všechny timestampy >= cutoff_dt ze stažených souborů.
    """
    by_dt = {}
    if data_10m:
        for dt, elems in _extract_by_dt(data_10m, ELEM_10M).items():
            by_dt.setdefault(dt, {}).update(
                {k: v for k, v in elems.items() if k not in by_dt.get(dt, {})})
    if data_1h:
        for dt, elems in _extract_by_dt(data_1h, ELEM_1H).items():
            by_dt.setdefault(dt, {}).update(
                {k: v for k, v in elems.items() if k not in by_dt.get(dt, {})})

    if not by_dt:
        return None, []

    sorted_dts = sorted(by_dt.keys(), reverse=True)

    # Nejnovější timestamp s teplotou nebo vlhkostí
    latest_dt = sorted_dts[0]
    latest = by_dt[latest_dt]
    for dt in sorted_dts:
        if "temp" in by_dt[dt] or "humidity" in by_dt[dt]:
            latest_dt, latest = dt, by_dt[dt]
            break

    def ms_to_kmh(v):
        return round(v * 3.6, 1) if v is not None else None

    precip_1h = latest.get("precip_1h")
    if precip_1h is None:
        vals_10m = [by_dt[dt].get("precip_10m")
                    for dt in sorted_dts[:6]
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

    # Série — všechny timestampy >= cutoff_dt
    series = []
    for dt in sorted(by_dt.keys()):
        if dt < cutoff_dt:
            continue
        elems = by_dt[dt]
        row = {"dt": dt}
        for key in ("temp", "humidity", "pressure", "solar", "dewpoint",
                    "precip_1h", "precip_10m", "snow_cm", "visibility_m"):
            if key in elems:
                row[key] = elems[key]
        if "wind_ms" in elems:
            row["wind_kmh"] = ms_to_kmh(elems["wind_ms"])
        if "gust_ms" in elems:
            row["gust_kmh"] = ms_to_kmh(elems["gust_ms"])
        if "wind_dir" in elems:
            row["wind_dir"] = elems["wind_dir"]
        series.append(row)

    return obs, series


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n=== ČHMÚ stanice — now/ (aktuální + 48h série) ===")

    now_utc   = datetime.now(timezone.utc)
    today     = now_utc.strftime("%Y%m%d")
    yesterday = (now_utc - timedelta(days=1)).strftime("%Y%m%d")
    cutoff_dt = (now_utc - timedelta(hours=48)).isoformat(timespec="minutes")

    print(f"  UTC: {now_utc.isoformat(timespec='minutes')}", file=sys.stderr)

    # 1. Metadata
    metadata = load_metadata(today, yesterday)
    if not metadata:
        print("  !! Metadata nedostupná", file=sys.stderr)
        _save_empty("Metadata nedostupná")
        return

    # 2. Seznam stanic z directory listingu now/data/
    r = fetch(NOW_DATA)
    if not r:
        _save_empty("now/data/ nedostupné")
        return
    now_ids = []
    for date in (today, yesterday):
        for prefix in ("10m", "1h"):
            p = re.compile(rf'{prefix}-0-20000-0-(\d+)-{date}\.json')
            now_ids.extend(p.findall(r.text))
    now_ids = list(dict.fromkeys(sid for sid in now_ids if sid in metadata))
    print(f"  now/ stanice: {len(now_ids)}", file=sys.stderr)

    if not now_ids:
        _save_empty("Žádné now/ stanice")
        return

    # 3. Stáhni 10m + 1h soubory (dnes + včera) — ~160 požadavků
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

    # 4. Parsování — aktuální + série
    stations   = []
    all_series = {}
    ok = err   = 0

    for sid in now_ids:
        # Sloučíme oba denní soubory dohromady pro sérii
        data_10m_list = [fetched[k] for k in (f"10m_{sid}_{today}", f"10m_{sid}_{yesterday}") if k in fetched]
        data_1h_list  = [fetched[k] for k in (f"1h_{sid}_{today}",  f"1h_{sid}_{yesterday}")  if k in fetched]

        # Pseudoslučování: zavolej parse_station s oběma soubory sloučenými do jednoho by_dt
        by_dt = {}
        for d in data_10m_list:
            for dt, elems in _extract_by_dt(d, ELEM_10M).items():
                by_dt.setdefault(dt, {}).update({k: v for k, v in elems.items() if k not in by_dt.get(dt, {})})
        for d in data_1h_list:
            for dt, elems in _extract_by_dt(d, ELEM_1H).items():
                by_dt.setdefault(dt, {}).update({k: v for k, v in elems.items() if k not in by_dt.get(dt, {})})

        if not by_dt:
            err += 1
            continue

        # Sestav fake data_10m z sloučeného by_dt pro parse_station
        # Jednodušší: zavolej parse_station s prvním dostupným souborem, pak extend series
        obs, series = parse_station(sid, best("10m", sid), best("1h", sid), cutoff_dt)

        # Pro sérii použij všechny by_dt záznamy (oba dny)
        if obs is not None:
            def ms_to_kmh(v):
                return round(v * 3.6, 1) if v is not None else None

            series = []
            for dt in sorted(by_dt.keys()):
                if dt < cutoff_dt:
                    continue
                elems = by_dt[dt]
                row = {"dt": dt}
                for key in ("temp", "humidity", "pressure", "solar", "dewpoint",
                            "precip_1h", "precip_10m", "snow_cm", "visibility_m"):
                    if key in elems:
                        row[key] = elems[key]
                if "wind_ms" in elems:
                    row["wind_kmh"] = ms_to_kmh(elems["wind_ms"])
                if "gust_ms" in elems:
                    row["gust_kmh"] = ms_to_kmh(elems["gust_ms"])
                if "wind_dir" in elems:
                    row["wind_dir"] = elems["wind_dir"]
                series.append(row)

        if obs is None:
            err += 1
            continue

        m = metadata[sid]
        obs["name"] = m["name"]
        obs["lat"]  = m["lat"]
        obs["lon"]  = m["lon"]
        obs["elev"] = m.get("elev")
        stations.append(obs)

        if series:
            all_series[obs["id"]] = {
                "name":   obs["name"],
                "lat":    obs["lat"],
                "lon":    obs["lon"],
                "series": series,
            }
        ok += 1

    print(f"  Zpracováno: {ok} OK, {err} chyb", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    (DATA_DIR / "chmi_stations.json").write_text(json.dumps({
        "generated_at_utc": now_utc.isoformat(),
        "count":    len(stations),
        "stations": stations,
    }, indent=2, ensure_ascii=False))
    print(f"  ✓ chmi_stations.json — {len(stations)} stanic", file=sys.stderr)

    # Per-stanice soubory — detail panel na webu stahuje jen tu jednu stanici,
    # co uživatel otevřel, místo celého 40stanicového bloku.
    series_dir = DATA_DIR / "chmi_series"
    series_dir.mkdir(parents=True, exist_ok=True)
    for sid, payload in all_series.items():
        safe_name = sid.replace("/", "_")
        (series_dir / f"{safe_name}.json").write_text(json.dumps({
            "generated_at_utc": now_utc.isoformat(),
            **payload,
        }, ensure_ascii=False))
    index = {
        "generated_at_utc": now_utc.isoformat(),
        "stations": {sid: {"name": v["name"], "lat": v["lat"], "lon": v["lon"]}
                     for sid, v in all_series.items()},
    }
    (DATA_DIR / "chmi_series_index.json").write_text(json.dumps(index, ensure_ascii=False))
    total_pts = sum(len(v["series"]) for v in all_series.values())
    print(f"  ✓ chmi_series/*.json — {len(all_series)} stanic, {total_pts} bodů (per-station)", file=sys.stderr)


def _save_empty(error_msg):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    empty = {"generated_at_utc": datetime.now(timezone.utc).isoformat(),
             "error": error_msg, "stations": []}
    (DATA_DIR / "chmi_stations.json").write_text(
        json.dumps(empty, indent=2, ensure_ascii=False))
    (DATA_DIR / "chmi_series_index.json").write_text(
        json.dumps({"generated_at_utc": empty["generated_at_utc"], "stations": {}},
                   ensure_ascii=False))


if __name__ == "__main__":
    main()
