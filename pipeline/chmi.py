"""
ČHMÚ automatické stanice — stažení aktuálních 10minutových pozorování.

Zdroj: opendata.chmi.cz/meteorology/climate/now/
Soubory: 10m-0-20000-0-{ID}-{YYYYMMDD}.json
Výstup:  data/chmi_stations.json   (aktuální hodnoty, kompatibilní s wu_stations.json)
         data/chmi_series.json     (časové řady za posledních 24h pro grafy)
"""

import json
import re
import sys
import requests
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = 20

BASE_NOW      = "https://opendata.chmi.cz/meteorology/climate/now"
DATA_URL      = f"{BASE_NOW}/data/"
METADATA_URL  = f"{BASE_NOW}/metadata/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept": "application/json,text/html,*/*",
}

# Elementy které nás zajímají a jejich výstupní klíče
ELEMENT_MAP = {
    "T":      "temp",        # °C
    "H":      "humidity",    # %
    "P":      "pressure",    # hPa
    "F":      "wind_ms",     # m/s → přepočítáme na km/h
    "Fmax":   "gust_ms",     # m/s
    "Fprum":  "wind_avg_ms", # m/s
    "D":      "wind_dir",    # °
    "SRA10M": "precip_10m",  # mm / 10 min
    "SSV10M": "solar",       # W/m²
}


def fetch(url: str) -> requests.Response | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r
        print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def list_station_ids(today: str) -> list[str]:
    """Parsuje HTML directory listing a vrátí numerické ID stanic pro dnešek."""
    r = fetch(DATA_URL)
    if not r:
        return []
    # Hledá soubory tvaru 10m-0-20000-0-{ID}-{YYYYMMDD}.json
    pattern = re.compile(rf'10m-0-20000-0-(\d+)-{today}\.json')
    ids = pattern.findall(r.text)
    unique = list(dict.fromkeys(ids))  # zachová pořadí, odstraní duplicity
    print(f"  Nalezeno {len(unique)} souborů pro {today}", file=sys.stderr)
    return unique


def parse_pivot_metadata(values: list) -> dict[str, dict]:
    """
    Parsuje metadata ve stejném pivot formátu jako datové soubory.
    Každý řádek: [station_id, element, value, ...]
    Elementy: lat/lon/station_name/...
    """
    by_station: dict[str, dict] = {}
    for row in values:
        if len(row) < 3:
            continue
        sid_raw, element, val = str(row[0]), str(row[1]), row[2]
        if val is None or val == "":
            continue
        num = re.search(r'(\d+)$', sid_raw)
        if not num:
            continue
        sid = num.group(1)
        if sid not in by_station:
            by_station[sid] = {"id_raw": sid_raw}
        el = element.lower()
        if el in ("lat", "latitude"):
            try: by_station[sid]["lat"] = float(val)
            except: pass
        elif el in ("lon", "lng", "longitude"):
            try: by_station[sid]["lon"] = float(val)
            except: pass
        elif el in ("station_name", "name", "nazev", "jmeno"):
            by_station[sid]["name"] = str(val)
        elif el in ("alt", "altitude", "elevation", "elev"):
            try: by_station[sid]["alt"] = float(val)
            except: pass

    # Výsledek: jen stanice s alespoň lat nebo lon
    meta = {}
    for sid, s in by_station.items():
        if s.get("lat") is not None or s.get("lon") is not None:
            meta[sid] = {
                "name": s.get("name") or f"Stanice {sid}",
                "lat":  s.get("lat"),
                "lon":  s.get("lon"),
            }
    return meta


