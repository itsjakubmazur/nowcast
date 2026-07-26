"""
Diagnostická sonda dostupnosti sítí meteostanic (ruční workflow_dispatch).

Souhrn kol 1–4:
  * ČHMÚ now/ i recent/ denní: 40 stanic, tečka. meta1 je globální WMO
    číselník (759 řádků včetně Reykjavíku), ne seznam českých stanic.
    Měsíční větev recent/ má 482 stanic, ale uzavírá se ~2 měsíce zpětně.
  * GeoSphere AT: dataset.api.hub.geosphere.at — 288 stanic, 35 u nás.
  * IMGW PL: 62 stanic bez souřadnic (id_stacji = WMO id).
  * DWD: 974 POI souborů, souřadnice v stations_list_CLIMAT_data.txt.
  * Sensor.Community: 1092 v bboxu, 491 s teplotou — levná čidla, do
    hodnocení přesnosti nepatří.

Kolo 5 řeší celosvětové pokrytí. METAR už parsujeme, ale uměle ho ořezáváme
českým bboxem — přitom je globální. Otázka je jen, jak velká ta data jsou
a jestli je rozumnější je servírovat staticky (dlaždice) nebo přes worker.
"""

import json
import sys
from collections import Counter
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 120)
API = "https://aviationweather.gov/api/data/metar"


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def main():
    print(f"Sonda kolo 5 — {datetime.now(timezone.utc).isoformat()}")

    head("METAR globálně — kolik stanic a kolik to váží")
    r = requests.get(API, params={"bbox": "-90,-180,90,180", "format": "json"},
                     headers=UA, timeout=TIMEOUT)
    print(f"  HTTP {r.status_code}, {len(r.content)} B "
          f"({len(r.content) / 1_048_576:.1f} MB)")
    print(f"  Content-Encoding: {r.headers.get('Content-Encoding')}")
    print(f"  CORS Access-Control-Allow-Origin: "
          f"{r.headers.get('Access-Control-Allow-Origin')!r}")
    if not r.ok:
        print(f"  tělo: {r.text[:300]}")
        return
    arr = r.json()
    print(f"  hlášení: {len(arr)}")
    uniq = {m.get("icaoId") for m in arr if m.get("icaoId")}
    with_t = [m for m in arr if m.get("temp") is not None and m.get("lat") is not None]
    print(f"  unikátních ICAO: {len(uniq)}, s teplotou i souřadnicí: {len(with_t)}")

    # Jak by vypadal náš kompaktní tvar?
    compact = [{
        "id": m.get("icaoId"), "lat": round(float(m["lat"]), 3),
        "lon": round(float(m["lon"]), 3), "t": m.get("temp"),
        "w": m.get("wspd"), "d": m.get("wdir"), "e": m.get("elev"),
    } for m in with_t[:2000]]
    blob = json.dumps(compact, separators=(",", ":"))
    per = len(blob) / max(1, len(compact))
    print(f"  kompaktní tvar: {per:.0f} B/stanice → "
          f"celkem ~{per * len(with_t) / 1024:.0f} kB nekomprimovaně")

    head("Rozložení do dlaždic 10° (kolik dlaždic je neprázdných)")
    tiles = Counter()
    for m in with_t:
        tx = int((float(m["lon"]) + 180) // 10)
        ty = int((float(m["lat"]) + 90) // 10)
        tiles[(tx, ty)] += 1
    print(f"  neprázdných dlaždic: {len(tiles)} (z 648 možných)")
    counts = sorted(tiles.values(), reverse=True)
    print(f"  největší dlaždice: {counts[:10]}")
    print(f"  medián: {counts[len(counts) // 2]}, průměr: {sum(counts) / len(counts):.0f}")
    print(f"  → typická dlaždice ≈ {per * counts[len(counts) // 2] / 1024:.1f} kB, "
          f"největší ≈ {per * counts[0] / 1024:.0f} kB")

    head("Kontrola pokrytí na pár světových místech")
    for name, lat, lon in (("New York", 40.71, -74.01), ("Tokio", 35.68, 139.69),
                           ("Sydney", -33.87, 151.21), ("Nairobi", -1.29, 36.82),
                           ("São Paulo", -23.55, -46.63), ("Rychvald", 49.86, 18.36)):
        near = [m for m in with_t
                if abs(float(m["lat"]) - lat) < 0.9 and abs(float(m["lon"]) - lon) < 0.9]
        best = min(near, key=lambda m: (float(m["lat"]) - lat) ** 2
                   + (float(m["lon"]) - lon) ** 2, default=None)
        if best:
            print(f"  {name:12s}: {len(near):3d} stanic do ~100 km, "
                  f"nejbližší {best.get('icaoId')} {best.get('temp')}°C")
        else:
            print(f"  {name:12s}: nic v okolí")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! sonda spadla: {e}", file=sys.stderr)
