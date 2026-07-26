"""
Diagnostická sonda: které další sítě meteostanic jsou z našeho CI runneru
opravdu dosažitelné, v jakém tvaru odpovídají a kolik stanic přidají v našem
zájmovém území.

Nespouští se v pipeline — jen ručně přes workflow_dispatch (probe-sources.yml).
Důvod existence: ze sandboxu Claude Code je většina těchhle hostů blokovaná
proxy (403), takže "podle dokumentace to jde" je jediné, co jde zjistit od
stolu. Tohle ověří skutečnost.

Nic nezapisuje do data/ — pouze tiskne zjištění.
"""

import gzip
import io
import json
import re
import sys
from datetime import datetime, timezone

import requests

# ČR + pásmo pohraničí (stejné jako metar.py)
LAT0, LON0, LAT1, LON1 = 48.3, 11.8, 51.3, 19.2
UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 45)


def in_bbox(lat, lon):
    return lat is not None and lon is not None and \
        LAT0 <= lat <= LAT1 and LON0 <= lon <= LON1


def head(title):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}", flush=True)


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=TIMEOUT, **kw)


def probe_chmi_recent():
    """Nejdůležitější otázka: publikuje ČHMÚ jinde víc stanic než těch 40 v now/?"""
    head("1) ČHMÚ — now/ vs. recent/ (kolik stanic vlastně jde získat)")
    for label, url in (
        ("now/data", "https://opendata.chmi.cz/meteorology/climate/now/data/"),
        ("recent/data", "https://opendata.chmi.cz/meteorology/climate/recent/data/"),
        ("climate", "https://opendata.chmi.cz/meteorology/climate/"),
    ):
        try:
            r = get(url)
            print(f"  {label}: HTTP {r.status_code}, {len(r.text)} B")
            if r.ok:
                links = re.findall(r'href="([^"?/][^"]*)"', r.text)
                links = [l for l in links if not l.startswith("http")]
                print(f"    položek: {len(links)}")
                for l in links[:25]:
                    print(f"      {l}")
                if len(links) > 25:
                    print(f"      … a dalších {len(links) - 25}")
        except Exception as e:
            print(f"  {label}: CHYBA {e}")


def probe_imgw():
    """Polsko — bez klíče, JSON. Nejrelevantnější pro Ostravsko a Těšínsko."""
    head("2) IMGW (PL) — danepubliczne.imgw.pl/api/data/synop")
    try:
        r = get("https://danepubliczne.imgw.pl/api/data/synop")
        print(f"  HTTP {r.status_code}")
        if not r.ok:
            return
        data = r.json()
        print(f"  stanic celkem: {len(data)}")
        print(f"  klíče: {sorted(data[0].keys()) if data else '—'}")
        print(f"  ukázka: {json.dumps(data[0], ensure_ascii=False)[:400]}")
        # API nevrací souřadnice → kolik z nich je v našem bboxu, se musí
        # doplnit z jiného zdroje. To je podstatné zjištění pro odhad práce.
        print("  POZOR: odpověď neobsahuje lat/lon — nutný vlastní číselník stanic")
    except Exception as e:
        print(f"  CHYBA {e}")


def probe_geosphere():
    """Rakousko — GeoSphere Data Hub, bez klíče, TAWES 10min."""
    head("3) GeoSphere Austria — dataset.geosphere.at (TAWES 10 min)")
    meta = "https://dataset.geosphere.at/v1/station/current/tawes-v1-10min/metadata"
    try:
        r = get(meta)
        print(f"  metadata: HTTP {r.status_code}")
        if r.ok:
            m = r.json()
            stations = m.get("stations", [])
            inb = [s for s in stations
                   if in_bbox(_f(s.get("lat")), _f(s.get("lon")))]
            print(f"  stanic celkem: {len(stations)}, v našem bboxu: {len(inb)}")
            params = [p.get("name") for p in m.get("parameters", [])]
            print(f"  parametry: {params[:20]}")
            for s in inb[:10]:
                print(f"    {str(s.get('name'))[:30]:32s} {s.get('lat')},{s.get('lon')}")
    except Exception as e:
        print(f"  metadata CHYBA {e}")

    data = ("https://dataset.geosphere.at/v1/station/current/tawes-v1-10min"
            "?parameters=TL&parameters=FFAM&parameters=RR&output_format=geojson")
    try:
        r = get(data)
        print(f"  data: HTTP {r.status_code}, {len(r.content)} B")
        if r.ok:
            g = r.json()
            feats = g.get("features", [])
            print(f"  features: {len(feats)}")
            if feats:
                print(f"  ukázka: {json.dumps(feats[0], ensure_ascii=False)[:400]}")
    except Exception as e:
        print(f"  data CHYBA {e}")


