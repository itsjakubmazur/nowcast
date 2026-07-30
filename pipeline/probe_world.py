"""
Sonda: existuje celosvětová síť měřených teplot, kterou bychom přidali k METARu?

Výchozí stav: metar.py už tahá ~5000 letišť z celého světa jedním bulk
souborem. Letiště jsou ale řídká a nejsou nikde nad mořem, v horách ani
v místech bez letecké dopravy. Otázka tedy nezní "máme světová data?", ale
"čím se dá ta síť zahustit tam, kde je prázdná?".

Kandidáti níž jsou vybraní podle jednoho tvrdého kritéria: musí to jít stáhnout
z GitHub Actions bez registrace a bez klíče, a nejlíp v jednotkách requestů —
pipeline běží po pěti minutách a nemůže obcházet tisíce stanic po jedné.

Sonda nic neimplementuje. Jen zjistí, co je dostupné, kolik toho je a jak to
vypadá, aby se rozhodovalo podle čísel a ne podle dojmu.
"""

import gzip
import io
import json
import sys
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 60)


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=T, **kw)


def head_bytes(r, n=300):
    return r.content[:n].decode("utf-8", "replace").replace("\n", " ⏎ ")


def probe_baseline():
    """Kolik stanic máme dnes — bez toho nemá smysl mluvit o přínosu."""
    print("=== VÝCHOZÍ STAV: METAR bulk (co už používáme) ===")
    try:
        r = get("https://aviationweather.gov/data/cache/metars.cache.csv.gz")
        print(f"  HTTP {r.status_code}, {len(r.content)/1024:.0f} kB")
        if not r.ok:
            return
        text = gzip.decompress(r.content).decode("utf-8", "replace")
        lines = [l for l in text.splitlines() if l.strip()]
        # Hlavička bývá až po pár řádcích komentáře
        hdr_i = next((i for i, l in enumerate(lines) if l.startswith("raw_text")), 0)
        import csv as _csv
        rows = list(_csv.DictReader(lines[hdr_i:]))
        withT = [x for x in rows
                 if x.get("temp_c") not in (None, "") and x.get("latitude") not in (None, "")]
        print(f"  záznamů: {len(rows)}, s teplotou a polohou: {len(withT)}")
        # Hrubé rozložení po kontinentech podle zeměpisné šířky/délky
        boxes = {
            "Evropa": (35, 72, -12, 45), "Sev. Amerika": (15, 72, -170, -50),
            "Asie": (5, 72, 45, 150), "Afrika": (-35, 35, -20, 52),
            "Již. Amerika": (-56, 15, -82, -34), "Oceánie": (-48, 0, 110, 180),
        }
        for name, (s, n, w, e) in boxes.items():
            c = sum(1 for x in withT
                    if s <= float(x["latitude"]) <= n and w <= float(x["longitude"]) <= e)
            print(f"    {name:14s} {c:5d}")
    except Exception as ex:
        print(f"  CHYBA {str(ex)[:200]}")


def probe_ndbc():
    """
    Bóje NOAA NDBC. Jeden textový soubor, všechny stanice, bez klíče.
    Zajímavé právě tam, kde letiště nejsou — na moři a na pobřeží.
    """
    print("\n=== NOAA NDBC — bóje (jeden soubor, bez klíče) ===")
    try:
        r = get("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt")
        print(f"  HTTP {r.status_code}, {len(r.content)/1024:.0f} kB")
        if not r.ok:
            return
        lines = r.text.splitlines()
        print(f"  hlavička: {lines[0][:120] if lines else '—'}")
        cols = lines[0].split() if lines else []
        try:
            i_lat, i_lon = cols.index("LAT"), cols.index("LON")
            i_atmp = cols.index("ATMP")
        except ValueError:
            print(f"  sloupce: {cols}")
            return
        tot = air = 0
        sample = []
        for l in lines[2:]:
            f = l.split()
            if len(f) <= max(i_lat, i_lon, i_atmp):
                continue
            tot += 1
            if f[i_atmp] not in ("MM", "-", ""):
                air += 1
                if len(sample) < 4:
                    sample.append(f"{f[0]} {f[i_lat]},{f[i_lon]} {f[i_atmp]} °C")
        print(f"  stanic celkem: {tot}, s teplotou vzduchu: {air}")
        for s in sample:
            print(f"    {s}")
    except Exception as ex:
        print(f"  CHYBA {str(ex)[:200]}")


