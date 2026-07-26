"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

Souhrn kol 1–9:
  * ČHMÚ publikuje 476 stanic (436 národních srážkoměrů 0-203-0 + 40 WMO
    0-20000-0), ne 40 — moje dřívější číslo byl artefakt regexu na prefix.
    Národní stanice mají jen SRA10M (srážky). Souřadnice pro všechny v meta1
    (GEOGR1 = longituda, GEOGR2 = latituda). Rozsah 48.6–51.0 N / 12.2–18.8 E
    → nic za hranicemi; ČHMÚ celosvětová staniční data NEMÁ.
  * METAR bulk metars.cache.csv.gz = ~5000 stanic celého světa, hotovo.

Kolo 10 ověřuje datové tvary sousedských sítí, aby se dala napsat
implementace, a ne odhad:
  (a) GeoSphere AT — metadata jsem ověřil, ale DATA endpoint ne,
  (b) IMGW PL — jde id_stacji spojit se souřadnicemi z Meteostat číselníku?
  (c) DWD — jde POI soubor spojit se souřadnicemi z CLIMAT seznamu?
"""

import gzip
import json
import re
import sys
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
T = (15, 90)
LAT0, LON0, LAT1, LON1 = 48.3, 11.8, 51.3, 19.2


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def get(u):
    return requests.get(u, headers=UA, timeout=T)


def inb(lat, lon):
    return lat is not None and lon is not None and \
        LAT0 <= lat <= LAT1 and LON0 <= lon <= LON1


def f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def probe_geosphere():
    head("(a) GeoSphere AT — tvar DATA endpointu (metadata už ověřena)")
    base = "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min"
    r = get(f"{base}/metadata")
    if not r.ok:
        print(f"  metadata HTTP {r.status_code}")
        return
    st = r.json().get("stations", [])
    near = [s for s in st if inb(f(s.get("lat")), f(s.get("lon")))]
    ids = [str(s.get("id")) for s in near if s.get("id") is not None]
    print(f"  stanic v bboxu: {len(near)}, ukázka id: {ids[:6]}")

    url = (f"{base}?parameters=TL&parameters=RFAM&parameters=FFAM&parameters=DD"
           f"&parameters=P&output_format=geojson")
    if ids:
        url += "&station_ids=" + ",".join(ids[:10])
    r2 = get(url)
    print(f"  data: HTTP {r2.status_code}, {len(r2.content)} B")
    if not r2.ok:
        print(f"    tělo: {r2.text[:300]}")
        return
    g = r2.json()
    print(f"  klíče odpovědi: {sorted(g.keys())}")
    print(f"  timestamps: {str(g.get('timestamps'))[:120]}")
    feats = g.get("features", [])
    print(f"  features: {len(feats)}")
    if feats:
        p = feats[0]
        print(f"    geometry: {json.dumps(p.get('geometry'))[:120]}")
        print(f"    properties: {json.dumps(p.get('properties'), ensure_ascii=False)[:500]}")


def probe_imgw():
    head("(b) IMGW PL — spojení id_stacji se souřadnicemi")
    r = get("https://danepubliczne.imgw.pl/api/data/synop")
    if not r.ok:
        print(f"  HTTP {r.status_code}")
        return
    rows = r.json()
    print(f"  stanic: {len(rows)}")

    rc = get("https://bulk.meteostat.net/v2/stations/lite.json.gz")
    if not rc.ok:
        print(f"  číselník HTTP {rc.status_code}")
        return
    cat = json.loads(gzip.decompress(rc.content))
    by_wmo = {}
    for s in cat:
        w = (s.get("identifiers") or {}).get("wmo")
        if w:
            by_wmo[str(w)] = s
    print(f"  číselník: {len(cat)} stanic, s WMO id {len(by_wmo)}")

    hit, miss, near = 0, [], []
    for row in rows:
        sid = str(row.get("id_stacji", "")).strip()
        s = by_wmo.get(sid)
        if s:
            hit += 1
            loc = s.get("location") or {}
            lat, lon = f(loc.get("latitude")), f(loc.get("longitude"))
            if inb(lat, lon):
                near.append((row.get("stacja"), lat, lon, row.get("temperatura")))
        else:
            miss.append(sid)
    print(f"  spojeno podle WMO id: {hit}/{len(rows)}, nespojeno: {len(miss)}")
    print(f"  nespojená id (ukázka): {miss[:10]}")
    print(f"  v našem bboxu: {len(near)}")
    for n in near:
        print(f"    {str(n[0])[:22]:24s} {n[1]:.3f},{n[2]:.3f}  {n[3]}°C")
    if rows:
        print(f"  jednotky — vzorek: {json.dumps(rows[0], ensure_ascii=False)[:260]}")


def probe_dwd():
    head("(c) DWD — spojení POI souborů se souřadnicemi z CLIMAT seznamu")
    r = get("https://opendata.dwd.de/weather/weather_reports/poi/")
    if not r.ok:
        print(f"  index HTTP {r.status_code}")
        return
    files = re.findall(r'href="([^"]*)-BEOB\.csv"', r.text)
    ids = sorted(set(files))
    print(f"  POI stanic: {len(ids)}, ukázka: {ids[:6]}")

    rc = get("https://opendata.dwd.de/climate_environment/CDC/help/"
             "stations_list_CLIMAT_data.txt")
    if not rc.ok:
        print(f"  CLIMAT HTTP {rc.status_code}")
        return
    coords = {}
    for line in rc.text.splitlines()[1:]:
        parts = line.split(";")
        if len(parts) < 5:
            continue
        wmo = parts[0].strip()
        lat, lon = f(parts[2]), f(parts[3])
        if wmo and lat is not None:
            coords[wmo] = (lat, lon, parts[1].strip())
    print(f"  CLIMAT číselník: {len(coords)} stanic")

    hit = [i for i in ids if i in coords]
    near = [(coords[i][2], *coords[i][:2]) for i in hit if inb(*coords[i][:2])]
    print(f"  POI id nalezeno v CLIMAT: {len(hit)}/{len(ids)}")
    print(f"  z toho v našem bboxu: {len(near)}")
    for n in near[:10]:
        print(f"    {str(n[0])[:24]:26s} {n[1]:.2f},{n[2]:.2f}")
    if len(hit) < len(ids) * 0.5:
        print("  → CLIMAT seznam POI nepokrývá; bude potřeba jiný číselník")


def main():
    print(f"Sonda kolo 10 — {datetime.now(timezone.utc).isoformat()}")
    for fn in (probe_geosphere, probe_imgw, probe_dwd):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
