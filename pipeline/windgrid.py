"""
Fáze 4d — Větrné pole pro animované částice (leaflet-velocity)

Stáhne aktuální vítr (10 m) na pravidelné mřížce přes ČR a okolí z Open-Meteo
a uloží data/wind_grid.json ve formátu, který čte leaflet-velocity (GRIB-like
JSON: U komponenta + V komponenta, řádky od severu k jihu, západ→východ).

Spolehlivost (proč to tu vypadá složitěji, než by "3 requesty" zasloužily):
z GitHub runnerů se občas nepovede TLS handshake na api.open-meteo.com.
requests to hlásí jako `Read timed out. (read timeout=10)`, což svádí k závěru
"API je pomalé" — ale ta desítka je CONNECT timeout: urllib3 používá stejnou
hlášku i pro fázi navazování spojení (_raise_timeout dostane conn.timeout).
Proto se tu nezvedá jen read timeout, ale hlavně:
  * batche jedou paralelně (jeden zaseknutý handshake nezdrží ostatní),
  * pokusy mají rostoucí connect timeout,
  * chybějící body se doplní z minulého gridu, jinak z okolí,
takže jeden výpadek už neshodí celou vrstvu.
"""

import json
import math
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter

# záměrně bez importu ingest.py — ten tahá h5py, které tenhle skript nepotřebuje
DATA_DIR = Path(__file__).parent.parent / "data"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
PAGES_BASE = "https://itsjakubmazur.github.io/nowcast"

# Mřížka: musí být PRAVIDELNÁ v obou osách (leaflet-velocity interpoluje
# bilineárně z rovnoměrného gridu). Pokrývá ČR s přesahem, ať částice
# nekončí na hranici výřezu.
LON_MIN, LON_MAX, DLON = 11.5, 19.5, 0.5    # 17 sloupců
LAT_MAX, LAT_MIN, DLAT = 51.50, 48.25, 0.25 # 14 řádků, od severu k jihu

OM_BATCH = 60          # menší dávky = kratší request, výpadek stojí míň bodů
MAX_WORKERS = 4        # 4 souběžné requesty jsou hluboko pod limity Open-Meteo
# (connect, read) pro jednotlivé pokusy — roste hlavně connect, viz docstring
ATTEMPT_TIMEOUTS = [(12, 30), (20, 45), (30, 60)]
BUDGET_S = 100         # tvrdý strop, ať krok pipeline nikdy nevisí

# Kolik čerstvých bodů musí dorazit, aby se soubor přepsal
FRESH_MIN = 0.40       # bez použitelného minulého gridu
MERGE_MIN = 0.15       # když je čím díry zalepit, stačí míň
PREV_MAX_AGE_H = 3.0   # starší grid už není lepší než interpolace ze sousedů


def _session() -> requests.Session:
    """Session s keep-alive — opakovaný pokus pak neplatí nový TLS handshake."""
    s = requests.Session()
    s.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})
    adapter = HTTPAdapter(pool_connections=2, pool_maxsize=4)
    s.mount("https://", adapter)
    return s


# requests.Session není oficiálně thread-safe, a batche teď jedou paralelně —
# každé vlákno proto dostane vlastní. Keep-alive se tím neztrácí: opakované
# pokusy téhož batche běží ve stejném vlákně, takže recyklují spojení.
SESSION = _session()          # hlavní vlákno (load_previous) + bod pro testy
_LOCAL = threading.local()


def _thread_session() -> requests.Session:
    if getattr(_LOCAL, "session", None) is None:
        _LOCAL.session = _session()
    return _LOCAL.session


def build_points():
    """Body v pořadí, v jakém je čte leaflet-velocity: řádky sever→jih, v řádku západ→východ."""
    pts = []
    ny = int(round((LAT_MAX - LAT_MIN) / DLAT)) + 1
    nx = int(round((LON_MAX - LON_MIN) / DLON)) + 1
    for iy in range(ny):
        lat = LAT_MAX - iy * DLAT
        for ix in range(nx):
            lon = LON_MIN + ix * DLON
            pts.append((round(lat, 4), round(lon, 4)))
    return pts, nx, ny


