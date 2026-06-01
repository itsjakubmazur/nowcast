"""
Fáze 4a — Mřížka po ČR
- Vygeneruje pravidelnou mřížku bodů po ČR (krok 10 km v projekci radaru).
- Advekci spočítá JEN JEDNOU pro celé pole; z hotového forecastu jen vyčítá pixely.
- NWP nestahuje 900×: použije hrubou podmřížku (~30 km) a Open-Meteo multi-location
  (víc bodů v JEDNOM HTTP requestu). Frontend pak bere nejbližší NWP bod.
- Výstrahy ČHMÚ matchuje na bod přes point-in-polygon (CAP <polygon>).
- Výstup: data/forecast_grid.json — kompaktní, jen aktivní body mají časovou řadu.
"""

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, OPEN_METEO_URL, read_odim_dbz
from nowcast import (
    RAIN_THRESHOLD_MM_H, TIMESTEP_MIN, N_LEADTIMES, MAX_MERGE_AGE_MIN,
    load_sequence, dbz_to_rainrate, pick_merge_start_field, run_extrapolation,
)
from fuse import fetch_all_active_warnings

# ── Konfigurace mřížky ──────────────────────────────────────────────────────────
GRID_STEP_M       = 10_000   # krok jemné mřížky (nowcast) v metrech projekce
NWP_STEP_M        = 30_000   # krok hrubé NWP podmřížky
OM_BATCH          = 100      # kolik lokací poslat Open-Meteo v jednom requestu

# Bounding box ČR (lat/lon) — ořízne body radarového gridu mimo ČR (DE/PL/AT/SK)
CZ_LAT_MIN, CZ_LAT_MAX = 48.5, 51.1
CZ_LON_MIN, CZ_LON_MAX = 12.0, 18.9