def load_metadata() -> dict[str, dict]:
    """
    Stáhne metadata stanic (jméno, lat, lon) z metadata/ adresáře.
    Vrátí dict: station_numeric_id → {name, lat, lon}.
    """
    meta = {}
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    yesterday = (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
                 .__class__.fromtimestamp(
                     datetime.now(timezone.utc).timestamp() - 86400, tz=timezone.utc
                 ).strftime("%Y%m%d"))

    # Soubory ve stejném pivot formátu jako data — meta1 = základní info (jméno, lat, lon)
    meta_candidates = [
        f"{METADATA_URL}meta1-{today}.json",
        f"{METADATA_URL}meta1-{yesterday}.json",
        f"{METADATA_URL}meta2-{today}.json",
        f"{METADATA_URL}meta2-{yesterday}.json",
    ]

    for url in meta_candidates:
        r = fetch(url)
        if not r:
            continue
        try:
            data = r.json()
            # Stejný wrapper jako datové soubory: data.data.values
            values = None
            if isinstance(data, dict):
                try:
                    values = data["data"]["data"]["values"]
                except (KeyError, TypeError):
                    pass
                if values is None:
                    # Alternativní struktura
                    for k in ("values", "data", "stations"):
                        v = data.get(k)
                        if isinstance(v, list):
                            values = v
                            break
            elif isinstance(data, list):
                values = data

            if not values:
                continue

            parsed = parse_pivot_metadata(values)
            if parsed:
                meta.update(parsed)
                print(f"  Metadata: {len(parsed)} stanic z {url}", file=sys.stderr)
                # Stáhni všechny meta soubory pro dnešek (meta1, meta2, meta3...)
                continue  # zkus i další soubory pro doplnění jmen
        except Exception as e:
            print(f"  Metadata parse error ({url}): {e}", file=sys.stderr)

    if meta:
        return meta

    # Záloha: zkus directory listing a parsuj všechny meta soubory
    r = fetch(METADATA_URL)
    if r:
        files = re.findall(r'href="(meta\d+-[^"]+\.json)"', r.text)
        # Preferuj nejnovější (řaď sestupně)
        files = sorted(set(files), reverse=True)[:6]
        for fname in files:
            url = METADATA_URL + fname
            r2 = fetch(url)
            if not r2:
                continue
            try:
                data = r2.json()
                values = None
                if isinstance(data, dict):
                    try:
                        values = data["data"]["data"]["values"]
                    except (KeyError, TypeError):
                        pass
                elif isinstance(data, list):
                    values = data
                if values:
                    parsed = parse_pivot_metadata(values)
                    meta.update(parsed)
                    if parsed:
                        print(f"  Metadata: +{len(parsed)} stanic z {url}", file=sys.stderr)
            except Exception as e:
                print(f"  Metadata parse error ({url}): {e}", file=sys.stderr)

    if meta:
        return meta

    print("  Metadata nedostupná — stanice budou bez jmen/souřadnic", file=sys.stderr)
    return meta


def parse_station_file(station_id: str, data: dict) -> tuple[dict | None, list[dict]]:
    """
    Parsuje JSON soubor jedné stanice.
    Vrátí (current_obs, time_series).
    """
    try:
        values = data["data"]["data"]["values"]
    except (KeyError, TypeError):
        return None, []

    # Seskup hodnoty podle timestampu a elementu
    by_dt: dict[str, dict[str, float]] = {}
    for row in values:
        if len(row) < 4:
            continue
        _sid, element, dt, val = row[0], row[1], row[2], row[3]
        if val is None or val == "" or val != val:  # nan check
            continue
        if element not in ELEMENT_MAP:
            continue
        try:
            fval = float(val)
        except (TypeError, ValueError):
            continue
        if dt not in by_dt:
            by_dt[dt] = {}
        by_dt[dt][element] = fval

    if not by_dt:
        return None, []

    # Nejnovější timestamp s alespoň teplotou nebo vlhkostí
    sorted_dts = sorted(by_dt.keys(), reverse=True)
    latest_dt = None
    latest = {}
    for dt in sorted_dts:
        elems = by_dt[dt]
        if "T" in elems or "H" in elems:
            latest_dt = dt
            latest = elems
            break

    if not latest:
        latest_dt = sorted_dts[0]
        latest = by_dt[latest_dt]

    def ms_to_kmh(v):
        return round(v * 3.6, 1) if v is not None else None

    obs = {
        "id":          f"0-20000-0-{station_id}",
        "time_utc":    latest_dt,
        "temp":        latest.get("T"),
        "humidity":    latest.get("H"),
        "pressure":    latest.get("P"),
        "wind_kmh":    ms_to_kmh(latest.get("F")),
        "gust_kmh":    ms_to_kmh(latest.get("Fmax")),
        "wind_dir":    latest.get("D"),
        "precip_rate": latest.get("SRA10M"),
        "solar":       latest.get("SSV10M"),
        "own":         False,
    }

    # Časová řada pro grafy — všechny timestampy
    series = []
    for dt in sorted(by_dt.keys()):
        elems = by_dt[dt]
        row = {"dt": dt}
        if "T"      in elems: row["temp"]     = elems["T"]
        if "H"      in elems: row["humidity"] = elems["H"]
        if "P"      in elems: row["pressure"] = elems["P"]
        if "F"      in elems: row["wind_kmh"] = ms_to_kmh(elems["F"])
        if "Fmax"   in elems: row["gust_kmh"] = ms_to_kmh(elems["Fmax"])
        if "D"      in elems: row["wind_dir"] = elems["D"]
        if "SRA10M" in elems: row["precip"]   = elems["SRA10M"]
        if "SSV10M" in elems: row["solar"]    = elems["SSV10M"]
        series.append(row)

    return obs, series