def _fetch_batch(idx: int, start: int, chunk: list, deadline: float) -> tuple[int, list]:
    """Stáhne jednu dávku. Vrací (start, [(spd, dir) | None, ...])."""
    params = {
        "latitude": ",".join(str(p[0]) for p in chunk),
        "longitude": ",".join(str(p[1]) for p in chunk),
        "current": "wind_speed_10m,wind_direction_10m",
        "timezone": "UTC",
    }
    res = [None] * len(chunk)
    for attempt, tmo in enumerate(ATTEMPT_TIMEOUTS):
        if time.monotonic() > deadline:
            print(f"  wind batch {idx}: vyčerpaný rozpočet, končím s tím, co je", file=sys.stderr)
            break
        try:
            r = _thread_session().get(OPEN_METEO_URL, params=params, timeout=tmo)
            r.raise_for_status()
            data = r.json()
            items = data if isinstance(data, list) else [data]
            for i, item in enumerate(items):
                if i >= len(res):
                    break
                cur = item.get("current", {}) or {}
                spd, wdir = cur.get("wind_speed_10m"), cur.get("wind_direction_10m")
                if spd is not None and wdir is not None:
                    res[i] = (float(spd), float(wdir))
            return start, res
        except Exception as e:
            # POZOR: "Read timed out. (read timeout=X)" tady bývá ve skutečnosti
            # timeout PŘIPOJENÍ (X = connect timeout), ne pomalá odpověď.
            # Z hlášky se vyhazuje URL — requests do ní cpe všech 60 souřadnic,
            # takže by jeden výpadek zaplavil celý log CI. Příčina zůstává.
            msg = re.sub(r"(url: )\S+", r"\1…", str(e))[:240]
            print(f"  wind batch {idx} pokus {attempt + 1}/{len(ATTEMPT_TIMEOUTS)} "
                  f"(connect {tmo[0]}s / read {tmo[1]}s): {msg}", file=sys.stderr)
            if attempt < len(ATTEMPT_TIMEOUTS) - 1:
                time.sleep(1.5 * (attempt + 1) + random.uniform(0, 1.0))
    return start, res


def fetch_wind(points):
    """Vrátí seznam (speed_kmh, dir_deg) ve stejném pořadí jako points; None při výpadku."""
    out = [None] * len(points)
    batches = [(i, s, points[s:s + OM_BATCH])
               for i, s in enumerate(range(0, len(points), OM_BATCH))]
    deadline = time.monotonic() + BUDGET_S
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(batches))) as ex:
        futures = [ex.submit(_fetch_batch, i, s, c, deadline) for i, s, c in batches]
        for f in futures:
            try:
                start, res = f.result()
            except Exception as e:      # pojistka, _fetch_batch chyby polyká sám
                print(f"  wind batch selhal neočekávaně: {e}", file=sys.stderr)
                continue
            for i, v in enumerate(res):
                if v is not None:
                    out[start + i] = v
    return out


def load_previous(nx: int, ny: int):
    """Minulý wind_grid.json (lokálně z cache, jinak z Pages) → (u, v, stáří_h).

    Slouží k zalepení děr: bod, který teď nedorazil, radši ukáže hodnotu z
    minulého běhu než tvrdou nulu (= vizuální bezvětří, které tam není).
    """
    raw = None
    path = DATA_DIR / "wind_grid.json"
    if path.exists():
        try:
            raw = json.loads(path.read_text())
        except Exception as e:
            print(f"  minulý wind_grid.json nečitelný: {e}", file=sys.stderr)
    if raw is None:
        try:
            r = SESSION.get(f"{PAGES_BASE}/data/wind_grid.json", timeout=(10, 20))
            if r.ok:
                raw = r.json()
        except Exception as e:
            print(f"  minulý wind_grid.json z Pages nedostupný: {e}", file=sys.stderr)
    if not isinstance(raw, list) or len(raw) < 2:
        return None, None, None

    try:
        h = raw[0]["header"]
        if (h["nx"], h["ny"], h["lo1"], h["la1"], h["dx"], h["dy"]) != \
           (nx, ny, LON_MIN, LAT_MAX, DLON, DLAT):
            print("  minulý grid má jinou geometrii — ignoruji", file=sys.stderr)
            return None, None, None
        u, v = raw[0]["data"], raw[1]["data"]
        if len(u) != nx * ny or len(v) != nx * ny:
            return None, None, None
        ref = datetime.fromisoformat(h["refTime"])
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=timezone.utc)
        age_h = (datetime.now(timezone.utc) - ref).total_seconds() / 3600
        return u, v, age_h
    except Exception as e:
        print(f"  minulý grid nemá čekaný tvar: {e}", file=sys.stderr)
        return None, None, None


def fill_holes(vals, nx, ny, max_passes=8):
    """Doplní None průměrem známých sousedů (4-okolí), iterativně od okrajů díry.

    Pro vítr je to poctivější než nula: pole je hladké, takže interpolace přes
    jeden–dva kroky mřížky (0.25–0.5°) je věcně blízko, kdežto nula by vykreslila
    ostrůvek bezvětří tam, kde jen selhal request.
    """
    out = list(vals)
    filled = 0
    for _ in range(max_passes):
        missing = [i for i, x in enumerate(out) if x is None]
        if not missing:
            break
        updates = {}
        for i in missing:
            iy, ix = divmod(i, nx)
            acc, n = 0.0, 0
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                jy, jx = iy + dy, ix + dx
                if 0 <= jy < ny and 0 <= jx < nx:
                    nb = out[jy * nx + jx]
                    if nb is not None:
                        acc += nb
                        n += 1
            if n:
                updates[i] = acc / n
        if not updates:
            break
        for i, val in updates.items():
            out[i] = val
            filled += 1
    return out, filled


