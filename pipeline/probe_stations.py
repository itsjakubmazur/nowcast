"""Sonda 6: poslední neznámá — vazba idRegistration → (stanice, látka) v AQ registru.

Plus doplnění: obsah měsíčního adresáře gridovaných normálů a druhý
aerologický výpis (Prostějov) pro potvrzení formátu.
"""
import csv, io, json, re
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 90)
ROOT = "https://opendata.chmi.cz"


def get(u, **kw):
    return requests.get(u, headers=UA, timeout=T, **kw)


def links(html):
    return [m.group(1) for m in re.finditer(r'href="([^"?][^"]*)"', html)
            if not m.group(1).startswith("http") and m.group(1) != "../"]


def find_paths(obj, needle, path="", hits=None, depth=0):
    """Najde všechny cesty, kde se v JSON stromu vyskytuje hodnota `needle`."""
    if hits is None:
        hits = []
    if depth > 12 or len(hits) > 6:
        return hits
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (str, int)) and str(v) == needle:
                hits.append(f"{path}.{k}")
            else:
                find_paths(v, needle, f"{path}.{k}", hits, depth + 1)
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:200]):
            find_paths(v, needle, f"{path}[{i}]", hits, depth + 1)
    return hits


def main():
    print(f"Sonda 6 — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== A) AQ: kde v Localities sedí idRegistration ===")
    csv_txt = get(f"{ROOT}/air_quality/now/data/airquality_1h_avg_CZ.csv").content.decode("utf-8", "replace")
    rows = [r for r in csv.reader(io.StringIO(csv_txt), skipinitialspace=True) if len(r) >= 4]
    ids = [r[0].strip() for r in rows[1:] if r[0].strip().isdigit()]
    print(f"  CSV: {len(rows)-1} řádků, {len(set(ids))} unikátních idRegistration")

    meta = json.loads(get(f"{ROOT}/air_quality/now/metadata/metadata.json")
                      .content.decode("utf-8", "replace"))
    loc = meta["data"]["Localities"]

    target = ids[0]
    print(f"  hledám {target!r}:")
    for p in find_paths(loc, target):
        print(f"    {p}")

    # celá struktura MeasuringPrograms první lokality
    mp = loc[0].get("MeasuringPrograms")
    print(f"\n  Localities[0].MeasuringPrograms: {type(mp).__name__}, "
          f"délka {len(mp) if hasattr(mp, '__len__') else '?'}")
    print(f"  {json.dumps(mp, ensure_ascii=False)[:3000]}")

    # kolik idRegistration z CSV se vůbec podaří najít?
    flat = json.dumps(loc, ensure_ascii=False)
    found = sum(1 for i in set(ids) if f'"{i}"' in flat or f": {i}" in flat or f":{i}" in flat)
    print(f"\n  hrubý odhad pokrytí: {found}/{len(set(ids))} idRegistration se v registru vyskytuje")

    print("\n=== B) ValueType.csv celý ===")
    r = get(f"{ROOT}/air_quality/now/metadata/ValueType.csv")
    print(r.content.decode("utf-8", "replace"))

    print("\n=== C) gridované normály — obsah měsíčního adresáře ===")
    p = ("meteorology/products/grids_CZ/climate_normals/period_1991_2020/"
         "air_temperature_mean/07_July_1991_2020/")
    r = get(f"{ROOT}/{p}")
    if r.ok:
        f = links(r.text)
        print(f"  {len(f)} položek: {sorted(f)[:12]}")
        for name in sorted([x for x in f if not x.endswith("/")])[:2]:
            h = requests.head(f"{ROOT}/{p}{name}", headers=UA, timeout=T)
            print(f"    {name}: {int(h.headers.get('Content-Length') or 0)/1024:.0f} kB")
            blob = get(f"{ROOT}/{p}{name}")
            print(f"      prvních 200 B: {blob.content[:200]!r}")
    else:
        print(f"  HTTP {r.status_code}")

    print("\n=== D) aerologie Prostějov — potvrzení formátu ===")
    for city in ("Praha", "Prostejov"):
        pth = f"meteorology/weather/radiosounding/{city}/recent/ascent/"
        r = get(f"{ROOT}/{pth}")
        if not r.ok:
            print(f"  {city}: HTTP {r.status_code}")
            continue
        vyp = sorted([x for x in links(r.text) if "vypis" in x])
        print(f"  {city}: {len(vyp)} výpisů, nejnovější {vyp[-1] if vyp else '—'}")
        if vyp:
            b = get(f"{ROOT}/{pth}{vyp[-1]}")
            print(f"    {len(b.content)} B:")
            for line in b.content.decode("utf-8", "replace").splitlines():
                print(f"    | {line[:160]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
