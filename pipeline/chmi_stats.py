"""
ČHMÚ historická a aktuální statistická data.

Stahuje z opendata.chmi.cz:
  recent/data/daily/    → denní souhrny aktuálního měsíce (dly-{WSI}-{YYYYMM}.json)
  recent/data/monthly/  → měsíční souhrny posledních let  (mly-{WSI}.json)
  historical/data/daily/   → denní data od 2018           (dly-{WSI}.json — jeden soubor)
  historical/data/monthly/ → měsíční data od 2018         (mly-{WSI}.json)

Výstup: data/chmi_stats.json  — per stanice: rekordy, klimatologické normály, roční trend
"""

import json
import sys
import re
import requests
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = 30

BASE      = "https://opendata.chmi.cz/meteorology/climate"
RECENT    = f"{BASE}/recent/data"
HIST      = f"{BASE}/historical/data"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept":     "application/json,*/*",
}

# Elementy ze souhrných souborů (daily/monthly)
DAILY_ELEMENTS = {
    "TMX": "temp_max",    # denní maximum teploty °C
    "TMN": "temp_min",    # denní minimum teploty °C
    "TME": "temp_avg",    # průměr teploty °C
    "RR":  "precip",      # úhrn srážek mm
    "FFX": "gust_kmh",    # max nárazy m/s → km/h
    "SCE": "snow_cm",     # výška sněhu cm
    "SSSe":"sunshine_h",  # sluneční svit h
}

MONTHLY_ELEMENTS = {
    "TMX": "temp_max",
    "TMN": "temp_min",
    "TME": "temp_avg",
    "RR":  "precip",
    "SNW": "snow_days",
}


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


def list_ids_in_dir(base_url: str, prefix: str) -> list[str]:
    """Vyparsuje WSI ID ze sloučeného dir-listingu."""
    r = fetch(base_url)
    if not r:
        return []
    pattern = re.compile(rf'{re.escape(prefix)}-0-20000-0-(\d+)')
    ids = list(dict.fromkeys(pattern.findall(r.text)))
    return ids


def extract_values(data: dict, elements: dict) -> dict[str, list]:
    """Z pivot JSON extrahuje hodnoty pro dané elementy → {element: [(dt, val)]}."""
    result: dict[str, list] = {v: [] for v in elements.values()}
    try:
        rows = data["data"]["data"]["values"]
    except (KeyError, TypeError):
        return result

    for row in rows:
        if len(row) < 4:
            continue
        _sid, element, dt, val = row[0], row[1], row[2], row[3]
        key = elements.get(element)
        if key is None or val is None or val == "":
            continue
        try:
            fval = float(val)
            result[key].append((dt, fval))
        except (TypeError, ValueError):
            pass
    return result


def compute_records(daily_vals: dict[str, list]) -> dict:
    """Vypočítá all-time rekordy z denních hodnot."""
    records = {}
    for key, pairs in daily_vals.items():
        if not pairs:
            continue
        if "max" in key or key in ("temp_max", "precip", "gust_kmh", "snow_cm", "sunshine_h"):
            best = max(pairs, key=lambda x: x[1])
        else:
            best = min(pairs, key=lambda x: x[1])
        records[key] = {"value": best[1], "date": best[0]}
    return records


def compute_monthly_normals(monthly_vals: dict[str, list]) -> dict[int, dict]:
    """
    Průměr hodnot po měsících (1-12) z dostupných let.
    monthly_vals: {key: [(YYYY-MM, value), ...]}
    """
    from collections import defaultdict
    buckets: dict[int, dict[str, list]] = defaultdict(lambda: {k: [] for k in monthly_vals})
    for key, pairs in monthly_vals.items():
        for dt, val in pairs:
            try:
                m = int(dt[5:7])
                buckets[m][key].append(val)
            except (ValueError, IndexError):
                pass
    normals = {}
    for month in range(1, 13):
        normals[month] = {}
        for key, vals in buckets[month].items():
            if vals:
                normals[month][key] = round(sum(vals) / len(vals), 2)
    return normals


def compute_yearly_trend(daily_vals: dict[str, list]) -> dict[int, dict]:
    """Roční průměry/souhrny z denních dat."""
    from collections import defaultdict
    by_year: dict[int, dict[str, list]] = defaultdict(lambda: {k: [] for k in daily_vals})
    for key, pairs in daily_vals.items():
        for dt, val in pairs:
            try:
                y = int(dt[:4])
                by_year[y][key].append(val)
            except (ValueError, IndexError):
                pass

    trend = {}
    for year, data in sorted(by_year.items()):
        trend[year] = {}
        if data.get("temp_avg"):
            trend[year]["temp_avg"] = round(sum(data["temp_avg"]) / len(data["temp_avg"]), 2)
        if data.get("temp_max"):
            trend[year]["temp_max"] = round(max(data["temp_max"]), 1)
        if data.get("temp_min"):
            trend[year]["temp_min"] = round(min(data["temp_min"]), 1)
        if data.get("precip"):
            trend[year]["precip_total"] = round(sum(data["precip"]), 1)
    return trend


def load_station_ids_from_chmi_stations() -> list[str]:
    """Načte ID stanic z existujícího chmi_stations.json."""
    path = DATA_DIR / "chmi_stations.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        ids = []
        for s in data.get("stations", []):
            m = re.search(r'(\d+)$', s.get("id", ""))
            if m:
                ids.append(m.group(1))
        return ids
    except Exception:
        return []


CACHE_MAX_AGE_H = 6  # přegenerovat pokud je soubor starší než 6 hodin


def main():
    print("\n=== ČHMÚ statistiky — historická data ===")

    now_utc = datetime.now(timezone.utc)
    yyyymm  = now_utc.strftime("%Y%m")

    # Cache check — přeskočit pokud je soubor čerstvý
    stats_path = DATA_DIR / "chmi_stats.json"
    if stats_path.exists():
        age_s = (now_utc.timestamp() - stats_path.stat().st_mtime)
        if age_s < CACHE_MAX_AGE_H * 3600:
            print(f"  chmi_stats.json je {age_s/3600:.1f}h starý — přeskočeno "
                  f"(cache {CACHE_MAX_AGE_H}h)", file=sys.stderr)
            return
        print(f"  chmi_stats.json je {age_s/3600:.1f}h starý — regeneruji", file=sys.stderr)

    # Zjisti seznam stanic z aktuálního výstupu chmi.py
    station_ids = load_station_ids_from_chmi_stations()
    if not station_ids:
        # Fallback: zjisti z recent/daily dir-listingu
        station_ids = list_ids_in_dir(f"{RECENT}/daily/", "dly")
    if not station_ids:
        print("  Žádné stanice nenalezeny", file=sys.stderr)
        return

    print(f"  Zpracovávám {len(station_ids)} stanic…", file=sys.stderr)

    all_stats = {}
    ok = 0

    for sid in station_ids:
        wsi_suffix = f"0-20000-0-{sid}"

        # Denní data aktuálního měsíce (recent)
        daily_recent = fetch_json(f"{RECENT}/daily/dly-{wsi_suffix}-{yyyymm}.json")

        # Historická denní data — jeden soubor na stanici se všemi roky (PDF dokumentace)
        hist_daily_combined: dict[str, list] = {v: [] for v in DAILY_ELEMENTS.values()}
        hd = fetch_json(f"{HIST}/daily/dly-{wsi_suffix}.json")
        if hd:
            extracted = extract_values(hd, DAILY_ELEMENTS)
            for key, pairs in extracted.items():
                hist_daily_combined[key].extend(pairs)

        # Doplň aktuální měsíc
        if daily_recent:
            recent_extracted = extract_values(daily_recent, DAILY_ELEMENTS)
            for key, pairs in recent_extracted.items():
                hist_daily_combined[key].extend(pairs)

        # Měsíční data (historical)
        hist_monthly = fetch_json(f"{HIST}/monthly/mly-{wsi_suffix}.json")
        monthly_vals: dict[str, list] = {v: [] for v in MONTHLY_ELEMENTS.values()}
        if hist_monthly:
            extracted = extract_values(hist_monthly, MONTHLY_ELEMENTS)
            for key, pairs in extracted.items():
                monthly_vals[key].extend(pairs)
        # Doplň recent monthly
        recent_monthly = fetch_json(f"{RECENT}/monthly/mly-{wsi_suffix}.json")
        if recent_monthly:
            extracted = extract_values(recent_monthly, MONTHLY_ELEMENTS)
            for key, pairs in extracted.items():
                monthly_vals[key].extend(pairs)

        has_data = any(hist_daily_combined[k] for k in hist_daily_combined)
        if not has_data:
            continue

        records         = compute_records(hist_daily_combined)
        monthly_normals = compute_monthly_normals(monthly_vals)
        yearly_trend    = compute_yearly_trend(hist_daily_combined)

        all_stats[f"0-20000-0-{sid}"] = {
            "records":         records,
            "monthly_normals": {str(k): v for k, v in monthly_normals.items()},
            "yearly_trend":    {str(k): v for k, v in yearly_trend.items()},
        }
        ok += 1
        print(f"  ✓ {sid}: {sum(len(v) for v in hist_daily_combined.values())} denních záznamů", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "generated_at_utc": now_utc.isoformat(),
        "stations": all_stats,
    }
    path = DATA_DIR / "chmi_stats.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\n  ✓ chmi_stats.json — {ok} stanic s historickými daty", file=sys.stderr)


if __name__ == "__main__":
    main()
