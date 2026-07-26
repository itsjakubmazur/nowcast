"""
Výška horní hranice radarového odrazu (ODIM ETOP) — míra hloubky konvekce.

Proč to appce chybělo: bouřku dosud posuzujeme podle odrazivosti, jenže dBZ
neodliší mělkou přeháňku 45 dBZ od supercely 45 dBZ. Výška vrcholu ten rozdíl
vidí přímo.

Ověřeno sondou (běh 30219188301):
  composite/echotop/hdf5/T_PADV23_C_OKPR_{YYYYMMDDHHMMSS}.hdf   59 kB, co 5 min
  /dataset1/data1/what   gain 100.0 · offset 0.0 · nodata 255 · undetect 0
                         quantity HGHT
  /dataset1/what         product ETOP · prodpar 4.0
  /where                 identické s maxz (598×378, merc, 1555.7 m)

Dvě pasti:
  1) gain je 100, ne 0.5 jako u DBZH. read_odim_dbz() gain z atributů čte,
     takže vrátí rovnou METRY — ale výsledek NENÍ dBZ a nesmí projít
     dbz_to_rainrate(). Proto se tady proměnná jmenuje hght_m.
  2) prodpar=4.0 znamená výšku hladiny 4 dBZ, tedy spodní odhad vrcholu, ne
     skutečný vrchol oblaku. Je to konzistentní veličina, ale absolutní prahy
     na ni nesedí univerzálně — viz poznámka u SEVERITY_M.

Výstup: data/echotop.json
"""

import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, read_odim_dbz
from gridjoin import aligned_points, load_grid_json, load_radar_meta

BASE = ("https://opendata.chmi.cz/meteorology/weather/radar/composite/"
        "echotop/hdf5/")
FILE_RE = re.compile(r'href="(T_PADV23_C_OKPR_\d{14}\.hdf)"')
STAMP_RE = re.compile(r"_(\d{14})\.hdf")

TIMEOUT = (10, 60)
MAX_AGE_MIN = 20
BOX = 2       # ± pixelů po 1555,7 m → okno ~7,8 km kolem bodu

# Orientační prahy pro české LÉTO. Nejsou univerzální: výška vrcholu závisí na
# tropopauze a nulové izotermě, takže v lednu je 6 km hodně a v červenci málo.
# Proto se v JSONu posílá i percentil ze snímku — klient tak může posoudit
# "vysoko na dnešek", ne jen "vysoko podle tabulky".
SEVERITY_M = [
    (11000, "extrémní"),   # přestřelující vrchol, riziko krup a nárazů
    (8000,  "silná"),      # bouřka
    (5000,  "mírná"),      # konvekce
    (0,     "mělká"),      # vrstevnaté srážky
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def severity(top_m: float) -> str:
    for threshold, label in SEVERITY_M:
        if top_m >= threshold:
            return label
    return "mělká"


def fetch_latest() -> tuple[np.ndarray, datetime, float]:
    r = SESSION.get(BASE, timeout=TIMEOUT)
    r.raise_for_status()
    names = sorted(set(FILE_RE.findall(r.text)))
    if not names:
        raise RuntimeError("prázdný listing echotop")
    newest = names[-1]
    stamp = (datetime.strptime(STAMP_RE.search(newest).group(1), "%Y%m%d%H%M%S")
             .replace(tzinfo=timezone.utc))
    age = (datetime.now(timezone.utc) - stamp).total_seconds() / 60
    if age > MAX_AGE_MIN:
        raise RuntimeError(f"nejnovější snímek je {age:.0f} min starý "
                           f"(limit {MAX_AGE_MIN})")
    blob = SESSION.get(BASE + newest, timeout=TIMEOUT)
    blob.raise_for_status()
    hght_m, meta_h5 = read_odim_dbz(io.BytesIO(blob.content))

    # Kdyby ČHMÚ někdy změnilo jednotky, tichý přepočet by nadělal víc škody
    # než zastavení. gain 100 + quantity HGHT je to, co jsme naměřili.
    qty = (meta_h5.get("quantity") or "").upper()
    if qty and qty != "HGHT":
        raise RuntimeError(f"nečekaná veličina {qty!r} (čekáno HGHT)")
    return hght_m, stamp, age


def main():
    meta = load_radar_meta()
    if meta is None:
        print("echotop.py: radar_meta.json chybí — spusť nejdřív ingest.py",
              file=sys.stderr)
        return

    try:
        hght_m, stamp, age = fetch_latest()
    except Exception as e:
        print(f"echotop.py: {e} — vynechávám", file=sys.stderr)
        return

    if tuple(hght_m.shape) != tuple(meta["shape"]):
        print(f"echotop.py: tvar {hght_m.shape} ≠ maxz {meta['shape']} — "
              "ČHMÚ změnilo mřížku, vynechávám", file=sys.stderr)
        return

    finite = hght_m[np.isfinite(hght_m)]
    nrows, ncols = hght_m.shape

    tops = {}
    grid_json = load_grid_json()
    rebuilt = aligned_points(meta, grid_json) if grid_json else None
    if rebuilt:
        for i, (r_, c_, _lat, _lon) in enumerate(rebuilt):
            win = hght_m[max(0, r_ - BOX): min(nrows, r_ + BOX + 1),
                         max(0, c_ - BOX): min(ncols, c_ + BOX + 1)]
            if win.size and np.isfinite(win).any():
                top = float(np.nanmax(win))
                if top > 0:
                    tops[str(i)] = round(top)   # metry

    max_m = round(float(finite.max())) if finite.size else 0
    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "obs_utc": stamp.isoformat(),
        "age_min": round(age, 1),
        "source": "ČHMÚ ETOP (composite/echotop, hladina 4 dBZ)",
        "note": "spodní odhad vrcholu; prahy platí orientačně pro léto",
        "box_px": BOX,
        "box_km": round(BOX * 2 * 1.5557, 1),
        "grid_t0_utc": (grid_json or {}).get("t0_utc"),
        "n_pts": len(rebuilt) if rebuilt else 0,
        "max_m": max_m,
        "max_severity": severity(max_m),
        # percentily jen z bodů, kde vůbec něco je — jinak by je utopily NaN
        "p95_m": round(float(np.percentile(finite, 95))) if finite.size else 0,
        "p99_m": round(float(np.percentile(finite, 99))) if finite.size else 0,
        "coverage_pct": round(100.0 * finite.size / hght_m.size, 1),
        "thresholds_m": {label: m for m, label in SEVERITY_M},
        "tops_m": tops,
    }
    path = DATA_DIR / "echotop.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"echotop.py: {len(tops)} bodů, max {max_m} m ({out['max_severity']}), "
          f"p95 {out['p95_m']} m, pokrytí {out['coverage_pct']} %, "
          f"{path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