def probe_dwd():
    """Německo — opendata.dwd.de, bez klíče. POI = aktuální pozorování v CSV."""
    head("4) DWD (DE) — opendata.dwd.de/weather/weather_reports/poi/")
    try:
        r = get("https://opendata.dwd.de/weather/weather_reports/poi/")
        print(f"  index: HTTP {r.status_code}, {len(r.text)} B")
        if r.ok:
            files = re.findall(r'href="([^"]*BEOB\.csv)"', r.text)
            print(f"  BEOB.csv souborů: {len(files)}")
            print(f"  ukázka názvů: {files[:5]}")
            if files:
                one = files[0]
                r2 = get(f"https://opendata.dwd.de/weather/weather_reports/poi/{one}")
                lines = r2.text.splitlines()[:5]
                print(f"  hlavička {one}:")
                for l in lines:
                    print(f"    {l[:160]}")
    except Exception as e:
        print(f"  CHYBA {e}")


def probe_meteostat():
    """Meteostat — agreguje METAR+SYNOP, zajímá nás hlavně číselník se souřadnicemi."""
    head("5) Meteostat — bulk číselník stanic (souřadnice pro PL/DE/SK)")
    try:
        r = get("https://bulk.meteostat.net/v2/stations/lite.json.gz")
        print(f"  HTTP {r.status_code}, {len(r.content)} B")
        if r.ok:
            raw = gzip.decompress(r.content)
            arr = json.loads(raw)
            print(f"  stanic celkem: {len(arr)}")
            inb, by_country = [], {}
            for s in arr:
                loc = s.get("location") or {}
                if in_bbox(_f(loc.get("latitude")), _f(loc.get("longitude"))):
                    inb.append(s)
                    by_country[s.get("country")] = by_country.get(s.get("country"), 0) + 1
            print(f"  v našem bboxu: {len(inb)}  podle zemí: {by_country}")
            wmo = sum(1 for s in inb if s.get("identifiers", {}).get("wmo"))
            icao = sum(1 for s in inb if s.get("identifiers", {}).get("icao"))
            print(f"  z toho s WMO id: {wmo}, s ICAO id: {icao}")
            if inb:
                print(f"  ukázka: {json.dumps(inb[0], ensure_ascii=False)[:400]}")
    except Exception as e:
        print(f"  CHYBA {e}")


def probe_sensor_community():
    """Sensor.Community — velmi hustá amatérská síť; teplota bývá zkreslená."""
    head("6) Sensor.Community — data.sensor.community (hustota vs. kvalita)")
    try:
        r = get("https://data.sensor.community/static/v2/data.json")
        print(f"  HTTP {r.status_code}, {len(r.content)} B")
        if r.ok:
            arr = r.json()
            inb = 0
            temp = 0
            for s in arr:
                loc = s.get("location") or {}
                if in_bbox(_f(loc.get("latitude")), _f(loc.get("longitude"))):
                    inb += 1
                    if any(v.get("value_type") == "temperature"
                           for v in s.get("sensordatavalues", [])):
                        temp += 1
            print(f"  záznamů celkem: {len(arr)}, v bboxu: {inb}, z toho s teplotou: {temp}")
    except Exception as e:
        print(f"  CHYBA {e}")


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    print(f"Sonda zdrojů stanic — {datetime.now(timezone.utc).isoformat()}")
    print(f"bbox: {LAT0}–{LAT1} N, {LON0}–{LON1} E")
    for fn in (probe_chmi_recent, probe_imgw, probe_geosphere, probe_dwd,
               probe_meteostat, probe_sensor_community):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__} spadlo: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
