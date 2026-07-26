"""Sonda: kontrola NASAZENÝCH dat (ruční workflow_dispatch, nic nezapisuje).

Doložená zjištění:
  * ČHMÚ opendata je čistě česká — oficiální popis mluví o síti ve správě
    ČHMÚ a spolupracujících subjektů, naměřený rozsah 48,6–51,0 N /
    12,2–18,8 E, mimo ČR ani jedna stanice.
  * v now/data/ je 476 stanic; podle katalogu meta2 měří teplotu vzduchu
    (prvek T) 296 z nich — 40 WMO + 256 národních.
  * svět pokrývá METAR bulk (~5000 stanic).
"""
import sys
from datetime import datetime, timezone
from math import radians, sin, cos, asin, sqrt
import requests

UA = {"User-Agent": "nowcast-probe/1.0"}
PAGES = "https://itsjakubmazur.github.io/nowcast/data"


def hav(a, b, c, d):
    p1, p2 = radians(a), radians(c)
    return 2 * 6371 * asin(sqrt(sin((p2 - p1) / 2) ** 2
                                + cos(p1) * cos(p2) * sin(radians(d - b) / 2) ** 2))


def main():
    print(f"Nasazená data — {datetime.now(timezone.utc).isoformat()}")
    r = requests.get(f"{PAGES}/chmi_stations.json", headers=UA, timeout=(10, 60))
    print(f"chmi_stations.json: HTTP {r.status_code}, {len(r.content)} B")
    if not r.ok:
        return
    j = r.json()
    print(f"  generated_at_utc: {j.get('generated_at_utc')}")
    st = [s for s in j.get("stations", []) if s.get("temp") is not None]
    print(f"  stanic: {j.get('count')}, s teplotou: {len(st)}")
    if st:
        lats = [s["lat"] for s in st]; lons = [s["lon"] for s in st]
        print(f"  rozsah: {min(lats):.2f}–{max(lats):.2f} N, {min(lons):.2f}–{max(lons):.2f} E")
        for name, la, lo in (("Rychvald", 49.86, 18.36), ("Brno", 49.20, 16.61),
                             ("Praha", 50.08, 14.42), ("Vendryně", 49.66, 18.72)):
            d, s = sorted(((hav(la, lo, x["lat"], x["lon"]), x) for x in st),
                          key=lambda t: t[0])[0]
            print(f"  {name:10s} {str(s['name'])[:26]:28s} {d:5.1f} km  "
                  f"{s['temp']} °C  {s.get('elev')} m")
    for name in ("chmi_rain.json", "metar/index.json"):
        rr = requests.get(f"{PAGES}/{name}", headers=UA, timeout=(10, 60))
        print(f"{name}: HTTP {rr.status_code}"
              + (f" — {rr.json().get('count') or rr.json().get('stations')} položek" if rr.ok else ""))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
