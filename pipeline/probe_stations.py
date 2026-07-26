"""
Diagnostická sonda: které další sítě meteostanic jsou z našeho CI runneru
opravdu dosažitelné, v jakém tvaru odpovídají a kolik stanic přidají v našem
zájmovém území.

Nespouští se v pipeline — jen ručně přes workflow_dispatch (probe-sources.yml).
Důvod existence: ze sandboxu Claude Code je většina těchhle hostů blokovaná
proxy (403), takže "podle dokumentace to jde" je jediné, co jde zjistit od
stolu. Tohle ověří skutečnost.

Nic nezapisuje do data/ — pouze tiskne zjištění.

Kolo 2 se soustředí na nejdůležitější otázku, kterou otevřelo kolo 1:
now/data/ má 2734 souborů, ale chmi.py z toho dělá jen ~40 stanic. Kde se
ztrácejí?
"""

import gzip
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

import requests

# ČR + pásmo pohraničí (stejné jako metar.py)
LAT0, LON0, LAT1, LON1 = 48.3, 11.8, 51.3, 19.2
UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 45)
BASE = "https://opendata.chmi.cz/meteorology/climate"


def in_bbox(lat, lon):
    return lat is not None and lon is not None and \
        LAT0 <= lat <= LAT1 and LON0 <= lon <= LON1


def head(title):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}", flush=True)


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=TIMEOUT, **kw)


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def probe_chmi_bottleneck():
    """KLÍČOVÁ OTÁZKA: kolik stanic ČHMÚ reálně publikuje a kde je nám ubývají."""
    head("1) ČHMÚ — kde se ztrácí stanice mezi now/data/ a chmi_stations.json")
    now_utc = datetime.now(timezone.utc)
    today = now_utc.strftime("%Y%m%d")
    yesterday = (now_utc - timedelta(days=1)).strftime("%Y%m%d")

    r = get(f"{BASE}/now/data/")
    if not r.ok:
        print(f"  now/data/ HTTP {r.status_code}")
        return
    ids_10m, ids_1h = set(), set()
    for date in (today, yesterday):
        ids_10m |= set(re.findall(rf'10m-0-20000-0-(\d+)-{date}\.json', r.text))
        ids_1h |= set(re.findall(rf'1h-0-20000-0-(\d+)-{date}\.json', r.text))
    all_ids = ids_10m | ids_1h
    print(f"  DATA: unikátních stanic v now/data/ = {len(all_ids)} "
          f"(10m {len(ids_10m)}, 1h {len(ids_1h)})")

    # Metadata — přesně tak, jak je čte chmi.py
    for label, date in (("dnes", today), ("včera", yesterday)):
        rm = get(f"{BASE}/now/metadata/meta1-{date}.json")
        print(f"  META meta1-{date}: HTTP {rm.status_code}")
        if not rm.ok:
            continue
        try:
            j = rm.json()
            values = j["data"]["data"]["values"]
            print(f"    řádků: {len(values)}")
            cols = j["data"]["data"].get("header") or j["data"]["data"].get("columns")
            print(f"    hlavička: {str(cols)[:300]}")
            sids = set()
            for row in values:
                m = re.search(r'(\d+)$', str(row[0]))
                if m:
                    sids.add(m.group(1))
            print(f"    unikátních ID v metadatech: {len(sids)}")
            print(f"    PRŮNIK data ∩ metadata: {len(all_ids & sids)}")
            print(f"    v datech, ale NE v metadatech: {len(all_ids - sids)}")
            if values:
                print(f"    ukázka řádku: {json.dumps(values[0], ensure_ascii=False)[:300]}")
        except Exception as e:
            print(f"    parse chyba: {e}")

    # Existuje bohatší číselník stanic?
    rmeta = get(f"{BASE}/now/metadata/")
    if rmeta.ok:
        files = re.findall(r'href="([^"?/][^"]*)"', rmeta.text)
        uniq = sorted({re.sub(r'\d{8}', 'YYYYMMDD', f) for f in files})
        print(f"  now/metadata/ typy souborů: {uniq[:20]}")


