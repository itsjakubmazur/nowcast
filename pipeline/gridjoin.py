"""
Sdílené napojení doplňkových radarových produktů na mřížku z grid.py.

Proč to existuje: chmi_fct.py i echotop.py potřebují pro každý bod mřížky
pixel (row, col) v radarovém rastru. V forecast_grid.json je ale uloženo
`pts = [[lat, lon], ...]` — NE [row, col]. Kdo by to spletl, indexoval by
rastr zeměpisnou šířkou a dostal by nesmyslná čísla bez jediné chyby.

Řešení: mřížku přepočítáme toutéž funkcí build_grid() a týmiž metadaty jako
grid.py. Je deterministická, takže pořadí bodů vyjde stejné — a shodu si
ještě ověříme proti lat/lon v JSONu, aby se to nemohlo tiše rozejít.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR

# Tolerance shody souřadnic. grid.py ukládá lat/lon zaokrouhlené na 3 desetinná
# místa, takže půlka posledního místa je nejtěsnější mez, která ještě nepráská
# na zaokrouhlení.
COORD_EPS = 0.0006


def load_radar_meta() -> dict | None:
    """Metadata rastru z ingestu, se stringy převedenými zpět na čísla."""
    p = DATA_DIR / "radar_meta.json"
    if not p.exists():
        return None
    try:
        meta = json.loads(p.read_text())["meta_latest"]
    except Exception:
        return None
    shape = meta.get("shape")
    if isinstance(shape, str):
        meta["shape"] = tuple(int(x) for x in shape.strip("()").split(","))
    elif isinstance(shape, (list, tuple)):
        meta["shape"] = tuple(int(x) for x in shape)
    for k in ("xscale", "yscale", "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if isinstance(meta.get(k), str):
            meta[k] = float(meta[k])
    return meta


def load_grid_json() -> dict | None:
    p = DATA_DIR / "forecast_grid.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def aligned_points(meta: dict, grid_json: dict) -> list | None:
    """
    Vrátí [(row, col, lat, lon)] ve stejném pořadí jako grid_json["pts"],
    nebo None, když se mřížky rozejdou.

    Rozejít se můžou legitimně: grid.py běžel nad jiným snímkem, ČHMÚ změnilo
    rastr, změnil se GRID_STEP_M. Ve všech případech je správná reakce
    nepřipojit se, ne hádat.
    """
    from grid import GRID_STEP_M, build_grid

    pts = grid_json.get("pts") or []
    rebuilt = build_grid(meta, GRID_STEP_M)
    if len(rebuilt) != len(pts):
        print(f"gridjoin: mřížka má {len(rebuilt)} bodů, forecast_grid.json {len(pts)} "
              "— nenapojuji", file=sys.stderr)
        return None

    # Namátková kontrola souřadnic — stačí kraje a střed, ne všech ~900 bodů.
    for i in (0, len(pts) // 2, len(pts) - 1):
        _, _, lat, lon = rebuilt[i]
        plat, plon = pts[i][0], pts[i][1]
        if abs(lat - plat) > COORD_EPS or abs(lon - plon) > COORD_EPS:
            print(f"gridjoin: bod {i} sedí jinam ({lat},{lon}) vs ({plat},{plon}) "
                  "— nenapojuji", file=sys.stderr)
            return None
    return rebuilt
