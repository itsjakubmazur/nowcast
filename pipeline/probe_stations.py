"""Sonda 5: zbývající neznámé před implementací návrhů D, E, F, H, I.

Konkrétně:
  - air_quality metadata.json → data.Localities: je tam vazba idRegistration
    → (stanice, látka)? Bez toho se hodinové CSV nedá rozklíčovat.
  - products/grids_CZ/climate_normals: formát gridovaných normálů
  - radiosounding _vypis_*.csv: sloupce
  - regional_averages: kódování a oddělovače
  - weather/forecast/now: struktura GeoJSON featur (text + polygon)
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


def ls(path, label=None, show=6):
    try:
        r = get(f"{ROOT}/{path}")
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
        print(f"    ukázka: {sorted(files)[-show:]}")
    return files


def main():
    print(f"Sonda 5 — {datetime.now(timezone.utc).isoformat()}")

    print("\n=== A) air_quality: rozklíčování idRegistration ===")
    csv_txt = get(f"{ROOT}/air_quality/now/data/airquality_1h_avg_CZ.csv").content.decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(csv_txt), skipinitialspace=True))
    print(f"  CSV: {len(rows)} řádků, hlavička {rows[0]}")
    ids = {r[0] for r in rows[1:] if r and r[0].strip().isdigit()}
    vts = {}
    for r in rows[1:]:
        if len(r) >= 3:
            vts[r[2]] = vts.get(r[2], 0) + 1
    print(f"  unikátních idRegistration: {len(ids)}, idValueType četnosti: {vts}")
    print(f"  ukázka id: {sorted(ids)[:10]}")

    meta = json.loads(get(f"{ROOT}/air_quality/now/metadata/metadata.json")
                      .content.decode("utf-8", "replace"))
    loc = meta["data"]["Localities"]
    print(f"  Localities: {type(loc).__name__}, délka {len(loc)}")
    first = loc[0] if isinstance(loc, list) else loc
    print(f"  první lokalita klíče: {list(first.keys()) if isinstance(first, dict) else type(first)}")
    print(f"  první lokalita (oříznuto): {json.dumps(first, ensure_ascii=False)[:1500]}")

    # najdi, kde se vyskytuje některé idRegistration z CSV
    target = sorted(ids)[0]
    hit = json.dumps(loc, ensure_ascii=False)
    print(f"  hledám idRegistration {target!r} v Localities: "
          f"{'NALEZENO' if f'{target}' in hit else 'NENALEZENO'}")

    print("\n=== B) grids_CZ/climate_normals ===")
    p = "meteorology/products/grids_CZ/climate_normals/period_1991_2020/"
    for sub in ("air_temperature_mean/", "precipitation/", "sunshine_duration/"):
        f = ls(f"{p}{sub}", f"grids/{sub}", show=6)
        if f:
            u = f"{ROOT}/{p}{sub}{sorted(f)[0]}"
            r = get(u)
            print(f"    {sorted(f)[0]}: {len(r.content)} B, prvních 300 B: {r.content[:300]!r}")

    print("\n=== C) radiosounding _vypis_ CSV ===")
    f = ls("meteorology/weather/radiosounding/Praha/recent/ascent/", "ascent", show=6)
    vyp = [x for x in f if "vypis" in x]
    if vyp:
        r = get(f"{ROOT}/meteorology/weather/radiosounding/Praha/recent/ascent/{sorted(vyp)[-1]}")
        print(f"  {sorted(vyp)[-1]}: {len(r.content)} B")
        for line in r.content.decode("utf-8", "replace").splitlines()[:14]:
            print(f"    | {line[:200]}")

    print("\n=== D) regional_averages: kódování a oddělovače ===")
    for name, sub in (("Annual_areal_temperature_mean.csv", "temperature/"),
                      ("Monthly_areal_temperature_mean_2026.csv", "temperature/"),
                      ("Annual_areal_pecipitation.csv", "precipitation/"),
                      ("Normal_1991_2020_areal_temperature.csv", "temperature/")):
        r = get(f"{ROOT}/meteorology/products/regional_averages/{sub}{name}")
        if not r.ok:
            print(f"  {name}: HTTP {r.status_code}")
            continue
        raw = r.content
        print(f"  {name}: {len(raw)} B")
        for enc in ("utf-8", "windows-1250"):
            try:
                head = raw.decode(enc).splitlines()[0]
                print(f"    {enc}: {head[:160]}")
            except Exception as e:
                print(f"    {enc}: CHYBA {str(e)[:60]}")
        for line in raw.decode("windows-1250", "replace").splitlines()[1:3]:
            print(f"    | {line[:160]}")

    print("\n=== E) forecast/now GeoJSON — struktura featur ===")
    f = ls("meteorology/weather/forecast/now/", "forecast now", show=6)
    if f:
        j = json.loads(get(f"{ROOT}/meteorology/weather/forecast/now/{sorted(f)[-1]}")
                       .content.decode("utf-8", "replace"))
        feats = j["data"]["features"]
        print(f"  datovyTokID: {j.get('datovyTokID')}")
        print(f"  featur: {len(feats)}")
        for ft in feats[:3]:
            props = ft.get("properties", {})
            geom = ft.get("geometry", {})
            print(f"    geometry.type={geom.get('type')}, "
                  f"prstenců={len(geom.get('coordinates', []))}")
            print(f"    properties klíče: {list(props.keys())}")
            print(f"    properties: {json.dumps(props, ensure_ascii=False)[:900]}")
    # jaké různé datovyTokID existují napříč soubory?
    toks = {}
    for name in sorted(f)[-8:]:
        try:
            jj = json.loads(get(f"{ROOT}/meteorology/weather/forecast/now/{name}")
                            .content.decode("utf-8", "replace"))
            toks[name] = jj.get("datovyTokID")
        except Exception as e:
            toks[name] = f"CHYBA {str(e)[:40]}"
    print(f"  datovyTokID podle souboru: {json.dumps(toks, ensure_ascii=False, indent=2)[:1200]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