def probe_chmi_10min_recent():
    """recent/10min — druhá větev ČHMÚ, potenciálně širší síť."""
    head("2) ČHMÚ — recent/data/10min (širší klimatologická síť?)")
    for sub in ("10min", "1hour"):
        r = get(f"{BASE}/recent/data/{sub}/")
        print(f"  recent/data/{sub}/: HTTP {r.status_code}, {len(r.text)} B")
        if r.ok:
            files = re.findall(r'href="([^"?/][^"]*)"', r.text)
            print(f"    položek: {len(files)}  ukázka: {files[:8]}")


def probe_geosphere():
    """Rakousko — v kole 1 selhalo DNS, zkouším správné hostname."""
    head("3) GeoSphere Austria — správný host (kolo 1: DNS nenašel dataset.geosphere.at)")
    hosts = [
        "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min/metadata",
        "https://dataset.api.hub.eox.at/v1/station/current/tawes-v1-10min/metadata",
        "https://data.hub.geosphere.at/api/v1/station/current/tawes-v1-10min/metadata",
    ]
    for url in hosts:
        try:
            r = get(url)
            print(f"  {url.split('/v1')[0]}: HTTP {r.status_code}, {len(r.content)} B")
            if r.ok:
                m = r.json()
                st = m.get("stations", [])
                inb = [s for s in st if in_bbox(_f(s.get("lat")), _f(s.get("lon")))]
                print(f"    stanic: {len(st)}, v bboxu: {len(inb)}")
                print(f"    parametry: {[p.get('name') for p in m.get('parameters', [])][:15]}")
                for s in inb[:8]:
                    print(f"      {str(s.get('name'))[:30]:32s} {s.get('lat')},{s.get('lon')}")
                return
        except Exception as e:
            print(f"  {url.split('/v1')[0]}: CHYBA {str(e)[:120]}")


def probe_dwd_coords():
    """DWD POI má 974 stanic, ale CSV neobsahuje souřadnice — je číselník?"""
    head("4) DWD — číselník souřadnic k POI stanicím")
    cands = [
        "https://opendata.dwd.de/weather/lib/MetElementDefinition.json",
        "https://www.dwd.de/DE/leistungen/opendata/help/stationen/ha_messnetz.txt",
        "https://opendata.dwd.de/climate_environment/CDC/help/stations_list_CLIMAT_data.txt",
    ]
    for url in cands:
        try:
            r = get(url)
            print(f"  {url.rsplit('/', 1)[-1]}: HTTP {r.status_code}, {len(r.content)} B")
            if r.ok:
                print(f"    ukázka: {r.text[:300]!r}")
        except Exception as e:
            print(f"  {url.rsplit('/', 1)[-1]}: CHYBA {str(e)[:120]}")


def probe_meteostat_catalog():
    """Meteostat číselník jako lookup souřadnic pro IMGW/DWD podle national/WMO id."""
    head("5) Meteostat číselník — použitelnost jako lookup pro PL/DE")
    try:
        r = get("https://bulk.meteostat.net/v2/stations/lite.json.gz")
        if not r.ok:
            print(f"  HTTP {r.status_code}")
            return
        arr = json.loads(gzip.decompress(r.content))
        inb = []
        for s in arr:
            loc = s.get("location") or {}
            if in_bbox(_f(loc.get("latitude")), _f(loc.get("longitude"))):
                inb.append(s)
        by_c = Counter(s.get("country") for s in inb)
        print(f"  v bboxu: {len(inb)}  {dict(by_c)}")
        for c in ("PL", "DE", "AT", "SK"):
            sub = [s for s in inb if s.get("country") == c]
            nat = sum(1 for s in sub if (s.get("identifiers") or {}).get("national"))
            wmo = sum(1 for s in sub if (s.get("identifiers") or {}).get("wmo"))
            print(f"    {c}: {len(sub)} stanic, s national id {nat}, s WMO id {wmo}")
    except Exception as e:
        print(f"  CHYBA {e}")


def main():
    print(f"Sonda zdrojů stanic (kolo 2) — {datetime.now(timezone.utc).isoformat()}")
    print(f"bbox: {LAT0}–{LAT1} N, {LON0}–{LON1} E")
    for fn in (probe_chmi_bottleneck, probe_chmi_10min_recent, probe_geosphere,
               probe_dwd_coords, probe_meteostat_catalog):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__} spadlo: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
