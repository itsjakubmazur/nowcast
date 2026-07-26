"""Sonda 3: vnitřek souborů, na kterých stojí návrh implementace.

Kolo 1 = co existuje, kolo 2 = jak to vypadá zvenku. Tohle kolo otevírá
konkrétní soubory, protože bez znalosti jejich struktury by plán byl odhad:
  - fct_* HDF5: je to stejný ODIM jako maxz? (→ jde použít read_odim_dbz?)
  - products/climate_normal_stations: jsou tam normály i pro národní stanice?
  - forecast/now: co ČHMÚ publikuje jako textovou/číselnou předpověď
  - wind_profiles, radiosounding: skutečný obsah CSV
"""
import io, re, sys, tarfile
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


def head_text(url, n=8, label=""):
    try:
        r = get(url)
        print(f"  {label or url}: HTTP {r.status_code}, {len(r.content)} B")
        if not r.ok:
            return
        for line in r.content.decode("utf-8", "replace").splitlines()[:n]:
            print(f"    | {line[:230]}")
    except Exception as e:
        print(f"  {label or url}: CHYBA {str(e)[:120]}")


def dump_h5(buf, label):
    """Vypíše strom skupin + atributy ODIM HDF5 ze surových bajtů."""
    import h5py, numpy as np
    with h5py.File(io.BytesIO(buf), "r") as f:
        def walk(name, obj):
            kind = "DS" if isinstance(obj, h5py.Dataset) else "GR"
            extra = f" shape={obj.shape} dtype={obj.dtype}" if kind == "DS" else ""
            attrs = {k: (v.decode() if isinstance(v, bytes) else
                         (float(v) if isinstance(v, (int, float, np.generic)) else str(v)))
                     for k, v in obj.attrs.items()}
            print(f"    {kind} /{name}{extra}"
                  + (f"  attrs={attrs}" if attrs else ""))
        print(f"  --- {label} ---")
        root_attrs = dict(f.attrs)
        if root_attrs:
            print(f"    kořen attrs={root_attrs}")
        f.visititems(walk)


def main():
    print(f"Sonda 3 — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== 1) fct_maxz HDF5 uvnitř tar — je to ODIM jako maxz? ===")
    base = "meteorology/weather/radar/composite/"
    files = [f for f in ls(f"{base}fct_maxz/hdf5/", "fct_maxz", show=2) if f.endswith(".tar")]
    if files:
        newest = sorted(files)[-1]
        r = get(f"{ROOT}{'/'}{base}fct_maxz/hdf5/{newest}")
        with tarfile.open(fileobj=io.BytesIO(r.content)) as tf:
            members = [m for m in tf.getmembers() if m.name.endswith(".hdf")]
            members.sort(key=lambda m: m.name)
            print(f"    členů .hdf: {len(members)}, velikosti: "
                  f"{[(m.name.split('_')[-1], m.size) for m in members]}")
            first = tf.extractfile(members[0]).read()
            try:
                dump_h5(first, members[0].name)
            except Exception as e:
                print(f"    dump_h5 CHYBA {str(e)[:200]}")

    print("\n=== 2) maxz HDF5 pro srovnání geometrie ===")
    mf = ls(f"{base}maxz/hdf5/", "maxz", show=2)
    if mf:
        r = get(f"{ROOT}/{base}maxz/hdf5/{sorted(mf)[-1]}")
        try:
            dump_h5(r.content, sorted(mf)[-1])
        except Exception as e:
            print(f"    dump_h5 CHYBA {str(e)[:200]}")

    print("\n=== 3) echotop HDF5 — jednotky a quantity ===")
    ef = ls(f"{base}echotop/hdf5/", "echotop", show=2)
    if ef:
        r = get(f"{ROOT}/{base}echotop/hdf5/{sorted(ef)[-1]}")
        try:
            dump_h5(r.content, sorted(ef)[-1])
        except Exception as e:
            print(f"    dump_h5 CHYBA {str(e)[:200]}")

    print("\n=== 4) products/climate_normal_stations — normály pro víc stanic? ===")
    for p in ("meteorology/products/", "meteorology/products/climate_normal_stations/",
              "meteorology/products/regional_averages/", "meteorology/products/grids_CZ/"):
        ls(p, p, show=8)

    print("\n=== 5) weather/forecast/now + metadata ===")
    for p in ("meteorology/weather/forecast/now/", "meteorology/weather/forecast/metadata/",
              "meteorology/weather/forecast_monthly/now/"):
        f = ls(p, p, show=8)
        if f:
            head_text(f"{ROOT}/{p}{sorted(f)[-1]}", 6, f"{p}{sorted(f)[-1]}")

    print("\n=== 6) air_quality/now/metadata — mapování stanic a polutantů ===")
    f = ls("air_quality/now/metadata/", "aq metadata", show=10)
    for name in sorted(f)[:4]:
        head_text(f"{ROOT}/air_quality/now/metadata/{name}", 5, name)

    print("\n=== 7) wind_profiles — obsah jednoho CSV ===")
    f = ls("meteorology/weather/wind_profiles/recent/", "wind_profiles", show=2)
    if f:
        head_text(f"{ROOT}/meteorology/weather/wind_profiles/recent/{sorted(f)[-1]}",
                  14, sorted(f)[-1])

    print("\n=== 8) radiosounding Praha/recent — obsah ===")
    f = ls("meteorology/weather/radiosounding/Praha/recent/", "radiosounding Praha", show=4)
    if f:
        head_text(f"{ROOT}/meteorology/weather/radiosounding/Praha/recent/{sorted(f)[-1]}",
                  12, sorted(f)[-1])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
