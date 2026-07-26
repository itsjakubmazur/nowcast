"""
Diagnostická sonda dostupnosti sítí meteostanic (ruční workflow_dispatch).

Souhrn kol 1–5:
  * ČHMÚ: 40 stanic v now/ i v denní větvi recent/, tečka. Měsíční větev má
    482 stanic, ale uzavírá se ~2 měsíce zpětně (jen klimatologie).
  * GeoSphere AT: dataset.api.hub.geosphere.at — 288 stanic, 35 u nás.
  * IMGW PL: 62 stanic bez souřadnic (id_stacji = WMO id).
  * DWD: 974 POI souborů, souřadnice v stations_list_CLIMAT_data.txt.
  * METAR s globálním bboxem vrátí jen 158 stanic — API velký výřez
    PODVZORKUJE (145 neprázdných dlaždic 10°, medián 1 stanice). Náš český
    bbox přitom vrací 19 stanic, tedy plný obsah. Jeden dotaz na svět
    nestačí a je potřeba zjistit, kde je strop.

Kolo 6: hledá cestu ke kompletním globálním datům —
  (a) bulk cache dump NOAA (jeden soubor pro celý svět),
  (b) jak počet vrácených stanic škáluje s velikostí bboxu.
"""

import gzip
import sys
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 120)
API = "https://aviationweather.gov/api/data/metar"


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def probe_bulk():
    head("(a) Bulk dump — celý svět jedním souborem?")
    cands = [
        "https://aviationweather.gov/data/cache/metars.cache.csv.gz",
        "https://aviationweather.gov/data/cache/metars.cache.xml.gz",
        "https://aviationweather.gov/api/data/metar?format=json&hours=1",
    ]
    for url in cands:
        try:
            r = requests.get(url, headers=UA, timeout=TIMEOUT)
            print(f"  {url.rsplit('/', 1)[-1][:45]}: HTTP {r.status_code}, "
                  f"{len(r.content)} B ({len(r.content) / 1_048_576:.2f} MB)")
            if not r.ok:
                continue
            body = r.content
            if url.endswith(".gz"):
                try:
                    body = gzip.decompress(body)
                    print(f"    rozbaleno: {len(body)} B "
                          f"({len(body) / 1_048_576:.2f} MB)")
                except Exception as e:
                    print(f"    gunzip selhal: {e}")
                    continue
            txt = body.decode("utf-8", "replace")
            lines = txt.splitlines()
            print(f"    řádků: {len(lines)}")
            for l in lines[:8]:
                print(f"      {l[:170]}")
        except Exception as e:
            print(f"  {url.rsplit('/', 1)[-1][:45]}: CHYBA {str(e)[:150]}")


def probe_bbox_scaling():
    """Kde API přestane vracet všechno? Měříme hustou oblast (střední Evropa)."""
    head("(b) Škálování počtu stanic s velikostí bboxu (střed 50N/15E)")
    for half in (1.5, 3, 5, 8, 12, 20, 30, 45):
        bbox = f"{50 - half},{15 - half * 1.5},{50 + half},{15 + half * 1.5}"
        try:
            r = requests.get(API, params={"bbox": bbox, "format": "json"},
                             headers=UA, timeout=TIMEOUT)
            n = len(r.json()) if r.ok else -1
            area = (2 * half) * (3 * half)
            print(f"  ±{half:>4}°  bbox {bbox:38s} → {n:5d} stanic "
                  f"({n / area:.2f} na čtvereční stupeň)")
        except Exception as e:
            print(f"  ±{half}°: CHYBA {str(e)[:120]}")


def main():
    print(f"Sonda kolo 6 — {datetime.now(timezone.utc).isoformat()}")
    for fn in (probe_bulk, probe_bbox_scaling):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__} spadlo: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
