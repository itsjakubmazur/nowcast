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
import time
import requests
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT  = (5, 15)
BUDGET_S = 150   # tvrdý časový rozpočet na běh — opendata server umí být POMALÝ
                 # (zvednuto ze 100 s: stanic je po rozšíření 290, ne 40, takže
                 #  plný refresh by jinak trval zbytečně mnoho běhů)
                 # a pipeline jede co 5–10 min; zbytek stanic doběhne v dalších
                 # bězích (resume: hotové stanice se drží ve výstupu)

BASE   = "https://opendata.chmi.cz/meteorology/climate"
RECENT = f"{BASE}/recent/data"
HIST   = f"{BASE}/historical/data"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept":     "application/json,*/*",
}

# keep-alive spojení — TLS handshake na opendata serveru trvá sekundy
SESSION = requests.Session()

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

# Reálný tvar řádku (ověřeno v CI diagnostice):
#   ['0-20000-0-11406', 'E', '1961', '01', 'AVG', 'AVG', 4.5, '', '']
# → datum a charakteristika jsou STRINGY, hodnota je jediné skutečné ČÍSLO.
# Toho se držíme: datum = číselné stringy na začátku, charakteristika = první
# známý alfabetický token, hodnota = první buňka typu int/float.
CHAR_TOKENS = {"AVG", "MAX", "MIN", "SUM", "CNT", "MOD", "MED"}

_diag_left = 3


def fetch_json(url):
    try:
        r = SESSION.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r.json()
        if r.status_code != 404:
            print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def extract_rows(data, diag_label=""):
    """Vrátí seznam čtveřic (out_key, characteristic, dt, val)."""
    global _diag_left
    try:
        rows = data["data"]["data"]["values"]
    except (KeyError, TypeError):
        return []
    if rows and _diag_left > 0:
        print(f"  [diag] {diag_label} řádek: {rows[0]!r}", file=sys.stderr)
        _diag_left -= 1

    out = []
    for row in rows:
        if len(row) < 4:
            continue
        spec = ELEMENTS.get(row[1])
        if spec is None:
            continue
        date_parts, char, val = [], None, None
        for cell in row[2:]:
            if isinstance(cell, (int, float)) and not isinstance(cell, bool):
                val = float(cell)
                break                      # hodnota = první skutečné číslo
            if not isinstance(cell, str) or cell == "":
                continue
            token = cell.strip()
            if token.upper() in CHAR_TOKENS:
                if char is None:
                    char = token.upper()   # první charakteristika (AVG/MAX/…)
            elif re.fullmatch(r"\d{1,4}", token) and len(date_parts) < 3 and char is None:
                date_parts.append(token.zfill(2) if len(token) < 4 else token)
            elif re.fullmatch(r"\d{4}-\d{2}(-\d{2})?([ T].*)?", token) and not date_parts:
                date_parts = [token[:10]]
        if val is None or not date_parts:
            continue
        dt = date_parts[0] if len(date_parts[0]) > 4 else "-".join(date_parts)
        key, mult = spec
        out.append((key, char or "", dt, val * mult))
    return out


# rekord = extrémní charakteristika; normál/průměr = AVG (u úhrnů SUM)
REC_CHAR = {"temp_max": "MAX", "temp_min": "MIN", "gust_kmh": "MAX",
            "snow_cm": "MAX", "precip": "SUM", "sunshine_h": "SUM"}
AVG_CHAR = {"temp_max": "AVG", "temp_min": "AVG", "temp_avg": "AVG",
            "precip": "SUM", "sunshine_h": "SUM", "snow_cm": "MAX", "gust_kmh": "MAX"}


def compute_records(rows):
    records = {}
    for key, want in REC_CHAR.items():
        cand = [(dt, v) for k, c, dt, v in rows if k == key and (c == want or not c)]
        if not cand:
            cand = [(dt, v) for k, c, dt, v in rows if k == key]
        if not cand:
            continue
        best = min(cand, key=lambda x: x[1]) if key == "temp_min" \
            else max(cand, key=lambda x: x[1])
        records[key] = {"value": round(best[1], 1), "date": best[0][:10]}
    return records


def compute_monthly_normals(rows):
    buckets = defaultdict(lambda: defaultdict(list))
    for k, c, dt, v in rows:
        want = AVG_CHAR.get(k)
        if want and c and c != want:
            continue
        try:
            m = int(dt[5:7])
        except (ValueError, IndexError):
            continue
        buckets[m][k].append(v)
    normals = {}
    for month in range(1, 13):
        normals[month] = {}
        for key, arr in buckets[month].items():
            if arr:
                normals[month][key] = round(sum(arr) / len(arr), 2)
    return normals


def yearly_trend_from_yrs(rows):
    """yrs soubor: roční charakteristiky — AVG(TPM), MAX(TMA), MIN(TMI), SUM(SRA)."""
    WANT = {("temp_avg", "AVG"): "temp_avg", ("temp_max", "MAX"): "temp_max",
            ("temp_min", "MIN"): "temp_min", ("precip", "SUM"): "precip_total"}
    trend = defaultdict(dict)
    for k, c, dt, v in rows:
        out = WANT.get((k, c or ""))
        if out is None and not c:
            out = {"temp_avg": "temp_avg", "precip": "precip_total"}.get(k)
        y = dt[:4]
        if out and y.isdigit():
            trend[y][out] = round(v, 1)
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
PARSER_V = 2         # bump = zahodit uložené stanice (změna parsování hodnot)


def main():
    print("\n=== ČHMÚ statistiky — rekordy / normály / roční trend ===", file=sys.stderr)

    now_utc = datetime.now(timezone.utc)
    yyyymm = now_utc.strftime("%Y%m")
    stats_path = DATA_DIR / "chmi_stats.json"

    wsis = load_station_ids()
    if not wsis:
        print("  chmi_stations.json chybí/prázdný — nejdřív musí běžet chmi.py", file=sys.stderr)
        return

    # Resume: už zpracované stanice z minulého souboru drž, nové dobírej
    # v rozpočtu. Za pár běhů jsou hotové všechny; KOMPLETNÍ soubor se pak
    # obnovuje nejvýš 1× za CACHE_MAX_AGE_H (drží ho CI cache mezi běhy).
    all_stats = {}
    file_age_h = None
    if stats_path.exists():
        file_age_h = (now_utc.timestamp() - stats_path.stat().st_mtime) / 3600
        try:
            prev = json.loads(stats_path.read_text())
            if prev.get("parser_v") == PARSER_V:
                all_stats = prev.get("stations", {})
            else:
                print("  Starší verze parseru — uložené stanice zahazuji", file=sys.stderr)
        except Exception:
            all_stats = {}
    pending = [w for w in wsis if w not in all_stats]
    if not pending:
        if file_age_h is not None and file_age_h < CACHE_MAX_AGE_H:
            print(f"  Kompletní ({len(all_stats)} stanic), {file_age_h:.1f} h starý — přeskočeno", file=sys.stderr)
            return
        pending = wsis          # plný refresh po vypršení stáří
        all_stats = {}
    print(f"  Stanic: {len(wsis)} (hotovo {len(all_stats)}, zbývá {len(pending)}), "
          f"rozpočet {BUDGET_S} s", file=sys.stderr)

    t_start = time.monotonic()
    ok = 0
    for wsi in pending:
        if time.monotonic() - t_start > BUDGET_S:
            print(f"  Rozpočet {BUDGET_S} s vyčerpán — zbytek doběhne příště "
                  f"({len(all_stats)} stanic zatím)", file=sys.stderr)
            break
        merged = []   # měsíční + denní řádky (historical + recent)
        for url in (f"{HIST}/monthly/mly-{wsi}.json",
                    f"{RECENT}/monthly/mly-{wsi}.json"):
            d = fetch_json(url)
            if d:
                merged.extend(extract_rows(d, "mly"))

        yrs_rows = []
        d = fetch_json(f"{HIST}/yearly/yrs-{wsi}.json")
        if d:
            yrs_rows = extract_rows(d, "yrs")

        # denní data aktuálního měsíce — ať čerstvý rekord nečeká na konec měsíce
        d = fetch_json(f"{RECENT}/daily/dly-{wsi}-{yyyymm}.json")
        if d:
            merged.extend(extract_rows(d, "dly"))

        if not merged:
            # zapamatuj si i "bez dat" — jinak by se stanice zkoušela každý běh
            all_stats[wsi] = {"records": {}, "monthly_normals": {}, "yearly_trend": {}}
            continue

        all_stats[wsi] = {
            "records":         compute_records(merged),
            "monthly_normals": {str(k): v for k, v in compute_monthly_normals(merged).items() if v},
            "yearly_trend":    yearly_trend_from_yrs(yrs_rows),
        }
        ok += 1
        print(f"  ✓ {wsi}: {len(merged)} hodnot, "
              f"{len(all_stats[wsi]['yearly_trend'])} roků trendu, "
              f"rekordy: {list(all_stats[wsi]['records'])}", file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(json.dumps({
        "generated_at_utc": now_utc.isoformat(),
        "parser_v": PARSER_V,
        "stations": all_stats,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"\n  ✓ chmi_stats.json — {ok}/{len(wsis)} stanic s historickými daty", file=sys.stderr)


if __name__ == "__main__":
    main()