def main():
    points, nx, ny = build_points()
    n_total = len(points)
    print(f"=== Větrné pole ({nx}×{ny} bodů, {LON_MIN}–{LON_MAX}E / {LAT_MIN}–{LAT_MAX}N) ===")
    t0 = time.monotonic()
    winds = fetch_wind(points)
    n_ok = sum(1 for w in winds if w)
    print(f"  Získáno {n_ok}/{n_total} bodů za {time.monotonic() - t0:.1f}s")

    prev_u, prev_v, prev_age = load_previous(nx, ny)
    prev_usable = prev_u is not None and prev_age is not None and prev_age <= PREV_MAX_AGE_H
    if prev_u is not None and not prev_usable:
        print(f"  minulý grid je starý {prev_age:.1f} h — na lepení děr ho nepoužiju",
              file=sys.stderr)

    if n_ok < n_total * FRESH_MIN and not (prev_usable and n_ok >= n_total * MERGE_MIN):
        print(f"  Příliš málo dat ({n_ok}/{n_total}) — wind_grid.json nepřepisuji",
              file=sys.stderr)
        raise SystemExit(0)  # měkké selhání: stará vrstva zůstane

    # 1) čerstvé hodnoty → u/v, díry zatím None
    u_data, v_data = [], []
    for w in winds:
        if not w:
            u_data.append(None)
            v_data.append(None)
            continue
        spd_ms = w[0] / 3.6
        theta = math.radians(w[1])  # meteorologický směr = ODKUD fouká
        u_data.append(-spd_ms * math.sin(theta))
        v_data.append(-spd_ms * math.cos(theta))

    # 2) díry z minulého gridu (reálná hodnota v tom bodě, jen o běh starší)
    from_prev = 0
    if prev_usable:
        for i in range(n_total):
            if u_data[i] is None and prev_u[i] is not None and prev_v[i] is not None:
                u_data[i], v_data[i] = float(prev_u[i]), float(prev_v[i])
                from_prev += 1

    # 3) co zbylo, dopočítat ze sousedů; až úplně nakonec nula
    u_data, fu = fill_holes(u_data, nx, ny)
    v_data, fv = fill_holes(v_data, nx, ny)
    from_interp = max(fu, fv)
    n_zero = sum(1 for x in u_data if x is None)
    u_data = [round(x, 2) if x is not None else 0.0 for x in u_data]
    v_data = [round(x, 2) if x is not None else 0.0 for x in v_data]

    if from_prev or from_interp or n_zero:
        src = f"{from_prev} z minulého gridu (stáří {prev_age:.1f} h)" if from_prev \
            else "0 z minulého gridu"
        print(f"  Díry: {src}, {from_interp} interpolací ze sousedů, {n_zero} nulou",
              file=sys.stderr)

    ref_time = datetime.now(timezone.utc).isoformat()
    header_common = {
        "nx": nx, "ny": ny,
        "lo1": LON_MIN, "la1": LAT_MAX,   # levý horní roh (sever, západ)
        "lo2": LON_MAX, "la2": LAT_MIN,
        "dx": DLON, "dy": DLAT,
        "refTime": ref_time,
        "forecastTime": 0,                # analýza, ne předpověď — bez tohohle
                                          # dělá leaflet-velocity Invalid Date
                                          # (dělá refTime + forecastTime hodin)
        "parameterCategory": 2,           # momentum
        "parameterUnit": "m.s-1",
        # vlastní metadata (leaflet-velocity neznámé klíče ignoruje) — ať je
        # z frontendu i z logu poznat, kolik pole je opravdu čerstvé
        "freshPoints": n_ok,
        "totalPoints": n_total,
    }
    out = [
        {"header": {**header_common, "parameterNumber": 2, "parameterNumberName": "eastward_wind"}, "data": u_data},
        {"header": {**header_common, "parameterNumber": 3, "parameterNumberName": "northward_wind"}, "data": v_data},
    ]
    path = DATA_DIR / "wind_grid.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"✓ Fáze 4d — wind_grid.json ({path.stat().st_size // 1024} kB, "
          f"{n_ok}/{n_total} bodů čerstvých)")


if __name__ == "__main__":
    main()
