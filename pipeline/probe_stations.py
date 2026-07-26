"""Sonda 4: doplnění posledních bílých míst — normály, aerologie, AQ registr."""
import re, json
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 90)
ROOT = "https://opendata.chmi.cz"


def get(u, **kw):
    return requests.get(u, headers=UA, timeout=T, **kw)


def links(html):
    return [m.group(1) for m in re.finditer(r'href="([^"?][^"]*)"', html)
            if not m.group(1).startswith("http") and m.group(1) != "../"]


def ls(path, label=None, show=6):
    url = f"{ROOT}/{path}"
    try:
        r = get(url)
    except Exception as e:
        print(f"  {label or path}: CHYBA {str(e)[:100]}")
        return []
    if not r.ok:
        print(f"  {label or path}: HTTP {r.status_code}")
        return []
    a = links(r.text)
    files = [l for l in a if not l.endswith("/")]
    dirs = [l for l in a if l.endswith("/")]
    print(f"  {label or path}: {len(files)} souborů, {len(dirs)} adresářů")
    if dirs:
        print(f"    adresáře: {dirs[:16]}")
    if files:
        newest = sorted(files)[-1]
        try:
            h = requests.head(f"{url}{newest}", headers=UA, timeout=T)
            lm = h.headers.get("Last-Modified")
            size = int(h.headers.get("Content-Length") or 0)
            age = (datetime.now(timezone.utc) - parsedate_to_datetime(lm)).total_seconds() / 60 if lm else None
            print(f"    nejnovější: {newest}  {size / 1024:.0f} kB"
                  + (f"  stáří {age:.0f} min" if age is not None else ""))
        except Exception:
            pass
        print(f"    ukázka: {sorted(files)[-show:]}")
    return files


def head_text(url, n=10, label=""):
    try:
        r = get(url)
        print(f"  {label or url}: HTTP {r.status_code}, {len(r.content)} B")
        if not r.ok:
            return None
        txt = r.content.decode("utf-8", "replace")
        for line in txt.splitlines()[:n]:
            print(f"    | {line[:240]}")
        return txt
    except Exception as e:
        print(f"  {label or url}: CHYBA {str(e)[:120]}")
        return None


def main():
    print(f"Sonda 4 — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== 1) climate_normal_stations/period_1991_2020 — kolik stanic? ===")
    p = "meteorology/products/climate_normal_stations/period_1991_2020/"
    f = ls(p, "normály 1991-2020", show=10)
    for name in sorted(f)[:3]:
        head_text(f"{ROOT}/{p}{name}", 6, name)
    for d in ("", ):
        r = get(f"{ROOT}/{p}")
        for sub in [l for l in links(r.text) if l.endswith("/")][:4]:
            sf = ls(f"{p}{sub}", f"normály/{sub}", show=6)
            if sf:
                head_text(f"{ROOT}/{p}{sub}{sorted(sf)[0]}", 6, sorted(sf)[0])

    print("\n=== 2) grids_CZ/climate_normals ===")
    p2 = "meteorology/products/grids_CZ/climate_normals/"
    f2 = ls(p2, "grids climate_normals", show=8)
    r = get(f"{ROOT}/{p2}")
    for sub in [l for l in links(r.text) if l.endswith("/")][:3]:
        ls(f"{p2}{sub}", f"grids/{sub}", show=6)

    print("\n=== 3) regional_averages ===")
    for sub in ("temperature/", "precipitation/"):
        f3 = ls(f"meteorology/products/regional_averages/{sub}",
                f"regional/{sub}", show=6)
        if f3:
            head_text(f"{ROOT}/meteorology/products/regional_averages/{sub}{sorted(f3)[0]}",
                      5, sorted(f3)[0])
    head_text(f"{ROOT}/meteorology/products/regional_averages/List_of_regions.csv",
              8, "List_of_regions.csv")

    print("\n=== 4) radiosounding Praha/recent/ascent ===")
    f4 = ls("meteorology/weather/radiosounding/Praha/recent/ascent/", "aerologie ascent", show=4)
    if f4:
        head_text(f"{ROOT}/meteorology/weather/radiosounding/Praha/recent/ascent/{sorted(f4)[-1]}",
                  12, sorted(f4)[-1])

    print("\n=== 5) AQ metadata.json — struktura registru stanic ===")
    try:
        r = get(f"{ROOT}/air_quality/now/metadata/metadata.json")
        j = json.loads(r.content.decode("utf-8", "replace"))
        print(f"  klíče kořene: {list(j.keys())}")
        for k, v in j.items():
            if isinstance(v, list):
                print(f"  {k}: list délky {len(v)}")
                if v:
                    print(f"    první prvek klíče: {list(v[0].keys()) if isinstance(v[0], dict) else type(v[0])}")
                    print(f"    ukázka: {json.dumps(v[0], ensure_ascii=False)[:600]}")
            elif isinstance(v, dict):
                print(f"  {k}: dict klíče {list(v.keys())[:12]}")
    except Exception as e:
        print(f"  CHYBA {str(e)[:200]}")

    print("\n=== 6) forecast/now — obsah textové předpovědi ===")
    f6 = ls("meteorology/weather/forecast/now/", "forecast now", show=4)
    if f6:
        txt = head_text(f"{ROOT}/meteorology/weather/forecast/now/{sorted(f6)[-1]}", 0, "")
        if txt:
            try:
                j = json.loads(txt)
                print(f"  klíče: {list(j.keys())}")
                print(f"  {json.dumps(j, ensure_ascii=False)[:1800]}")
            except Exception as e:
                print(f"  parse CHYBA {str(e)[:150]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