# ── Pomocné geo funkce ──────────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def point_in_polygon(lat: float, lon: float, poly: list) -> bool:
    """Ray-casting. poly = [[lat,lon], ...]. Test v rovině lat/lon (pro malé oblasti OK)."""
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = poly[i][0], poly[i][1]
        yj, xj = poly[j][0], poly[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


# ── Generování mřížky v projekci ──────────────────────────────────────────────

def build_grid(meta: dict, step_m: float):
    """
    Vrátí list bodů (row, col, lat, lon) na pravidelné mřížce v projekci radaru,
    omezené na radarový grid i bbox ČR. Krok je konstantní v metrech projekce.
    """
    fwd = Transformer.from_crs("EPSG:4326", meta["projdef"], always_xy=True)
    inv = Transformer.from_crs(meta["projdef"], "EPSG:4326", always_xy=True)

    ll_x, ll_y = fwd.transform(meta["LL_lon"], meta["LL_lat"])
    ur_x, ur_y = fwd.transform(meta["UR_lon"], meta["UR_lat"])
    nrows, ncols = meta["shape"]
    xscale, yscale = meta["xscale"], meta["yscale"]

    x0, x1 = min(ll_x, ur_x), max(ll_x, ur_x)
    y0, y1 = min(ll_y, ur_y), max(ll_y, ur_y)

    points = []
    y = y0
    while y <= y1:
        x = x0
        while x <= x1:
            lon, lat = inv.transform(x, y)
            if (CZ_LAT_MIN <= lat <= CZ_LAT_MAX) and (CZ_LON_MIN <= lon <= CZ_LON_MAX):
                col = int(round((x - ll_x) / xscale))
                row = int(round((ur_y - y) / yscale))
                if 0 <= row < nrows and 0 <= col < ncols:
                    points.append((row, col, round(lat, 3), round(lon, 3)))
            x += step_m
        y += step_m
    return points


# ── NWP přes Open-Meteo multi-location (batchované) ──────────────────────────────

def fetch_nwp_grid(nwp_points: list) -> tuple[list, int]:
    """
    Stáhne NWP pro hrubou podmřížku. Open-Meteo umí víc lokací v jednom requestu
    (latitude/longitude jako comma-separated). Vrátí (list NWP záznamů, počet HTTP requestů).
    Každý záznam: [lat, lon, rain_from_utc|None, peak_gusts_ms, max_cape].
    """
    now_utc = datetime.now(timezone.utc)
    results = []
    http_calls = 0

    for start in range(0, len(nwp_points), OM_BATCH):
        chunk = nwp_points[start:start + OM_BATCH]
        lats = ",".join(f"{p[2]:.3f}" for p in chunk)
        lons = ",".join(f"{p[3]:.3f}" for p in chunk)
        params = {
            "latitude":  lats,
            "longitude": lons,
            "minutely_15": "precipitation,windgusts_10m",
            "hourly":      "precipitation,windgusts_10m,cape",
            "timezone": "UTC",
            "forecast_days": 1,
            "models": "icon_d2",
        }
        try:
            r = requests.get(OPEN_METEO_URL, params=params, timeout=(5, 30))
            http_calls += 1
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  NWP batch {start//OM_BATCH}: chyba {e} — body bez NWP")
            for p in chunk:
                results.append([p[2], p[3], None, None, None])
            continue

        # Open-Meteo vrací list (víc lokací) nebo dict (jedna lokace)
        items = data if isinstance(data, list) else [data]
        for p, item in zip(chunk, items):
            rec = _summarize_nwp(item, now_utc)
            results.append([p[2], p[3], rec[0], rec[1], rec[2]])

    return results, http_calls


def _summarize_nwp(item: dict, now_utc: datetime):
    """Z jedné Open-Meteo odpovědi vytáhne (rain_from_utc, peak_gusts_ms, max_cape)."""
    def _to_utc(s):
        return s if ("+" in s or s.endswith("Z")) else s + "+00:00"

    rain_from = None
    m15 = item.get("minutely_15", {})
    times = m15.get("time", []) or []
    precip = m15.get("precipitation", []) or []
    gusts = m15.get("windgusts_10m", []) or []
    for t, v in zip(times, precip):
        if v is not None and v >= RAIN_THRESHOLD_MM_H:
            tt = datetime.fromisoformat(_to_utc(t))
            if tt >= now_utc:
                rain_from = tt.isoformat()
                break

    hourly = item.get("hourly", {})
    h_precip = hourly.get("precipitation", []) or []
    h_times = hourly.get("time", []) or []
    h_gusts = hourly.get("windgusts_10m", []) or []
    h_cape = hourly.get("cape", []) or []

    # Fallback hledání deště v hourly
    if rain_from is None:
        for t, v in zip(h_times, h_precip):
            if v is not None and v >= RAIN_THRESHOLD_MM_H:
                tt = datetime.fromisoformat(_to_utc(t))
                if tt >= now_utc:
                    rain_from = tt.isoformat()
                    break

    gust_vals = [g for g in (gusts + h_gusts) if g is not None]
    peak_gusts_kmh = max(gust_vals) if gust_vals else None
    peak_gusts_ms = round(peak_gusts_kmh / 3.6, 1) if peak_gusts_kmh is not None else None

    cape_vals = [c for c in h_cape if c is not None]
    max_cape = round(max(cape_vals)) if cape_vals else None

    return rain_from, peak_gusts_ms, max_cape


# ── Hlavní tok ───────────────────────────────────────────────────────────────────

def main():
    meta_path = DATA_DIR / "radar_meta.json"
    if not meta_path.exists():
        print("ERROR: data/radar_meta.json nenalezen — spusť nejdřív ingest.py", file=sys.stderr)
        sys.exit(1)

    with open(meta_path) as f:
        radar_meta = json.load(f)

    meta = radar_meta["meta_latest"]
    shape_str = meta.get("shape", "")
    if shape_str:
        meta["shape"] = tuple(int(x) for x in shape_str.strip("()").split(","))
    for k in ("xscale", "yscale", "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if k in meta and isinstance(meta[k], str):
            meta[k] = float(meta[k])

    radar_dir = DATA_DIR / "radar"

    # ── 1. Advekce JEDNOU pro celé pole ─────────────────────────────────────────
    print("\n=== Advekce (jednou pro celou ČR) ===")
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 2:
        print("ERROR: Potřeba ≥ 2 MAX_Z snímky.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    t0 = maxz_times[-1]
    print(f"  Stack {maxz_stack.shape}, t0={t0.isoformat()}")

    merge_paths = [radar_dir / "merge" / n for n in radar_meta.get("merge_files", [])]
    merge_paths = [p for p in merge_paths if p.exists()]
    start_rr, rr_source = pick_merge_start_field(merge_paths, t0)
    if start_rr is None:
        start_rr = dbz_to_rainrate(maxz_stack[-1])
        rr_source = "maxz_fallback"
    print(f"  Startovní pole: {rr_source}")

    forecast = run_extrapolation(maxz_stack, start_rr, N_LEADTIMES, TIMESTEP_MIN)
    print(f"  Forecast pole: {forecast.shape}  (sampluju ho pro VŠECHNY body mřížky)")

    # ── 2. Jemná mřížka (10 km) — sampling pixelů ────────────────────────────────
    print("\n=== Jemná mřížka (nowcast) ===")
    grid = build_grid(meta, GRID_STEP_M)
    print(f"  Bodů v ČR uvnitř radaru: {len(grid)}")

    pts, act = [], {}
    active_count = 0
    for idx, (row, col, lat, lon) in enumerate(grid):
        pts.append([lat, lon])
        vals = forecast[:, row, col]
        vals = [float(v) if not np.isnan(v) else 0.0 for v in vals]
        peak = max(vals) if vals else 0.0
        if peak >= RAIN_THRESHOLD_MM_H:
            arr = next((i for i, v in enumerate(vals) if v >= RAIN_THRESHOLD_MM_H), -1)
            end = next((i for i in range(len(vals) - 1, -1, -1)
                        if vals[i] >= RAIN_THRESHOLD_MM_H), -1)
            total = round(sum(vals) * (TIMESTEP_MIN / 60.0), 1)
            act[str(idx)] = [arr, end, round(peak, 1), total]
            active_count += 1
    print(f"  Aktivních bodů (srážky ≥ {RAIN_THRESHOLD_MM_H} mm/h): {active_count}")

    # ── 3. NWP hrubá podmřížka (batchovaný Open-Meteo) ──────────────────────────
    print("\n=== NWP hrubá podmřížka (Open-Meteo multi-location) ===")
    nwp_grid_pts = build_grid(meta, NWP_STEP_M)
    print(f"  NWP bodů: {len(nwp_grid_pts)}  (krok {NWP_STEP_M//1000} km)")
    nwp_records, http_calls = fetch_nwp_grid(nwp_grid_pts)
    print(f"  Open-Meteo HTTP requestů: {http_calls}  (pro {len(nwp_records)} bodů)")

    # ── 4. Výstrahy ČHMÚ + point-in-polygon match ───────────────────────────────
    print("\n=== Výstrahy ČHMÚ (celostátní) + polygon match ===")
    try:
        warnings = fetch_all_active_warnings()
    except Exception as e:
        print(f"  Varování: fetch selhal: {e}")
        warnings = []

    # Zmenši výstrahy pro JSON (polygon necháme, ale jen pro match — do výstupu dáme bez polygonů)
    wmatch = {}
    for idx, (row, col, lat, lon) in enumerate(grid):
        hit = []
        for wi, w in enumerate(warnings):
            polys = w.get("polygons", [])
            if not polys:
                continue
            if any(point_in_polygon(lat, lon, poly) for poly in polys):
                hit.append(wi)
        if hit:
            wmatch[str(idx)] = hit
    matched_pts = len(wmatch)
    print(f"  Bodů s navázanou výstrahou (polygon): {matched_pts}")

    # Výstrahy bez polygonu = celostátní → flag global=True (JS je zobrazí všude)
    warnings_out = []
    for w in warnings:
        warnings_out.append({
            "event":       w["event"],
            "color":       w["color"],
            "severity":    w["severity"],
            "onset_utc":   w["onset_utc"],
            "expires_utc": w["expires_utc"],
            "areas":       w.get("areas", [])[:3],
            "global":      not bool(w.get("polygons")),
        })

    # ── 5. Ulož kompaktní JSON ───────────────────────────────────────────────────
    out = {
        "t0_utc":          t0.isoformat(),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "step_min":        TIMESTEP_MIN,
        "n_steps":         N_LEADTIMES,
        "grid_step_km":    GRID_STEP_M // 1000,
        "threshold_mm_h":  RAIN_THRESHOLD_MM_H,
        "nowcast_source":  rr_source,
        "pts":             pts,
        "act":             act,
        "warnings":        warnings_out,
        "wmatch":          wmatch,
        "nwp": {
            "step_km": NWP_STEP_M // 1000,
            "pts":     nwp_records,
        },
    }
    out_path = DATA_DIR / "forecast_grid.json"
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"\n✓ Fáze 4a — Mřížka OK → {out_path}")
    print(f"  Velikost JSON: {size_kb:.1f} kB")
    print(f"  Body: {len(pts)} (aktivní {active_count}) | NWP: {len(nwp_records)} "
          f"| Výstrahy: {len(warnings_out)} | HTTP Open-Meteo: {http_calls}")


if __name__ == "__main__":
    main()
