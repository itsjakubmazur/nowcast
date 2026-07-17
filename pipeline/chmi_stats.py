"""
ČHMÚ historická a statistická data (rekordy, normály, roční trend).

Podle oficiální dokumentace "Popis základních klimatologických dat" (červen 2024):
  recent/data/daily/     dly-{WSI}-{YYYYMM}.json   — denní data aktuálního měsíce
  recent/data/monthly/   mly-{WSI}.json            — měsíční data aktuálního roku
  historical/data/monthly/ mly-{WSI}.json          — měsíční data (od začátku měření)
  historical/data/yearly/  yrs-{WSI}.json          — roční charakteristiky

Kódy prvků (dokumentace, tabulka daily/monthly):
  TMA=max teplota, TMI=min teplota, TPM=průměrná teplota, SRA=srážky,
  Fmax=max náraz větru (m/s), SCE=celková sněhová pokrývka, SSV=sluneční svit
(Dřívější pokus používal neexistující kódy TMX/TMN/TME/RR — proto byla data prázdná.)

Výstup: data/chmi_stats.json — per stanice: records, monthly_normals, yearly_trend.
Rekordy jsou z MĚSÍČNÍCH charakteristik (malé soubory; denní historie za celé
období měření by byla řádově MB na stanici) — SRA/SSV rekord je tedy "za měsíc",
TMA/TMI/Fmax/SCE jsou skutečná absolutní maxima/minima (měsíční hodnota = extrém dne).
"""

import json
import sys
import re
import requests
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = 30

