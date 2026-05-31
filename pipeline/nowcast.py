"""
Fáze 2 — Nowcast core
- Konverze lokace na pixel (pyproj + ODIM /where metadata)
- dBZ → rain rate (Marshall–Palmer)
- Pohybové pole z MAX_Z dBZ sekvence (lucaskanade)
- Extrapolace 0–2 h — startovní pole z MERGE (zarovnané UTC), fallback MAX_Z
- Extrakce časové řady pro cílový pixel → data/nowcast.json
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer

from pysteps import motion, nowcasts
from pysteps.utils import transformation

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, DEFAULT_LAT, DEFAULT_LON, read_odim_dbz

# ── Konstanty ──────────────────────────────────────────────────────────────────
RAIN_THRESHOLD_MM_H = 0.1   # mm/h — práh pro "příchod srážek"
TIMESTEP_MIN        = 10    # minuty mezi extrapolovanými snímky
N_LEADTIMES         = 12    # 12 × 10 min = 2 h dopředu
MAX_MERGE_AGE_MIN   = 90    # pokud je MERGE starší, fallback na MAX_Z


# ── 1. Pixel lokace ────────────────────────────────────────────────────────────

def latlon_to_pixel(lat: float, lon: float, meta: dict) -> tuple[int, int]:
    """
    Převede zeměpisné souřadnice na (řádek, sloupec) v rastru.
    Čte projdef, xscale, yscale, LL/UR rohové souřadnice z ODIM /where — nic nehardcoduje.
    """
    t = Transformer.from_crs("EPSG:4326", meta["projdef"], always_xy=True)

    ll_x, ll_y = t.transform(meta["LL_lon"], meta["LL_lat"])
    ur_x, ur_y = t.transform(meta["UR_lon"], meta["UR_lat"])
    px,   py   = t.transform(lon, lat)

    col = (px - ll_x) / meta["xscale"]
    row = (ur_y - py) / meta["yscale"]   # řádek 0 = sever (UR)

    nrows, ncols = meta["shape"]
    row_i, col_i = int(round(row)), int(round(col))

    print(f"  ({lat}, {lon}) → pixel row={row_i}, col={col_i}  [grid {nrows}×{ncols}]")
    if not (0 <= row_i < nrows and 0 <= col_i < ncols):
        raise ValueError(
            f"Pixel ({row_i}, {col_i}) mimo grid {nrows}×{ncols}! "
            f"Zkontroluj projdef a rohové souřadnice."
        )
    return row_i, col_i


# ── 2. Načtení sekvence snímků ─────────────────────────────────────────────────

def load_sequence(files: list[Path]) -> tuple[np.ndarray, list[datetime]]:
    """Načte sekvenci HDF5, vrátí (stack [N,r,c] float32 dBZ s NaN, list UTC datetime)."""
    arrays, times = [], []
    for f in files:
        dbz, meta = read_odim_dbz(f)
        arrays.append(dbz)
        t = meta.get("utc_time")
        times.append(datetime.fromisoformat(t) if t else datetime.now(timezone.utc))
    return np.stack(arrays, axis=0), times


# ── 3. dBZ → rain rate (Marshall–Palmer) ──────────────────────────────────────

def dbz_to_rainrate(dbz: np.ndarray) -> np.ndarray:
    """
    Převede (N, r, c) nebo (r, c) dBZ pole na mm/h. NaN → NaN.
    Marshall–Palmer: Z = 200 * R^1.6
    """
    scalar = dbz.ndim == 2
    if scalar:
        dbz = dbz[np.newaxis]

    rr = np.full_like(dbz, np.nan)
    for i, frame in enumerate(dbz):
        mask = np.isnan(frame)
        tmp = frame.copy()
        tmp[mask] = -32.0   # pod prahem detekce → 0 mm/h
        rr_frame, _ = transformation.dBZ_to_rainrate(tmp, zr_a=200.0, zr_b=1.6)
        rr_frame[mask] = np.nan
        rr[i] = rr_frame

    return rr[0] if scalar else rr


# ── 4. Výběr startovního pole (MERGE zarovnaný na MAX_Z čas) ──────────────────

def pick_merge_start_field(
    merge_paths: list[Path],
    t0_maxz: datetime,
) -> tuple[np.ndarray | None, str]:
    """
    Najde MERGE snímek s největším timestampem ≤ t0_maxz a stáří ≤ MAX_MERGE_AGE_MIN.
    Vrátí (rain_rate_field nebo None, popis zdroje).
    """
    if not merge_paths:
        return None, "žádné MERGE soubory"

    best_path, best_time, best_age = None, None, float("inf")
    for p in merge_paths:
        try:
            _, meta = read_odim_dbz(p)
            t = datetime.fromisoformat(meta["utc_time"])
            age_min = (t0_maxz - t).total_seconds() / 60
            if 0 <= age_min < best_age:
                best_path, best_time, best_age = p, t, age_min
        except Exception as e:
            print(f"  MERGE {p.name}: chyba při čtení — {e}")

    if best_path is None or best_age > MAX_MERGE_AGE_MIN:
        return None, f"nejlepší MERGE stáří {best_age:.0f} min > limit {MAX_MERGE_AGE_MIN} min"

    dbz, _ = read_odim_dbz(best_path)
    rr = dbz_to_rainrate(dbz)
    print(f"  MERGE startovní pole: {best_path.name}  "
          f"(UTC {best_time.isoformat()}, stáří {best_age:.0f} min)")
    return rr, f"merge:{best_path.name}"


# ── 5. Pohybové pole + extrapolace ─────────────────────────────────────────────

def run_extrapolation(
    dbz_stack: np.ndarray,         # MAX_Z pro pohyb
    start_rr: np.ndarray,          # startovní pole rain rate (MERGE nebo MAX_Z[-1])
    n_leadtimes: int,
    timestep_min: int,
) -> np.ndarray:
    """
    Pohybové pole z MAX_Z dBZ (log-space — lepší gradient pro lucaskanade).
    Extrapoluje start_rr dopředu.
    Vrátí (n_leadtimes, rows, cols) float32 mm/h.
    """
    # lucaskanade na dBZ (NaN → 0 pro výpočet gradientů)
    dbz_clean = np.nan_to_num(dbz_stack, nan=0.0)
    oflow = motion.get_method("lucaskanade")
    motion_field = oflow(dbz_clean)   # vstup: (N≥2, r, c) → (2, r, c) UV

    # Extrapolace rain rate (NaN → 0)
    rr_clean = np.nan_to_num(start_rr, nan=0.0)
    extrap = nowcasts.get_method("extrapolation")
    forecast = extrap(
        rr_clean,
        motion_field,
        n_leadtimes,
        extrap_kwargs={"allow_nonfinite_values": True},
    )   # (n_leadtimes, r, c)

    return forecast.astype(np.float32)


# ── 6. Extrakce časové řady pro pixel ─────────────────────────────────────────

def extract_timeseries(
    forecast: np.ndarray,
    t0: datetime,
    row: int,
    col: int,
    timestep_min: int,
    threshold: float,
) -> dict:
    """Pro pixel (row, col) vrátí čas příchodu, špičku a úhrn z extrapolace."""
    n = forecast.shape[0]
    times_utc = [
        (t0 + timedelta(minutes=(i + 1) * timestep_min)).isoformat()
        for i in range(n)
    ]
    raw_vals = forecast[:, row, col]
    # NaN = mimo dosah extrapolace → žádné srážky
    values = [float(v) if not np.isnan(v) else 0.0 for v in raw_vals]

    arrival_utc = next((t for t, v in zip(times_utc, values) if v >= threshold), None)
    peak_mm_h   = max(values) if values else 0.0
    total_mm    = sum(values) * (timestep_min / 60.0)   # mm/h × h = mm

    return {
        "pixel":          {"row": row, "col": col},
        "t0_utc":         t0.isoformat(),
        "timestep_min":   timestep_min,
        "horizon_h":      n * timestep_min / 60,
        "threshold_mm_h": threshold,
        "arrival_utc":    arrival_utc,
        "peak_mm_h":      round(peak_mm_h, 2),
        "total_mm":       round(total_mm, 2),
        "timeseries": [
            {"time_utc": t, "mm_h": round(v, 3)}
            for t, v in zip(times_utc, values)
        ],
    }


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    meta_path = DATA_DIR / "radar_meta.json"
    if not meta_path.exists():
        print("ERROR: data/radar_meta.json nenalezen — spusť nejdřív ingest.py", file=sys.stderr)
        sys.exit(1)

    with open(meta_path) as f:
        radar_meta = json.load(f)

    # Deserializace metadat (JSON ukládá vše jako string)
    meta_latest = radar_meta["meta_latest"]
    shape_str = meta_latest.get("shape", "")
    if shape_str:
        meta_latest["shape"] = tuple(int(x) for x in shape_str.strip("()").split(","))
    for k in ("xscale", "yscale", "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if k in meta_latest and isinstance(meta_latest[k], str):
            meta_latest[k] = float(meta_latest[k])

    radar_dir = DATA_DIR / "radar"

    # ── 1. Pixel lokace ────────────────────────────────────────────────────────
    print(f"\n=== Pixel lokace ===")
    row_px, col_px = latlon_to_pixel(lat, lon, meta_latest)

    # ── 2. MAX_Z sekvence (pohyb) ──────────────────────────────────────────────
    print(f"\n=== MAX_Z sekvence ===")
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    missing = [p for p in maxz_paths if not p.exists()]
    if missing:
        print(f"ERROR: Chybí soubory: {missing}", file=sys.stderr)
        sys.exit(1)
    if len(maxz_paths) < 2:
        print("ERROR: Potřeba alespoň 2 MAX_Z snímky pro lucaskanade.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    t0 = maxz_times[-1]   # referenční čas nowcastu = nejnovější MAX_Z
    print(f"  Stack: {maxz_stack.shape},  t0 = {t0.isoformat()}")
    print(f"  Časy UTC: {[t.isoformat() for t in maxz_times]}")

    # ── 3. MERGE startovní pole (zarovnané na t0) ──────────────────────────────
    print(f"\n=== MERGE startovní pole ===")
    merge_paths = [radar_dir / "merge" / n for n in radar_meta.get("merge_files", [])]
    merge_paths = [p for p in merge_paths if p.exists()]

    start_rr, rr_source = pick_merge_start_field(merge_paths, t0)
    if start_rr is None:
        print(f"  Fallback na MAX_Z[-1] pro startovní pole ({rr_source})")
        start_rr = dbz_to_rainrate(maxz_stack[-1])
        rr_source = "maxz_fallback"
    else:
        print(f"  Startovní pole: MERGE  ({rr_source})")

    valid_rr = start_rr[~np.isnan(start_rr)]
    if valid_rr.size:
        print(f"  Rain rate: min={valid_rr.min():.3f}, max={valid_rr.max():.1f}, "
              f"mean={valid_rr.mean():.3f} mm/h")

    # ── 4. Extrapolace ─────────────────────────────────────────────────────────
    print(f"\n=== Extrapolace (lucaskanade z MAX_Z dBZ → {N_LEADTIMES}×{TIMESTEP_MIN} min) ===")
    forecast = run_extrapolation(maxz_stack, start_rr, N_LEADTIMES, TIMESTEP_MIN)
    print(f"  Forecast shape: {forecast.shape}")

    # ── 5. Časová řada ─────────────────────────────────────────────────────────
    print(f"\n=== Časová řada pro pixel ({row_px}, {col_px}) | t0={t0.isoformat()} ===")
    ts = extract_timeseries(forecast, t0, row_px, col_px, TIMESTEP_MIN, RAIN_THRESHOLD_MM_H)

    print(f"  Čas příchodu srážek : {ts['arrival_utc'] or 'žádné srážky v horizontu 2h'}")
    print(f"  Špičková intenzita  : {ts['peak_mm_h']} mm/h")
    print(f"  Odhad úhrnu (0–2 h) : {ts['total_mm']} mm")
    print(f"\n  Krok        UTC čas                mm/h")
    for i, step in enumerate(ts["timeseries"], 1):
        bar = "█" * int(min(step["mm_h"], 30) / 0.5)
        print(f"  +{i*TIMESTEP_MIN:3d} min  {step['time_utc']}  {step['mm_h']:6.3f}  {bar}")

    # ── Ulož ───────────────────────────────────────────────────────────────────
    out = {
        "location": {"lat": lat, "lon": lon},
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "motion_product":  "MAX_Z (lucaskanade)",
            "precip_product":  rr_source,
            "extrapolation":   "pysteps extrapolation",
            "valid_horizon_h": N_LEADTIMES * TIMESTEP_MIN / 60,
        },
        "nowcast": ts,
    }
    out_path = DATA_DIR / "nowcast.json"
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n✓ Fáze 2 — Nowcast OK → {out_path}")


if __name__ == "__main__":
    main()
