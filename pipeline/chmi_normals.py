"""
Klimatické normály 1991–2020 po stanicích.

Řeší známou díru: chmi_stats.py zpracuje ~290 stanic, ale rekordy a normály má
jen 40 — národní stanice (0-203-0-*) v climate/historical/ archiv nemají.
Normály pro ně ale existují jinde, v products/climate_normal_stations/, a to
včetně 0-203-0 identifikátorů.

Ověřeno sondou (běh 30219251405):
  period_1991_2020/precipitation/{WSI}_SRA_1991_2020_normal.csv        573 souborů
  period_1991_2020/temperature/{WSI}_{T,TMA,TMI}_1991_2020_normal.csv  481 souborů
  obsah: Eg.Gh.Id,Eg.El.Abbreviation,Month,Normal.SUM|Normal.AVG + 12 řádků

Data jsou STATICKÁ (období 1991–2020). Stáhnou se tedy jednou a další běhy
skončí hned na kontrole "co ještě chybí" — provozní náklad po naplnění nula.

Výstup: data/chmi_normals.json
"""

import csv
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = ("https://opendata.chmi.cz/meteorology/products/"
        "climate_normal_stations/period_1991_2020")
PERIOD = "1991_2020"
TIMEOUT = (5, 20)
BUDGET_S = 120       # stejný vzor jako chmi_stats.py — zbytek doběhne příště
MAX_WORKERS = 12
ELEMENTS = {"temperature": ("T", "TMA", "TMI"), "precipitation": ("SRA",)}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def read_station_list(kind: str) -> dict:
    """
    Vrátí {WSI: {name, lat, lon, elev}}.

    Ty dva seznamy NEJSOU ve stejném formátu (ověřeno na obsahu):
      precipitation_...csv → oddělovač ',', desetinná tečka
      temperature_...csv   → oddělovač ';', desetinná ČÁRKA, navíc BOM
    Formát se proto zjišťuje z hlavičky, ne podle názvu souboru — kdyby to
    ČHMÚ někdy sjednotilo, ať to nepřestane fungovat.
    """
    url = f"{BASE}/{kind}_{PERIOD}_list_of_stations.csv"
    r = SESSION.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    txt = r.content.decode("utf-8-sig")
    head = txt.splitlines()[0]
    delim = ";" if head.count(";") > head.count(",") else ","
    dec_comma = delim == ";"

    def num(s):
        s = (s or "").strip()
        if not s:
            return None
        try:
            return float(s.replace(",", ".") if dec_comma else s)
        except ValueError:
            return None

    out = {}
    for row in csv.DictReader(io.StringIO(txt), delimiter=delim):
        wsi = (row.get("WSI") or "").strip()
        if not wsi:
            continue
        # GEOGR1 = zeměpisná DÉLKA, GEOGR2 = ŠÍŘKA (Cheb 12,39 E / 50,07 N).
        # Stejné pořadí jako v climate/now/metadata/, kde to appka už čte.
        out[wsi] = {
            "name": (row.get("FULL_NAME") or "").strip(),
            "lon": num(row.get("GEOGR1")),
            "lat": num(row.get("GEOGR2")),
            "elev": num(row.get("ELEVATION")),
        }
    return out


def fetch_normal(kind: str, wsi: str, element: str) -> list | None:
    """12 měsíčních hodnot, nebo None. Chybějící měsíc zůstane None, ne nula."""
    url = f"{BASE}/{kind}/{wsi}_{element}_{PERIOD}_normal.csv"
    try:
        r = SESSION.get(url, timeout=TIMEOUT)
        if not r.ok:
            return None
        vals = [None] * 12
        for row in csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))):
            # poslední sloupec je Normal.AVG (teploty) nebo Normal.SUM (srážky)
            key = next((k for k in row if k and k.startswith("Normal.")), None)
            if not key:
                continue
            try:
                m = int(row["Month"])
            except (KeyError, TypeError, ValueError):
                continue
            raw = (row.get(key) or "").strip()
            if 1 <= m <= 12 and raw:
                try:
                    vals[m - 1] = float(raw.replace(",", "."))
                except ValueError:
                    pass
        return vals if any(v is not None for v in vals) else None
    except Exception:
        return None


def main():
    out_path = DATA_DIR / "chmi_normals.json"
    stations = {}
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text())
            if prev.get("period") == PERIOD:
                stations = prev.get("stations", {})
        except Exception:
            stations = {}

    jobs = []
    for kind, elements in ELEMENTS.items():
        try:
            meta = read_station_list(kind)
        except Exception as e:
            print(f"chmi_normals.py: seznam {kind} selhal: {e}", file=sys.stderr)
            continue
        print(f"  {kind}: {len(meta)} stanic v seznamu")
        for wsi, info in meta.items():
            st = stations.setdefault(wsi, {"normals": {}})
            st.setdefault("normals", {})
            for k, v in info.items():
                if v is not None:
                    st[k] = v
            for el in elements:
                if el not in st["normals"]:
                    jobs.append((kind, wsi, el))

    if not jobs:
        keep = {w: s for w, s in stations.items() if s.get("normals")}
        print(f"chmi_normals.py: hotovo, {len(keep)} stanic — nic ke stažení")
        if keep and not out_path.exists():
            _save(out_path, keep)
        return

    print(f"  ke stažení: {len(jobs)} řad (rozpočet {BUDGET_S} s)")
    t0, done = time.time(), 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_normal, k, w, e): (w, e) for k, w, e in jobs}
        for fut in as_completed(futures):
            wsi, el = futures[fut]
            try:
                vals = fut.result()
            except Exception:
                vals = None
            if vals:
                stations[wsi].setdefault("normals", {})[el] = vals
                done += 1
            if time.time() - t0 > BUDGET_S:
                # Rozpočet došel — zbytek doběhne v některém z dalších běhů.
                for f in futures:
                    f.cancel()
                break

    keep = {w: s for w, s in stations.items()
            if s.get("normals") and s.get("lat") is not None and s.get("lon") is not None}
    _save(out_path, keep)
    print(f"chmi_normals.py: +{done} řad, celkem {len(keep)} stanic, "
          f"zbývá ~{max(0, len(jobs) - done)}, "
          f"{out_path.stat().st_size / 1024:.0f} kB")


def _save(path: Path, stations: dict) -> None:
    path.write_text(json.dumps(
        {"period": PERIOD,
         "generated_at_utc": datetime.now(timezone.utc).isoformat(),
         "count": len(stations),
         "elements": sorted({e for s in stations.values() for e in s.get("normals", {})}),
         "stations": stations},
        ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