def probe_dwd_synop():
    """
    SYNOP je pozemní síť WMO (~11 000 stanic) — přesně to, co METARu chybí.
    Otázka je, jestli je někde k mání bez klíče. DWD publikuje open data;
    zkusíme, jestli mezi nimi jsou i mezinárodní hlášení.
    """
    print("\n=== DWD open data — je tam mezinárodní SYNOP? ===")
    for path in ("weather/weather_reports/synoptic/",
                 "weather/weather_reports/synoptic/international/",
                 "weather/weather_reports/poi/"):
        url = f"https://opendata.dwd.de/{path}"
        try:
            r = get(url)
            body = r.text[:400].replace("\n", " ")
            print(f"  {path}: HTTP {r.status_code}, {len(r.content)} B")
            if r.ok:
                print(f"    {body[:300]}")
        except Exception as ex:
            print(f"  {path}: CHYBA {str(ex)[:150]}")


def probe_meteostat():
    """
    Meteostat slučuje GHCN/ISD/DWD do jedné sítě. Bulk je zdarma bez klíče —
    jde o to, jestli se dají dostat AKTUÁLNÍ hodnoty, nebo jen archiv.
    """
    print("\n=== Meteostat bulk (bez klíče) ===")
    try:
        r = get("https://bulk.meteostat.net/v2/stations/full.json.gz")
        print(f"  seznam stanic: HTTP {r.status_code}, {len(r.content)/1024/1024:.1f} MB")
        if r.ok:
            data = json.loads(gzip.decompress(r.content))
            print(f"  stanic: {len(data)}")
            s = data[0]
            print(f"  vzorek: {json.dumps(s, ensure_ascii=False)[:220]}")
            # Hodinová data jsou per stanice — kolik jich je, tolik requestů
            sid = s.get("id")
            r2 = get(f"https://bulk.meteostat.net/v2/hourly/{sid}.csv.gz")
            print(f"  hodinová data jedné stanice: HTTP {r2.status_code}, "
                  f"{len(r2.content)/1024:.0f} kB")
            if r2.ok:
                txt = gzip.decompress(r2.content).decode("utf-8", "replace")
                last = [l for l in txt.splitlines() if l.strip()][-1]
                print(f"  poslední řádek: {last[:120]}")
                print("  → pozor: jeden soubor = jedna stanice, tisíce stanic = tisíce requestů")
    except Exception as ex:
        print(f"  CHYBA {str(ex)[:200]}")


def probe_ogimet():
    """
    Ogimet dekóduje SYNOP z GTS a pouští ven bez klíče. Má ale přísné limity
    a explicitně nemá rád automatizované tahání — sonda to jen ověří, ať víme,
    jestli je to vůbec cesta.
    """
    print("\n=== Ogimet — dekódovaný SYNOP (limity!) ===")
    now = datetime.now(timezone.utc)
    beg = now.strftime("%Y%m%d%H00")
    url = ("https://www.ogimet.com/cgi-bin/getsynop"
           f"?block=11&begin={beg}")
    try:
        r = get(url)
        print(f"  HTTP {r.status_code}, {len(r.content)} B")
        print(f"  {head_bytes(r, 240)}")
    except Exception as ex:
        print(f"  CHYBA {str(ex)[:200]}")


def probe_national():
    """
    Národní sítě bez klíče. Nejsou "celosvětové", ale dohromady pokryjí
    Evropu hustěji než letiště — a u nás to je vidět nejvíc.
    """
    print("\n=== Národní open data bez klíče ===")
    cands = [
        ("SMHI (SE)", "https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/1/station-set/all/period/latest-hour/data.json"),
        ("FMI (FI)", "https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=GetFeature&storedquery_id=fmi::observations::weather::multipointcoverage&bbox=19,59,32,70&parameters=t2m"),
        ("MeteoSwiss (CH)", "https://data.geo.admin.ch/ch.meteoschweiz.messwerte-lufttemperatur-10min/ch.meteoschweiz.messwerte-lufttemperatur-10min_en.json"),
        ("GeoSphere (AT)", "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min?parameters=TL&output_format=geojson"),
        ("IMGW (PL)", "https://danepubliczne.imgw.pl/api/data/synop"),
        ("NWS (US)", "https://api.weather.gov/stations?limit=1"),
        ("ECCC (CA) SWOB", "https://dd.weather.gc.ca/observations/swob-ml/latest/"),
    ]
    for name, url in cands:
        try:
            r = get(url, stream=True)
            body = r.content[:200].decode("utf-8", "replace").replace("\n", " ")
            print(f"  {name:16s} HTTP {r.status_code}  {len(r.content)/1024:.0f} kB  {body[:130]}")
        except Exception as ex:
            print(f"  {name:16s} CHYBA {str(ex)[:120]}")


def main():
    print(f"Sonda světových sítí — {datetime.now(timezone.utc).isoformat()}\n")
    probe_baseline()
    probe_ndbc()
    probe_dwd_synop()
    probe_meteostat()
    probe_ogimet()
    probe_national()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
