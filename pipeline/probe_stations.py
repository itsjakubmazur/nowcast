"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

KLÍČOVÉ ZJIŠTĚNÍ KOLA 8 (opravuje můj vlastní chybný závěr z kol 1–4):
ČHMÚ v now/data/ publikuje 476 stanic, ne 40. Rozdíl byl artefakt mého
regexu, který hleděl jen na WIGOS prefix 0-20000-0 (těch je 40 — stanice
vyměňované mezinárodně). Prefix 0-203-0 = česká národní síť, dalších 436
stanic, které jsem vůbec nepočítal.

Kolo 9 zjišťuje poslední věci potřebné k implementaci:
  (a) obsahuje meta1 souřadnice i pro 0-203-0, nebo jen pro WMO stanice?
  (b) co je v meteorology/weather/ a products/ — je tam něco globálního?
  (c) jak vypadá datový soubor národní stanice (má vůbec teplotu?)
"""

import re
import sys
from collections import Counter
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 90)
ROOT = "https://opendata.chmi.cz"
BASE = f"{ROOT}/meteorology/climate"


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def get(u):
    return requests.get(u, headers=UA, timeout=TIMEOUT)


def links(html):
    out, seen = [], set()
    for l in re.findall(r'href="([^"?][^"]*)"', html):
        if l.startswith("http") or l == "../" or l in seen:
            continue
        seen.add(l)
        out.append(l)
    return out


def data_ids():
    r = get(f"{BASE}/now/data/")
    pat = re.compile(r'^(?:10m|1h)-(.+?)-\d{8}\.json$')
    ids = set()
    for f in links(r.text):
        m = pat.match(f)
        if m:
            ids.add(m.group(1))
    return ids


def probe_meta_coverage(ids):
    head("(a) meta1 — jsou v číselníku i národní stanice 0-203-0?")
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    r = get(f"{BASE}/now/metadata/meta1-{today}.json")
    if not r.ok:
        print(f"  HTTP {r.status_code}")
        return
    values = r.json()["data"]["data"]["values"]
    by_prefix = Counter("-".join(str(v[0]).split("-")[:3]) for v in values)
    print(f"  řádků: {len(values)}, podle prefixu: {dict(by_prefix)}")

    meta_ids = {str(v[0]) for v in values}
    d203 = {i for i in ids if i.startswith("0-203-0-")}
    dwmo = {i for i in ids if i.startswith("0-20000-0-")}
    print(f"  stanic v datech: {len(ids)} (národních {len(d203)}, WMO {len(dwmo)})")
    print(f"  národních se souřadnicemi v meta1: {len(d203 & meta_ids)} / {len(d203)}")
    print(f"  WMO se souřadnicemi v meta1:       {len(dwmo & meta_ids)} / {len(dwmo)}")
    chybi = sorted(d203 - meta_ids)[:5]
    if chybi:
        print(f"  ukázka bez metadat: {chybi}")

    # Zeměpisný rozsah stanic, které MÁME v datech → je to jen ČR?
    coords = []
    for v in values:
        if str(v[0]) in ids:
            try:
                lon, lat = float(v[3]), float(v[4])
                coords.append((lat, lon, str(v[2])))
            except (TypeError, ValueError, IndexError):
                pass
    if coords:
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        print(f"  rozsah stanic s daty: {min(lats):.2f}–{max(lats):.2f} N, "
              f"{min(lons):.2f}–{max(lons):.2f} E  ({len(coords)} se souřadnicemi)")
        mimo = [c for c in coords if not (48.3 <= c[0] <= 51.3 and 11.8 <= c[1] <= 19.2)]
        print(f"  mimo ČR+pohraničí: {len(mimo)}  {[c[2] for c in mimo[:8]]}")
        # ukázka národních stanic
        nat = [(v[2], v[3], v[4]) for v in values
               if str(v[0]).startswith("0-203-0-") and str(v[0]) in ids][:8]
        print(f"  ukázka národních: {nat}")


def probe_other_trees():
    head("(b) meteorology/weather/ a products/ — něco globálního?")
    for sub in ("weather/", "products/"):
        r = get(f"{ROOT}/meteorology/{sub}")
        print(f"  {sub}: HTTP {r.status_code} → {links(r.text)[:20] if r.ok else ''}")


def probe_national_file(ids):
    head("(c) datový soubor národní stanice — co v něm je")
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    nat = sorted(i for i in ids if i.startswith("0-203-0-"))
    if not nat:
        print("  žádná národní stanice v datech")
        return
    for sid in nat[:2]:
        url = f"{BASE}/now/data/10m-{sid}-{today}.json"
        r = get(url)
        print(f"  {url.rsplit('/', 1)[-1]}: HTTP {r.status_code}, {len(r.content)} B")
        if not r.ok:
            continue
        try:
            d = r.json()["data"]["data"]
            print(f"    hlavička: {d.get('header')}")
            vals = d.get("values", [])
            elems = Counter(v[1] for v in vals if len(v) > 1)
            print(f"    záznamů: {len(vals)}, prvků: {dict(elems.most_common(12))}")
            if vals:
                print(f"    vzorek: {vals[0]}")
        except Exception as e:
            print(f"    parse chyba: {e}")


def main():
    print(f"Sonda kolo 9 — {datetime.now(timezone.utc).isoformat()}")
    try:
        ids = data_ids()
    except Exception as e:
        print(f"!! nepovedlo se načíst seznam stanic: {e}", file=sys.stderr)
        return
    for fn in (lambda: probe_meta_coverage(ids), probe_other_trees,
               lambda: probe_national_file(ids)):
        try:
            fn()
        except Exception as e:
            print(f"  !! {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
