"""
Diagnostická sonda: které další sítě meteostanic jsou z našeho CI runneru
opravdu dosažitelné, v jakém tvaru odpovídají a kolik stanic přidají.

Ruční workflow_dispatch (probe-sources.yml), nic nezapisuje do data/.

Zjištění kol 1–2:
  * now/data/ má 2734 souborů, ale to je ~34 dní historie pro 40 stanic —
    ČHMÚ v now/ opravdu publikuje jen 40 stanic (průnik s metadaty = 40,
    "v datech ale ne v metadatech" = 0). meta1 je globální číselník WMO
    (je v něm i Reykjavík), ne seznam českých stanic.
  * GeoSphere AT žije na dataset.api.hub.geosphere.at — 288 stanic, 35 u nás.
  * IMGW vrací 62 stanic bez souřadnic; id_stacji = WMO id → jde spojit
    s číselníkem (Meteostat má 13 PL stanic s WMO id v našem bboxu).
  * DWD POI: 974 souborů; souřadnice jde dohledat v stations_list_CLIMAT_data.txt.

Kolo 3 řeší poslední otevřenou otázku: recent/data/10min má 11888 položek
ve stromu 01/ 02/ … — kolik je to stanic a jak moc data zaostávají? Na
ověřování přesnosti (ne na "teď") by i několikahodinové zpoždění stačilo.
"""

import re
import sys
from datetime import datetime, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 45)
BASE = "https://opendata.chmi.cz/meteorology/climate"


def head(title):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}", flush=True)


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=TIMEOUT, **kw)


def links(html):
    return [l for l in re.findall(r'href="([^"?][^"]*)"', html)
            if not l.startswith("http") and l != "../"]


def probe_recent_tree():
    """Kolik stanic je v recent/10min a jak čerstvá ta data jsou."""
    head("ČHMÚ recent/data/10min — hloubka stromu, počet stanic, zpoždění")
    root = f"{BASE}/recent/data/10min/"
    r = get(root)
    if not r.ok:
        print(f"  HTTP {r.status_code}")
        return
    top = links(r.text)
    dirs = [l for l in top if l.endswith("/")]
    files = [l for l in top if not l.endswith("/")]
    print(f"  kořen: {len(dirs)} podadresářů, {len(files)} souborů")
    print(f"  podadresáře: {dirs[:15]}")
    print(f"  soubory (ukázka): {files[:10]}")

    if not dirs:
        return
    sub = dirs[0]
    r2 = get(root + sub)
    if not r2.ok:
        print(f"  {sub}: HTTP {r2.status_code}")
        return
    lvl2 = links(r2.text)
    d2 = [l for l in lvl2 if l.endswith("/")]
    f2 = [l for l in lvl2 if not l.endswith("/")]
    print(f"  {sub}: {len(d2)} podadresářů, {len(f2)} souborů")
    print(f"    ukázka adresářů: {d2[:10]}")
    print(f"    ukázka souborů: {f2[:10]}")

    # Zkus dojít až k datovému souboru a zjistit, jak je starý
    path = root + sub
    listing = lvl2
    for _ in range(3):
        dd = [l for l in listing if l.endswith("/")]
        ff = [l for l in listing if not l.endswith("/")]
        if ff:
            target = path + ff[0]
            print(f"  vzorek: {target}")
            rr = get(target)
            print(f"    HTTP {rr.status_code}, {len(rr.content)} B, "
                  f"Last-Modified: {rr.headers.get('Last-Modified')}")
            txt = rr.text[:600]
            print(f"    začátek: {txt!r}")
            break
        if not dd:
            break
        path += dd[0]
        rn = get(path)
        if not rn.ok:
            break
        listing = links(rn.text)


def probe_recent_metadata():
    """Číselník k recent/ — kolik stanic a kde jsou."""
    head("ČHMÚ recent/ — metadata (číselník stanic klimatologické sítě)")
    for url in (f"{BASE}/recent/metadata/", f"{BASE}/recent/"):
        r = get(url)
        print(f"  {url}: HTTP {r.status_code}")
        if r.ok:
            print(f"    {links(r.text)[:25]}")


def main():
    print(f"Sonda kolo 3 — {datetime.now(timezone.utc).isoformat()}")
    for fn in (probe_recent_tree, probe_recent_metadata):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__} spadlo: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