def main():
    print("\n=== ČHMÚ stanice — stažení 10minutových pozorování ===")

    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    print(f"  Datum (UTC): {today}", file=sys.stderr)

    # 1. Zjisti seznam souborů
    station_ids = list_station_ids(today)
    if not station_ids:
        print("  Žádné soubory nenalezeny — ukládám prázdný výstup", file=sys.stderr)
        _save_empty("Žádné soubory v data/ adresáři")
        return

    # 2. Metadata (jméno, souřadnice)
    metadata = load_metadata()

    # 3. Stáhni a parsuj každou stanici
    stations   = []
    all_series = {}
    ok = 0
    err = 0

    for sid in station_ids:
        url = f"{DATA_URL}10m-0-20000-0-{sid}-{today}.json"
        r = fetch(url)
        if not r:
            err += 1
            continue
        try:
            data = r.json()
        except Exception as e:
            print(f"  JSON parse error ({sid}): {e}", file=sys.stderr)
            err += 1
            continue

        obs, series = parse_station_file(sid, data)
        if obs is None:
            err += 1
            continue

        # Doplň metadata
        m = metadata.get(sid, {})
        obs["name"] = m.get("name") or f"Stanice {sid}"
        obs["lat"]  = m.get("lat")
        obs["lon"]  = m.get("lon")

        stations.append(obs)
        if series:
            all_series[obs["id"]] = {
                "name":   obs["name"],
                "lat":    obs["lat"],
                "lon":    obs["lon"],
                "series": series,
            }
        ok += 1

    print(f"  Načteno: {ok} stanic, chyba: {err}", file=sys.stderr)

    # Vyřaď stanice bez souřadnic
    with_coords    = [s for s in stations if s["lat"] is not None and s["lon"] is not None]
    without_coords = [s for s in stations if s["lat"] is None or s["lon"] is None]
    if without_coords:
        print(f"  Stanice bez souřadnic: {len(without_coords)} (skryty)", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Výstup: aktuální pozorování
    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "count": len(with_coords),
        "stations": with_coords,
    }
    path = DATA_DIR / "chmi_stations.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"  ✓ chmi_stations.json — {len(with_coords)} stanic se souřadnicemi", file=sys.stderr)

    # Výstup: časové řady
    series_out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "stations": {k: v for k, v in all_series.items()
                     if v.get("lat") is not None and v.get("lon") is not None},
    }
    path2 = DATA_DIR / "chmi_series.json"
    with open(path2, "w", encoding="utf-8") as f:
        json.dump(series_out, f, indent=2, ensure_ascii=False)
    print(f"  ✓ chmi_series.json — {len(series_out['stations'])} stanic s časovými řadami", file=sys.stderr)


def _save_empty(error_msg: str):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for fname in ("chmi_stations.json", "chmi_series.json"):
        with open(DATA_DIR / fname, "w", encoding="utf-8") as f:
            json.dump({
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "error": error_msg,
                "stations": [],
            }, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
