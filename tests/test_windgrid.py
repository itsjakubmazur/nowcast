"""
Testy pro pipeline/windgrid.py — hlavně cesty, které se v praxi spouští jen
při výpadku Open-Meteo, takže je jinak nikdo nikdy neuvidí až do chvíle,
kdy se vrstva větru na webu tiše rozbije.

Spouštění: python tests/test_windgrid.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import windgrid  # noqa: E402

FAILS = []


class _NoNet:
    """Testy nesmí sáhnout na síť: na CI runneru by fallback z Pages opravdu
    stáhl reálný wind_grid.json a případy "žádný minulý grid" by tiše zmizely."""

    headers = {}

    def get(self, *a, **kw):
        raise RuntimeError("test: síť je vypnutá")

    def mount(self, *a, **kw):
        pass


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def write_prev(tmp: Path, nx, ny, u_val, v_val, age_h):
    """Napíše fiktivní minulý wind_grid.json se zadaným stářím."""
    ref = (datetime.now(timezone.utc) - timedelta(hours=age_h)).isoformat()
    header = {
        "nx": nx, "ny": ny,
        "lo1": windgrid.LON_MIN, "la1": windgrid.LAT_MAX,
        "lo2": windgrid.LON_MAX, "la2": windgrid.LAT_MIN,
        "dx": windgrid.DLON, "dy": windgrid.DLAT,
        "refTime": ref, "parameterCategory": 2, "parameterUnit": "m.s-1",
    }
    data = [
        {"header": {**header, "parameterNumber": 2}, "data": [u_val] * (nx * ny)},
        {"header": {**header, "parameterNumber": 3}, "data": [v_val] * (nx * ny)},
    ]
    (tmp / "wind_grid.json").write_text(json.dumps(data))


def run_main_with(winds, tmp: Path):
    """Spustí main() s podvrženým fetch_wind a DATA_DIR v tmp."""
    orig_fetch, orig_dir = windgrid.fetch_wind, windgrid.DATA_DIR
    windgrid.fetch_wind = lambda points: winds
    windgrid.DATA_DIR = tmp
    try:
        windgrid.main()
        return True
    except SystemExit:
        return False
    finally:
        windgrid.fetch_wind, windgrid.DATA_DIR = orig_fetch, orig_dir


def load_out(tmp: Path):
    return json.loads((tmp / "wind_grid.json").read_text())


def main():
    windgrid.SESSION = _NoNet()
    points, nx, ny = windgrid.build_points()
    n = len(points)
    print(f"=== windgrid ({nx}×{ny} = {n} bodů) ===")

    # --- geometrie mřížky --------------------------------------------------
    check("mřížka je pravidelná a v pořadí sever→jih, západ→východ",
          points[0] == (windgrid.LAT_MAX, windgrid.LON_MIN)
          and points[nx - 1] == (windgrid.LAT_MAX, windgrid.LON_MAX)
          and points[-1] == (windgrid.LAT_MIN, windgrid.LON_MAX),
          f"{points[0]} {points[nx - 1]} {points[-1]}")

    # --- fill_holes --------------------------------------------------------
    vals = [1.0] * n
    vals[5 * nx + 5] = None                      # osamocená díra
    filled, cnt = windgrid.fill_holes(vals, nx, ny)
    check("fill_holes zalepí osamocenou díru průměrem sousedů",
          cnt == 1 and abs(filled[5 * nx + 5] - 1.0) < 1e-9, f"cnt={cnt}")

    vals = [None] * n
    for i in range(nx):
        vals[i] = 4.0                            # známý jen horní řádek
    filled, cnt = windgrid.fill_holes(vals, nx, ny, max_passes=50)
    check("fill_holes se šíří napříč mřížkou (žádné None nezůstane)",
          all(x is not None for x in filled) and cnt == n - nx, f"cnt={cnt}")

    vals = [None] * n
    filled, cnt = windgrid.fill_holes(vals, nx, ny)
    check("fill_holes bez jediné známé hodnoty nic nevymyslí",
          cnt == 0 and all(x is None for x in filled))

    # --- práh zápisu -------------------------------------------------------
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        winds = [(10.0, 270.0)] * int(n * 0.30) + [None] * (n - int(n * 0.30))
        wrote = run_main_with(winds, tmp)
        check("30 % bodů bez minulého gridu → soubor se NEPŘEPÍŠE",
              not wrote and not (tmp / "wind_grid.json").exists())

    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        write_prev(tmp, nx, ny, 3.0, 4.0, age_h=0.5)
        winds = [(10.0, 270.0)] * int(n * 0.30) + [None] * (n - int(n * 0.30))
        wrote = run_main_with(winds, tmp)
        out = load_out(tmp)
        # západní vítr (270°) → u = +2.78 m/s, v = 0
        u = out[0]["data"]
        check("30 % bodů s čerstvým minulým gridem → soubor SE přepíše", wrote)
        check("čerstvé body mají správné u (270° = západní vítr)",
              abs(u[0] - 2.78) < 0.02, f"u[0]={u[0]}")
        check("díry se vzaly z minulého gridu, ne z nuly",
              abs(u[-1] - 3.0) < 1e-9, f"u[-1]={u[-1]}")
        check("hlavička nese počet čerstvých bodů",
              out[0]["header"]["freshPoints"] == int(n * 0.30)
              and out[0]["header"]["totalPoints"] == n)

    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        write_prev(tmp, nx, ny, 3.0, 4.0, age_h=9.0)   # starý → nepoužitelný
        winds = [(10.0, 270.0)] * int(n * 0.30) + [None] * (n - int(n * 0.30))
        wrote = run_main_with(winds, tmp)
        check("30 % bodů + starý minulý grid → soubor se NEPŘEPÍŠE", not wrote)

    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        # 50 % bodů, bez minulého gridu → projde přes FRESH_MIN a díry se
        # dopočítají interpolací (žádná nula uprostřed pole)
        winds = [(18.0, 0.0) if i % 2 == 0 else None for i in range(n)]
        wrote = run_main_with(winds, tmp)
        out = load_out(tmp)
        u, v = out[0]["data"], out[1]["data"]
        check("50 % bodů bez minulého gridu → soubor se přepíše", wrote)
        check("žádný bod nezůstal nulový (interpolace zalepila díry)",
              all(abs(a) > 0.01 or abs(b) > 0.01 for a, b in zip(u, v)),
              f"nul: {sum(1 for a, b in zip(u, v) if abs(a) < 0.01 and abs(b) < 0.01)}")
        # severní vítr (0°) = fouká OD severu → v je záporné
        check("směr 0° dává záporné v (fouká od severu k jihu)",
              v[0] < -4.9, f"v[0]={v[0]}")
        check("u/v mají délku nx*ny", len(u) == n and len(v) == n)

    # --- geometrie minulého gridu se musí shodovat -------------------------
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        write_prev(tmp, nx + 1, ny, 3.0, 4.0, age_h=0.5)   # jiná šířka
        orig_dir = windgrid.DATA_DIR
        windgrid.DATA_DIR = tmp
        try:
            pu, pv, page = windgrid.load_previous(nx, ny)
        finally:
            windgrid.DATA_DIR = orig_dir
        check("minulý grid s jinou geometrií se ignoruje", pu is None)

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy windgrid prošly")


if __name__ == "__main__":
    main()