BASE   = "https://opendata.chmi.cz/meteorology/climate"
RECENT = f"{BASE}/recent/data"
HIST   = f"{BASE}/historical/data"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept":     "application/json,*/*",
}

MS_TO_KMH = 3.6

# prvek → (klíč ve výstupu, násobič)
ELEMENTS = {
    "TMA":  ("temp_max",   1),
    "TMI":  ("temp_min",   1),
    "TPM":  ("temp_avg",   1),
    "SRA":  ("precip",     1),
    "Fmax": ("gust_kmh",   MS_TO_KMH),
    "SCE":  ("snow_cm",    1),
    "SSV":  ("sunshine_h", 1),
}

_logged_shape = False


def fetch_json(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r.json()
        if r.status_code != 404:
            print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def extract_values(data):
    """
    Z pivot JSON (data.data.values, řádek [WSI, ELEMENT, DT, VALUE, (FLAG…)])
    vrátí {out_key: [(dt, val), ...]}. Hodnotu hledá adaptivně — první číselný
    sloupec za DT (kdyby ČHMÚ vložilo sloupec navíc, ať to nespadne potichu).
    """
    global _logged_shape
    result = defaultdict(list)
    try:
        rows = data["data"]["data"]["values"]
    except (KeyError, TypeError):
        return result

    if rows and not _logged_shape:
        print(f"  [diag] tvar řádku: {rows[0]!r}", file=sys.stderr)
        _logged_shape = True

    for row in rows:
        if len(row) < 4:
            continue
        element, dt = row[1], row[2]
        spec = ELEMENTS.get(element)
        if spec is None or dt is None:
            continue
        val = None
        for cell in row[3:]:
            if cell is None or cell == "":
                continue
            try:
                val = float(cell)
                break
            except (TypeError, ValueError):
                continue  # textový FLAG sloupec — hledej dál
        if val is None:
            continue
        key, mult = spec
        result[key].append((str(dt), val * mult))
    return result


MAX_KEYS = {"temp_max", "precip", "gust_kmh", "snow_cm", "sunshine_h"}


def compute_records(vals):
    records = {}
    for key, pairs in vals.items():
        if not pairs or key == "temp_avg":
            continue
        best = max(pairs, key=lambda x: x[1]) if key in MAX_KEYS \
            else min(pairs, key=lambda x: x[1])
        records[key] = {"value": round(best[1], 1), "date": best[0][:10]}
    return records


def compute_monthly_normals(vals):
    buckets = defaultdict(lambda: defaultdict(list))
    for key, pairs in vals.items():
        for dt, val in pairs:
            try:
                m = int(dt[5:7])
            except (ValueError, IndexError):
                continue
            buckets[m][key].append(val)
    normals = {}
    for month in range(1, 13):
        normals[month] = {}
        for key, arr in buckets[month].items():
            if arr:
                normals[month][key] = round(sum(arr) / len(arr), 2)
    return normals


def yearly_trend_from_yrs(vals):
    """yrs soubor: jeden záznam prvku na rok — přímo roční charakteristiky."""
    trend = defaultdict(dict)
    for key, pairs in vals.items():
        for dt, val in pairs:
            y = dt[:4]
            if not y.isdigit():
                continue
            out = {"temp_avg": "temp_avg", "temp_max": "temp_max",
                   "temp_min": "temp_min", "precip": "precip_total"}.get(key)
            if out:
                trend[y][out] = round(val, 1)
    return dict(sorted(trend.items()))


def load_station_ids():
    path = DATA_DIR / "chmi_stations.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return [s["id"] for s in data.get("stations", []) if s.get("id")]
    except Exception:
        return []


CACHE_MAX_AGE_H = 6  # přegenerovat jen když je soubor starší (drží ho CI cache)


def main():
    print("\n=== ČHMÚ statistiky — rekordy / normály / roční trend ===", file=sys.stderr)

    now_utc = datetime.now(timezone.utc)
    yyyymm = now_utc.strftime("%Y%m")
    stats_path = DATA_DIR / "chmi_stats.json"
    if stats_path.exists():
        age_h = (now_utc.timestamp() - stats_path.stat().st_mtime) / 3600
        if age_h < CACHE_MAX_AGE_H:
            print(f"  chmi_stats.json je {age_h:.1f} h starý — přeskočeno", file=sys.stderr)
            return
        print(f"  chmi_stats.json je {age_h:.1f} h starý — regeneruji", file=sys.stderr)

    wsis = load_station_ids()
    if not wsis:
        print("  chmi_stations.json chybí/prázdný — nejdřív musí běžet chmi.py", file=sys.stderr)
        return
    print(f"  Zpracovávám {len(wsis)} stanic…", file=sys.stderr)

    all_stats = {}
    ok = 0
    for wsi in wsis:
        merged = defaultdict(list)   # měsíční řady (historical + recent)
        for url in (f"{HIST}/monthly/mly-{wsi}.json",
                    f"{RECENT}/monthly/mly-{wsi}.json"):
            d = fetch_json(url)
            if d:
                for k, pairs in extract_values(d).items():
                    merged[k].extend(pairs)

        yrs_vals = defaultdict(list)
        d = fetch_json(f"{HIST}/yearly/yrs-{wsi}.json")
        if d:
            yrs_vals = extract_values(d)

        # denní data aktuálního měsíce — ať čerstvý rekord nečeká na konec měsíce
        d = fetch_json(f"{RECENT}/daily/dly-{wsi}-{yyyymm}.json")
        if d:
            for k, pairs in extract_values(d).items():
                merged[k].extend(pairs)

        if not any(merged.values()):
            continue

        all_stats[wsi] = {
            "records":         compute_records(merged),
            "monthly_normals": {str(k): v for k, v in compute_monthly_normals(merged).items() if v},
            "yearly_trend":    yearly_trend_from_yrs(yrs_vals),
        }
        ok += 1
        n = sum(len(v) for v in merged.values())
        print(f"  ✓ {wsi}: {n} měsíčních/denních hodnot, "
              f"{len(all_stats[wsi]['yearly_trend'])} roků trendu", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(json.dumps({
        "generated_at_utc": now_utc.isoformat(),
        "stations": all_stats,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"\n  ✓ chmi_stats.json — {ok}/{len(wsis)} stanic s historickými daty", file=sys.stderr)


if __name__ == "__main__":
    main()
