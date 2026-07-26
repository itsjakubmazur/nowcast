"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

Souhrn kol 1–6 (zdroje stanic):
  * ČHMÚ: 40 stanic v now/ i v denní větvi recent/. Měsíční větev má 482
    stanic, ale uzavírá se ~2 měsíce zpětně (jen klimatologie).
  * GeoSphere AT: dataset.api.hub.geosphere.at — 288 stanic, 35 u nás.
  * IMGW PL: 62 stanic bez souřadnic (id_stacji = WMO id).
  * DWD: 974 POI souborů, souřadnice v stations_list_CLIMAT_data.txt.
  * METAR JSON API výřezy nad ~10° PODVZORKUJE (celý svět = 158 stanic),
    ale bulk metars.cache.csv.gz dá ~5000 stanic jedním requestem.

Kolo 7 už neověřuje zdroje, ale NÁS: opravdu se celosvětové dlaždice
dostanou až na nasazený web? Krok metar.py v CI trvá pod sekundu, což vypadá
podezřele, a z Claude Code sandboxu jsou Pages za proxy (403) — takže tohle
je jediný způsob, jak si to potvrdit, a ne jen doufat.
"""

import json
import sys
from datetime import datetime, timezone

import requests

PAGES = "https://itsjakubmazur.github.io/nowcast/data"
UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 60)


def main():
    print(f"Sonda kolo 7 — {datetime.now(timezone.utc).isoformat()}")
    print("=" * 70)
    print("Dorazily světové dlaždice METAR na nasazený web?")
    print("=" * 70)

    r = requests.get(f"{PAGES}/metar/index.json", headers=UA, timeout=TIMEOUT)
    print(f"  index.json: HTTP {r.status_code}, {len(r.content)} B")
    if not r.ok:
        print("  → dlaždice na Pages NEJSOU")
        return
    idx = r.json()
    tiles = idx.get("tiles", [])
    print(f"  generated_at_utc: {idx.get('generated_at_utc')}")
    print(f"  tile_deg={idx.get('tile_deg')} margin_deg={idx.get('margin_deg')}")
    print(f"  stanic celkem: {idx.get('stations')}, dlaždic: {len(tiles)}")
    top = sorted(tiles, key=lambda t: -t["count"])[:5]
    print(f"  největší dlaždice: {[(t['tile'], t['count']) for t in top]}")

    # Konkrétní místa: stáhni dlaždici tak, jak by to udělal prohlížeč,
    # a zkontroluj, že v ní je stanice do 40 km (to je limit hledání v UI).
    def tile_id(lat, lon):
        tx = int((((lon + 180) % 360) + 360) % 360 / 10) % 36
        ty = min(17, max(0, int((lat + 90) // 10)))
        return f"{ty}_{tx}"

    def hav(a, b, c, d):
        from math import radians, sin, cos, asin, sqrt
        p1, p2 = radians(a), radians(c)
        return 2 * 6371 * asin(sqrt(sin((p2 - p1) / 2) ** 2 + cos(p1) * cos(p2)
                               * sin(radians(d - b) / 2) ** 2))

    print()
    for name, lat, lon in (("New York", 40.71, -74.01), ("Tokio", 35.68, 139.69),
                           ("Sydney", -33.87, 151.21), ("Nairobi", -1.29, 36.82),
                           ("São Paulo", -23.55, -46.63), ("Reykjavík", 64.13, -21.90),
                           ("Rychvald", 49.86, 18.36), ("Brno", 49.20, 16.61),
                           ("uprostřed Pacifiku", 0.0, -150.0)):
        tid = tile_id(lat, lon)
        rr = requests.get(f"{PAGES}/metar/{tid}.json", headers=UA, timeout=TIMEOUT)
        if not rr.ok:
            print(f"  {name:20s} {tid:6s} HTTP {rr.status_code} — žádná dlaždice")
            continue
        st = rr.json().get("stations", [])
        near = min(((hav(lat, lon, s["lat"], s["lon"]), s) for s in st),
                   default=(None, None), key=lambda x: x[0])
        d, s = near
        mark = "✓" if d is not None and d <= 40 else "·"
        print(f"  {mark} {name:20s} {tid:6s} {len(st):4d} stanic, nejbližší "
              f"{(s or {}).get('name', '—'):22s} {d:6.1f} km  "
              f"{(s or {}).get('temp')}°C" if d is not None else
              f"  · {name:20s} {tid:6s} prázdná")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! sonda spadla: {e}", file=sys.stderr)
