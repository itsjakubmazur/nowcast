"""Sonda 2: hloubkový průzkum nevyužitých větví opendata.chmi.cz (ruční dispatch).

Kolo 1 zjistilo, CO existuje. Tohle kolo zjišťuje, JAK to vypadá uvnitř —
sloupce CSV, struktura HDF5, kadence běhů, velikosti souborů. Bez toho by
návrh implementace byl jen odhad.
"""
import io, re, sys, tarfile, zipfile
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
      "Accept": "application/json,text/html,*/*"}
T = (15, 90)
ROOT = "https://opendata.chmi.cz"
PAGES = "https://itsjakubmazur.github.io/nowcast"


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
    all_ = links(r.text)
    files = [l for l in all_ if not l.endswith("/")]
    dirs = [l for l in all_ if l.endswith("/")]
    print(f"  {label or path}: {len(files)} souborů, {len(dirs)} adresářů")
    if dirs:
        print(f"    adresáře: {dirs[:14]}")
    if files:
        newest = sorted(files)[-1]
        try:
            h = requests.head(f"{url}{newest}", headers=UA, timeout=T)
            lm = h.headers.get("Last-Modified")
            size = int(h.headers.get("Content-Length") or 0)
            age = (datetime.now(timezone.utc) - parsedate_to_datetime(lm)).total_seconds() / 60 if lm else None
            print(f"    nejnovější: {newest}  {size // 1024} kB"
                  + (f"  stáří {age:.0f} min" if age is not None else ""))
        except Exception as e:
            print(f"    HEAD selhal: {str(e)[:80]}")
        print(f"    ukázka: {sorted(files)[-show:]}")
    return files


def head_text(url, n=6, label=""):
    """Vypíše prvních n řádků textového souboru."""
    try:
        r = get(url)
        print(f"  {label or url}: HTTP {r.status_code}, {len(r.content)} B, "
              f"ct={r.headers.get('Content-Type')}")
        if not r.ok:
            return
        txt = r.content.decode("utf-8", "replace")
        for line in txt.splitlines()[:n]:
            print(f"    | {line[:220]}")
    except Exception as e:
        print(f"  {label or url}: CHYBA {str(e)[:120]}")


def main():
    print(f"Sonda 2 — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== 1) air_quality: skutečný obsah hodinového CSV ===")
    head_text(f"{ROOT}/air_quality/now/data/airquality_1h_avg_CZ.csv", 8, "airquality_1h_avg_CZ.csv")
    ls("air_quality/", "air_quality kořen")
    ls("air_quality/now/", "air_quality/now")

    print("\n=== 2) echotop — výška horní hranice oblačnosti ===")
    files = ls("meteorology/weather/radar/composite/echotop/hdf5/", "echotop", show=3)
    if files:
        newest = sorted(files)[-1]
        try:
            r = get(f"{ROOT}/meteorology/weather/radar/composite/echotop/hdf5/{newest}")
            print(f"    stažen {newest}: {len(r.content)} B, magic={r.content[:8]!r}")
        except Exception as e:
            print(f"    CHYBA {str(e)[:100]}")

    print("\n=== 3) radiosounding — aerologické výstupy ===")
    d = ls("meteorology/weather/radiosounding/", "radiosounding")
    for sub in ("meteorology/weather/radiosounding/",):
        r = get(f"{ROOT}/{sub}")
        for s in [l for l in links(r.text) if l.endswith("/")][:4]:
            ls(f"{sub}{s}", f"radiosounding/{s}", show=4)

    print("\n=== 4) wind_profiles ===")
    r = get(f"{ROOT}/meteorology/weather/wind_profiles/")
    subs = [l for l in links(r.text) if l.endswith("/")]
    print(f"  podadresáře: {subs[:14]}")
    for s in subs[:3]:
        ls(f"meteorology/weather/wind_profiles/{s}", f"wind_profiles/{s}", show=4)

    print("\n=== 5) forecast + forecast_monthly + forecast_maps_bio ===")
    for p in ("meteorology/weather/forecast/", "meteorology/weather/forecast_monthly/",
              "meteorology/weather/forecast_maps_bio/"):
        f = ls(p, p, show=8)

    print("\n=== 6) meteorology/products a floods ===")
    for p in ("meteorology/products/", "meteorology/floods/", "meteorology/phenology/"):
        ls(p, p, show=8)

    print("\n=== 7) ALADIN Lambert_2.3km — jeden běh ===")
    for run in ("12", "00"):
        f = ls(f"meteorology/weather/nwp_aladin/Lambert_2.3km/{run}/", f"Lambert 2.3km run {run}", show=8)

    print("\n=== 8) satelit geo/ ===")
    r = get(f"{ROOT}/meteorology/weather/satellite/geo/")
    subs = [l for l in links(r.text) if l.endswith("/")]
    print(f"  geo podadresáře: {subs[:16]}")
    for s in subs[:3]:
        ls(f"meteorology/weather/satellite/geo/{s}", f"geo/{s}", show=4)

    print("\n=== 9) kontrola: dorazila jména letišť a historie na Pages? ===")
    for name in ("metar_names.json", "metar_history.json", "chmi_stats.json"):
        try:
            r = get(f"{PAGES}/data/{name}")
            print(f"  {name}: HTTP {r.status_code}, {len(r.content)} B")
            if r.ok:
                j = r.json()
                if isinstance(j, dict):
                    ks = list(j.keys())[:6]
                    print(f"    klíčů: {len(j)}, ukázka {ks}")
                    if ks and name == "metar_names.json":
                        print(f"    hodnota[{ks[0]}] = {j[ks[0]]!r}")
        except Exception as e:
            print(f"  {name}: CHYBA {str(e)[:120]}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"!! {e}", file=sys.stderr)
