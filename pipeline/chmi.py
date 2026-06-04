"""
ČHMÚ stanice — stažení aktuálních pozorování.

Kombinuje dvě datové sady:
  now/data/      — 40 synoptických stanic, 10min data + SYNOP 1h
  recent/hourly/ — 500+ stanic (auto + manuální), hodinová data

Výstup:
  data/chmi_stations.json  — aktuální hodnoty všech stanic
  data/chmi_series.json    — časové řady za posledních 24h pro grafy
"""

import json
import re
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = 20
MAX_WORKERS = 24   # paralelní HTTP requesty

BASE          = "https://opendata.chmi.cz/meteorology/climate"
NOW_DATA      = f"{BASE}/now/data/"
NOW_META      = f"{BASE}/now/metadata/"
RECENT_HOURLY = f"{BASE}/recent/data/1hour/"
RECENT_META   = f"{BASE}/recent/metadata/"

# Střední Evropa — ČR + okolní státy (~200 km za hranice)
CZ_LAT = (47.0, 52.5)
CZ_LON = (10.5, 20.5)

HOURS_SERIES = 25   # kolik hodin zpětně uchovávat v series

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept":     "application/json,text/html,*/*",
}

# Elementy z now/data/ 10m souborů
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

# Elementy z recent/hourly/ 1h souborů
ELEM_1H = {
    "T":    "temp",
    "H":    "humidity",
    "P":    "pressure",
    "F":    "wind_ms",
    "Fmax": "gust_ms",
    "D":    "wind_dir",
    "RR":   "precip_1h",     # srážky za hodinu mm
    "SCE":  "snow_cm",        # výška sněhu cm
    "SD":   "snow_cm",        # alt. kód sněhu
    "Vis":  "visibility_m",   # viditelnost m
    "Td":   "dewpoint",       # rosný bod °C
    "W":    "weather_code",   # kód počasí WMO
    "SSV":  "solar",          # sluneční záření W/m²
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
    """Paralelně stáhne seznam (key, url) → {key: json_data}."""
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

def parse_meta1(values: list) -> dict[str, dict]:
    """
    Parsuje meta1-*.json: flat tabulka.
    Sloupce: WSI, GH_ID, FULL_NAME, GEOGR1, GEOGR2, ELEVATION, ...
    GEOGR1/GEOGR2 mohou být lon/lat nebo lat/lon — auto-detekce.
    Vrátí jen stanice v bounding boxu ČR.
    """
    if not values:
        return {}

    # Auto-detekce: zjisti z prvních 20 řádků, která z col3/col4 je lat (48–51) a která lon (12–19)
    col3_vals = []
    col4_vals = []
    for row in values[:20]:
        if len(row) < 5:
            continue
        try:
            col3_vals.append(float(row[3]))
            col4_vals.append(float(row[4]))
        except (TypeError, ValueError):
            pass

    # col3 je lat pokud průměr leží v CZ lat rozsahu; jinak col3 = lon
    avg3 = sum(col3_vals) / len(col3_vals) if col3_vals else 0
    if CZ_LAT[0] <= avg3 <= CZ_LAT[1]:
        lat_col, lon_col = 3, 4   # GEOGR1=lat, GEOGR2=lon
    else:
        lat_col, lon_col = 4, 3   # GEOGR1=lon, GEOGR2=lat (původní předpoklad)

    meta = {}
    for row in values:
        if len(row) < 5:
            continue
        wsi  = str(row[0])
        name = str(row[2]) if row[2] else None
        try:
            lat = float(row[lat_col])
            lon = float(row[lon_col])
        except (TypeError, ValueError):
            continue
        if not (CZ_LAT[0] <= lat <= CZ_LAT[1] and CZ_LON[0] <= lon <= CZ_LON[1]):
            continue
        m = re.search(r'(\d+)$', wsi)
        if not m:
            continue
        sid = m.group(1)
        elev = None
        try:
            if len(row) > 5 and row[5] is not None:
                elev = float(row[5])
        except (TypeError, ValueError):
            pass
        meta[sid] = {
            "name": name or f"Stanice {sid}",
            "lat":  lat,
            "lon":  lon,
            "elev": elev,
        }
    return meta


def load_metadata() -> dict[str, dict]:
    """
    Sloučí meta1 ze všech dostupných zdrojů (recent má přednost nad now).
    Vrátí dict: numeric_sid → {name, lat, lon, elev}.
    """
    now_utc   = datetime.now(timezone.utc)
    today     = now_utc.strftime("%Y%m%d")
    yesterday = (now_utc - timedelta(days=1)).strftime("%Y%m%d")

    # Pořadí: recent má více stanic a má přednost
    sources = [
        (f"{RECENT_META}meta1-{today}.json",    "recent-today"),
        (f"{RECENT_META}meta1-{yesterday}.json", "recent-yesterday"),
        (f"{NOW_META}meta1-{today}.json",         "now-today"),
        (f"{NOW_META}meta1-{yesterday}.json",     "now-yesterday"),
    ]
    merged: dict[str, dict] = {}
    for url, label in sources:
        r = fetch(url)
        if not r:
            print(f"  Metadata {label}: nedostupné", file=sys.stderr)
            continue
        try:
            data   = r.json()
            values = data["data"]["data"]["values"]
            total  = len(values)
            meta   = parse_meta1(values)
            print(f"  Metadata {label}: {total} řádků → {len(meta)} CZ stanic", file=sys.stderr)
            # Přidej nové stanice (recent má přednost — přidáváme jen pokud sid ještě není)
            for sid, info in meta.items():
                merged.setdefault(sid, info)
        except Exception as e:
            print(f"  Metadata parse error ({label} {url}): {e}", file=sys.stderr)

    print(f"  Metadata celkem: {len(merged)} unikátních CZ stanic", file=sys.stderr)
    return merged


# ── Directory listing ─────────────────────────────────────────────────────────

def list_now_ids(today: str, yesterday: str) -> list[str]:
    """Vrátí numerická ID stanic z now/data/ (10m + 1h soubory)."""
    r = fetch(NOW_DATA)
    if not r:
        return []
    text = r.text
    ids = set()
    for date in (today, yesterday):
        for prefix in ("10m", "1h"):
            p = re.compile(rf'{prefix}-0-20000-0-(\d+)-{date}\.json')
            ids.update(p.findall(text))
    result = list(ids)
    print(f"  now/: {len(result)} stanic", file=sys.stderr)
    return result


def list_recent_ids(today: str, yesterday: str) -> list[str]:
    """Vrátí numerická ID stanic z recent/data/1hour/."""
    r = fetch(RECENT_HOURLY)
    if not r:
        return []
    text = r.text
    ids = set()
    for d in (today, yesterday):
        p = re.compile(rf'1h-0-20000-0-(\d+)-{d}\.json')
        ids.update(p.findall(text))
    result = list(ids)
    print(f"  recent/1hour/: {len(result)} stanic", file=sys.stderr)
    return result


# ── Parsování datových souborů ────────────────────────────────────────────────

def _extract_by_dt(data: dict, elem_map: dict) -> dict[str, dict[str, float]]:
    """Z JSON pivot souboru vrátí {dt: {elem_key: value}}."""
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
            if fval != fval:   # nan
                continue
        except (TypeError, ValueError):
            continue
        if dt not in by_dt:
            by_dt[dt] = {}
        # Nepřepisuj existující hodnotu (10m má prioritu nad 1h pro stejný dt)
        by_dt[dt].setdefault(key, fval)
    return by_dt


def merge_by_dt(base: dict, extra: dict) -> dict:
    """Sloučí dva by_dt diktáty — base má prioritu."""
    merged = dict(base)
    for dt, elems in extra.items():
        if dt not in merged:
            merged[dt] = {}
        for k, v in elems.items():
            merged[dt].setdefault(k, v)
    return merged


def parse_station(sid: str,
                  data_10m: dict | None,
                  data_1h_now: dict | None,
                  data_1h_recent: dict | None,
                  cutoff_dt: str) -> tuple[dict | None, list[dict]]:
    """
    Sloučí data ze všech dostupných zdrojů a vrátí (current_obs, series).
    cutoff_dt: ISO timestamp — starší záznamy vynecháme ze series.
    """
    by_dt: dict[str, dict] = {}

    if data_10m:
        by_dt = merge_by_dt(by_dt, _extract_by_dt(data_10m, ELEM_10M))
    if data_1h_now:
        by_dt = merge_by_dt(by_dt, _extract_by_dt(data_1h_now, ELEM_1H))
    if data_1h_recent:
        by_dt = merge_by_dt(by_dt, _extract_by_dt(data_1h_recent, ELEM_1H))

    if not by_dt:
        return None, []

    sorted_dts = sorted(by_dt.keys(), reverse=True)

    # Nejnovější timestamp s alespoň teplotou nebo vlhkostí
    latest_dt, latest = None, {}
    for dt in sorted_dts:
        elems = by_dt[dt]
        if "temp" in elems or "humidity" in elems:
            latest_dt, latest = dt, elems
            break
    if not latest:
        latest_dt = sorted_dts[0]
        latest = by_dt[latest_dt]

    def ms_to_kmh(v):
        return round(v * 3.6, 1) if v is not None else None

    # Fallback precip_1h: pokud chybí hodinová hodnota, sečti posledních 6 × 10min záznamů
    precip_1h = latest.get("precip_1h")
    if precip_1h is None:
        recent_10m = [
            by_dt[dt].get("precip_10m")
            for dt in sorted(by_dt.keys(), reverse=True)[:6]
            if by_dt[dt].get("precip_10m") is not None
        ]
        if len(recent_10m) >= 3:  # alespoň 30 minut dat
            precip_1h = round(sum(recent_10m), 2)

    # precip_24h: součet hodinových srážek za posledních 24h
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    cutoff_24h = (_dt.now(_tz.utc) - _td(hours=24)).isoformat(timespec="minutes")
    precip_24h_vals = [
        by_dt[dt].get("precip_1h")
        for dt in by_dt
        if dt >= cutoff_24h and by_dt[dt].get("precip_1h") is not None
    ]
    precip_24h = round(sum(precip_24h_vals), 1) if precip_24h_vals else None

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
        "precip_24h":   precip_24h,
        "snow_cm":      latest.get("snow_cm"),
        "solar":        latest.get("solar"),
        "dewpoint":     latest.get("dewpoint"),
        "visibility_m": latest.get("visibility_m"),
        "own":          False,
    }

    # Series — jen záznamy novější než cutoff_dt
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
    print("\n=== ČHMÚ stanice — now/ + recent/hourly/ ===")

    now_utc      = datetime.now(timezone.utc)
    today        = now_utc.strftime("%Y%m%d")
    yesterday    = (now_utc - timedelta(days=1)).strftime("%Y%m%d")
    yyyymm       = now_utc.strftime("%Y%m")
    prev_yyyymm  = (now_utc - timedelta(days=32)).strftime("%Y%m")
    cutoff_dt    = (now_utc - timedelta(hours=HOURS_SERIES)).isoformat(timespec="minutes")

    print(f"  UTC: {now_utc.isoformat(timespec='minutes')}", file=sys.stderr)

    # 1. Metadata
    metadata = load_metadata()
    if not metadata:
        print("  !! Metadata nedostupná — konec", file=sys.stderr)
        _save_empty("Metadata nedostupná")
        return

    # 2. Seznam stanic
    now_ids    = list_now_ids(today, yesterday)
    recent_ids = list_recent_ids(today, yesterday)

    # Klíčová oprava: directory listing na recent/ vrací 403 → recent_ids = [].
    # Proto použij VŠECHNY stanice z metadat jako základ pro recent/ stahování.
    # now/ directory listing funguje (40 synoptických), metadata pokrývají 300+ CZ stanic.
    meta_ids = list(metadata.keys())

    # Sjednocení — now/ + metadata (recent/ bude zkušebně staženo pro všechny)
    all_sids = list(dict.fromkeys(now_ids + meta_ids))
    cz_sids  = [sid for sid in all_sids if sid in metadata]
    print(f"  Celkem unikátních CZ stanic: {len(cz_sids)} "
          f"(now={len(now_ids)}, recent_dir={len(recent_ids)}, meta={len(meta_ids)})", file=sys.stderr)

    if not cz_sids:
        _save_empty("Žádné CZ stanice nenalezeny")
        return

    # 3. Paralelní stahování dat
    # now/: 10m soubory (priorita pro synoptické prvky)
    now_10m_urls = [
        (f"10m_{sid}_{d}", f"{NOW_DATA}10m-0-20000-0-{sid}-{d}.json")
        for sid in now_ids if sid in metadata
        for d in (today, yesterday)
    ]
    # now/: 1h soubory (SYNOP hodinové záznamy)
    now_1h_urls = [
        (f"1h_now_{sid}_{d}", f"{NOW_DATA}1h-0-20000-0-{sid}-{d}.json")
        for sid in now_ids if sid in metadata
        for d in (today, yesterday)
    ]
    # recent/data/1hour/: 1h soubory — daily format YYYYMMDD (PDF dokumentace)
    rec_1h_urls = [
        (f"1h_rec_{sid}_{d}", f"{RECENT_HOURLY}1h-0-20000-0-{sid}-{d}.json")
        for sid in cz_sids
        for d in (today, yesterday)
    ]

    all_urls = now_10m_urls + now_1h_urls + rec_1h_urls
    print(f"  Stahuji {len(all_urls)} souborů ({MAX_WORKERS} paralelně)…", file=sys.stderr)
    fetched = fetch_all(all_urls)
    print(f"  Staženo {len(fetched)} souborů", file=sys.stderr)

    def best(prefix, sid, dates_or_months):
        """Vrátí první dostupný JSON pro daný prefix a sid."""
        for d in dates_or_months:
            key = f"{prefix}_{sid}_{d}"
            if key in fetched:
                return fetched[key]
        return None

    # 4. Parsování
    stations   = []
    all_series = {}
    ok = err   = 0

    for sid in cz_sids:
        data_10m       = best("10m", sid, (today, yesterday))
        data_1h_now    = best("1h_now", sid, (today, yesterday))
        data_1h_recent = best("1h_rec", sid, (today, yesterday))

        if not any([data_10m, data_1h_now, data_1h_recent]):
            err += 1
            continue

        obs, series = parse_station(sid, data_10m, data_1h_now, data_1h_recent, cutoff_dt)
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

    out = {
        "generated_at_utc": now_utc.isoformat(),
        "count":    len(stations),
        "stations": stations,
    }
    (DATA_DIR / "chmi_stations.json").write_text(
        json.dumps(out, indent=2, ensure_ascii=False))
    print(f"  ✓ chmi_stations.json — {len(stations)} stanic", file=sys.stderr)

    series_out = {
        "generated_at_utc": now_utc.isoformat(),
        "stations": all_series,
    }
    (DATA_DIR / "chmi_series.json").write_text(
        json.dumps(series_out, indent=2, ensure_ascii=False))
    print(f"  ✓ chmi_series.json — {len(all_series)} stanic s časovými řadami", file=sys.stderr)


def _save_empty(error_msg: str):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for fname in ("chmi_stations.json", "chmi_series.json"):
        (DATA_DIR / fname).write_text(json.dumps({
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "error":    error_msg,
            "stations": [],
        }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
