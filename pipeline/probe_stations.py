"""
Diagnostická sonda dostupnosti dalších sítí meteostanic (ruční workflow_dispatch).

Souhrn zjištění kol 1–3 — viz probe-sources.yml běhy:
  * ČHMÚ now/: opravdu jen 40 stanic (průnik data ∩ metadata = 40, nic
    "v datech ale ne v metadatech"). meta1 je globální WMO číselník (759
    řádků včetně Reykjavíku), ne seznam českých stanic.
  * ČHMÚ recent/data/10min/: 12 měsíčních podadresářů + ~11 875 denních
    souborů; v 01/ je 482 souborů = 482 stanic. Měsíční soubory se uzavírají
    po konci měsíce (lednový má Last-Modified 2. 3. 2026).
  * GeoSphere AT: dataset.api.hub.geosphere.at, 288 stanic, 35 v našem bboxu.
  * IMGW PL: 62 stanic, bez souřadnic (id_stacji = WMO id → lze dohledat).
  * DWD: 974 POI souborů; souřadnice ve stations_list_CLIMAT_data.txt.
  * Sensor.Community: 1092 záznamů v bboxu, 491 s teplotou (levné čidla).

Kolo 4 doplňuje jediné zbývající číslo, na kterém závisí největší položka:
jak čerstvé jsou DENNÍ soubory v recent/10min? Pokud zaostávají o den, je to
pro "teď" k ničemu, ale pro zpětné hodnocení přesnosti modelů zlato.
"""

import re
import sys
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 60)
BASE = "https://opendata.chmi.cz/meteorology/climate"


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=TIMEOUT, **kw)


def main():
    print(f"Sonda kolo 4 — {datetime.now(timezone.utc).isoformat()}")
    print("=" * 70)
    print("ČHMÚ recent/data/10min — kolik stanic a jak čerstvé denní soubory")
    print("=" * 70)

    r = get(f"{BASE}/recent/data/10min/")
    if not r.ok:
        print(f"  HTTP {r.status_code}")
        return

    daily = re.findall(r'(10m-0-20000-0-(\d+)-(\d{8})\.json)', r.text)
    stations = {sid for _, sid, _ in daily}
    dates = sorted({d for _, _, d in daily})
    print(f"  denních souborů: {len(daily)}")
    print(f"  unikátních stanic: {len(stations)}")
    print(f"  rozsah dat: {dates[0]} … {dates[-1]}  ({len(dates)} dní)")

    # Jak stará jsou data za nejnovější den?
    newest = dates[-1]
    sample = [f for f, _, d in daily if d == newest][:3]
    for fn in sample:
        rr = get(f"{BASE}/recent/data/10min/{fn}", stream=True)
        lm = rr.headers.get("Last-Modified")
        print(f"  {fn}: HTTP {rr.status_code}, Last-Modified {lm}")
        # poslední časové razítko uvnitř souboru
        txt = rr.text
        stamps = re.findall(r'"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"', txt)
        if stamps:
            last = max(stamps)
            age_h = (datetime.now(timezone.utc)
                     - datetime.fromisoformat(last.replace("Z", "+00:00"))
                     ).total_seconds() / 3600
            print(f"    nejnovější měření v souboru: {last}  → stáří {age_h:.1f} h")
        rr.close()

    # Kolik stanic je v ČR (11xxx = české WMO bloky)
    cz = {s for s in stations if s.startswith("11")}
    print(f"  z toho s českým WMO blokem 11xxx: {len(cz)}")

    # Číselník k recent/ — má souřadnice pro všech 482?
    rm = get(f"{BASE}/recent/metadata/meta1-{dates[-1]}.json")
    print(f"  meta1-{dates[-1]}: HTTP {rm.status_code}")
    if rm.ok:
        try:
            values = rm.json()["data"]["data"]["values"]
            sids = {re.search(r'(\d+)$', str(v[0])).group(1)
                    for v in values if re.search(r'(\d+)$', str(v[0]))}
            print(f"    řádků: {len(values)}, unikátních ID: {len(sids)}")
            print(f"    PRŮNIK se stanicemi v datech: {len(stations & sids)}")
            print(f"    ukázka: {values[0]}")
        except Exception as e:
            print(f"    parse chyba: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! sonda spadla: {e}", file=sys.stderr)
