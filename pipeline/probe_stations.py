"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

Ověřuje NASAZENÝ web, ne jen to, co si myslíme, že pipeline udělala.

Doložená zjištění z předchozích kol:
  * ČHMÚ opendata je čistě česká. Oficiální popis (Klimatologicka_data_popis.pdf)
    mluví o "síti meteorologických pozemních stanic ve správě ČHMÚ a dalších
    spolupracujících subjektů", nic o zahraničí, a naměřený rozsah stanic je
    48,6–51,0 N / 12,2–18,8 E — mimo ČR ani jedna.
  * V now/data/ je 476 stanic (436 národních 0-203-0 + 40 WMO 0-20000-0).
    Podle katalogu prvků meta2 měří teplotu vzduchu (prvek T) 296 z nich.
  * Celý svět pokrývá METAR bulk (~5000 stanic).
"""

import sys
from datetime import datetime, timezone
from math import radians, sin, cos, asin, sqrt

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
T = (15, 60)
PAGES = "https://itsjakubmazur.github.io/nowcast/data"


def get(u):
    return requests.get(u, headers=UA, timeout=T)


def hav(a, b, c, d):
    p1, p2 = radians(a), radians(c)
    return 2 * 6371 * asin(sqrt(sin((p2 - p1) / 2) ** 2
                                + cos(p1) * cos(p2) * sin(radians(d - b) / 2) ** 2))


def main():
    print(f"Sonda — nasazená data, {datetime.now(timezone.utc).isoformat()}")
    print("=" * 70)

    r = get(f"{PAGES}/chmi_stations.json")
    print(f"chmi_stations.json: HTTP {r.status_code}, {len(r.content)} B")
    if r.ok:
        j = r.json()
        st = [s for s in j.get("stations", []) if s.get("temp") is not None]
        print(f"  stanic celkem: {j.get('count')}, s teplotou: {len(st)}")
        lats = [s["lat"] for s in st if s.get("lat") is not None]
        lons = [s["lon"] for s in st if s.get("lon") is not None]
        if lats:
            print(f"  rozsah: {min(lats):.2f}–{max(lats):.2f} N, "
                  f"{min(lons):.2f}–{max(lons):.2f} E")
        elevs = [s["elev"] for s in st if s.get("elev") is not None]
        if elevs:
            print(f"  nadmořská výška: {min(elevs):.0f}–{max(elevs):.0f} m")
        # Jak daleko a jak vysoko je nejbližší teplotní stanice?
        for name, la, lo in (("Rychvald", 49.86, 18.36), ("Brno", 49.20, 16.61),
                             ("Praha", 50.08, 14.42), ("Vendryně", 49.66, 18.72)):
            near = sorted(((hav(la, lo, s["lat"], s["lon"]), s) for s in st),
                          key=lambda x: x[0])[:1]
            if near:
                d, s = near[0]
                print(f"  {name:10s} {str(s['name'])[:26]:28s} {d:5.1f} km  "
                      f"{s['temp']} °C  {s.get('elev')} m")

    for name in ("chmi_rain.json", "metar/index.json"):
        rr = get(f"{PAGES}/{name}")
        if rr.ok:
            jj = rr.json()
            print(f"{name}: HTTP 200 — "
                  f"{jj.get('count') or jj.get('stations')} položek")
        else:
            print(f"{name}: HTTP {rr.status_code}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
