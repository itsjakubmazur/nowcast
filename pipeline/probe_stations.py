"""Sonda: inventura nevyužitých větví opendata.chmi.cz (ruční dispatch)."""
import io, re, sys, tarfile
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
      "Accept": "application/json,text/html,*/*"}
T = (15, 90)
ROOT = "https://opendata.chmi.cz"


def get(u, **kw):
    return requests.get(u, headers=UA, timeout=T, **kw)


def links(html):
    out = []
    for m in re.finditer(r'href="([^"?][^"]*)"', html):
        l = m.group(1)
        if not l.startswith("http") and l != "../":
            out.append(l)
    return out


def listing(path, label=None, show=6):
    """Vypíše adresář + stáří nejnovějšího souboru (podle Last-Modified)."""
    url = f"{ROOT}/{path}"
    try:
        r = get(url)
    except Exception as e:
        print(f"  {label or path}: CHYBA {str(e)[:100]}")
        return []
    if not r.ok:
        print(f"  {label or path}: HTTP {r.status_code}")
        return []
    ls = links(r.text)
    files = [l for l in ls if not l.endswith("/")]
    dirs = [l for l in ls if l.endswith("/")]
    print(f"  {label or path}: {len(files)} souborů, {len(dirs)} adresářů")
    if dirs:
        print(f"    adresáře: {dirs[:12]}")
    if files:
        newest = sorted(files)[-1]
        print(f"    nejnovější: {newest}")
        try:
            h = requests.head(f"{url}{newest}", headers=UA, timeout=T)
            lm = h.headers.get("Last-Modified")
            size = h.headers.get("Content-Length")
            age = ""
            if lm:
                from email.utils import parsedate_to_datetime
                dt = parsedate_to_datetime(lm)
                age = f"  → stáří {(datetime.now(timezone.utc) - dt).total_seconds() / 60:.0f} min"
            print(f"    Last-Modified: {lm}  {int(size) // 1024 if size else '?'} kB{age}")
        except Exception as e:
            print(f"    HEAD selhal: {str(e)[:80]}")
        print(f"    ukázka: {sorted(files)[-show:]}")
    return files


def main():
    print(f"Inventura opendata.chmi.cz — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== A) radar/composite — které produkty a jak čerstvé ===")
    base = "meteorology/weather/radar/composite/"
    subs = links(get(f"{ROOT}/{base}").text)
    print(f"  podadresáře: {subs}")
    for sub in [s for s in subs if s.endswith("/")]:
        listing(f"{base}{sub}hdf5/", f"composite/{sub}hdf5", show=3)

    print("\n=== B) fct_* — vlastní extrapolační nowcast ČHMÚ ===")
    for prod in ("fct_pseudocappi2km", "fct_maxz"):
        files = listing(f"{base}{prod}/hdf5/", f"{prod}/hdf5", show=3)
        tars = [f for f in files if f.endswith(".tar")]
        if not tars:
            continue
        newest = sorted(tars)[-1]
        try:
            r = get(f"{ROOT}/{base}{prod}/hdf5/{newest}")
            print(f"    stažen {newest}: {len(r.content)} B")
            with tarfile.open(fileobj=io.BytesIO(r.content)) as tf:
                names = tf.getnames()
                print(f"    obsah tar: {len(names)} souborů")
                for n in names[:12]:
                    print(f"      {n}")
        except Exception as e:
            print(f"    tar CHYBA {str(e)[:120]}")

    print("\n=== C) blesky — existují v open datech? ===")
    for p in ("meteorology/weather/", "meteorology/"):
        ls = links(get(f"{ROOT}/{p}").text)
        hits = [l for l in ls if re.search(r"blesk|light|celdn|sferic|storm", l, re.I)]
        print(f"  {p}: {ls} → shody: {hits or 'žádné'}")

    print("\n=== D) air_quality ===")
    listing("air_quality/now/data/", "aq now/data", show=4)
    listing("air_quality/now/forecast/", "aq now/forecast", show=6)

    print("\n=== E) satelit ===")
    listing("meteorology/weather/satellite/", "satellite", show=4)

    print("\n=== F) ALADIN Lambert 2.3 km (středoevropská doména) ===")
    listing("meteorology/weather/nwp_aladin/", "nwp_aladin", show=4)
    listing("meteorology/weather/nwp_aladin/Lambert_2.3km/", "Lambert_2.3km", show=6)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
