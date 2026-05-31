"""
Fáze 2 — Nowcast core
- Konverze lokace na pixel (pyproj + ODIM /where metadata)
- dBZ → rain rate (Marshall–Palmer)
- Odhad pohybového pole (pysteps lucaskanade, z MAX_Z)
- Extrapolace 0–2 h (pysteps extrapolation nowcast)
- Extrakce časové řady pro cílový pixel → data/nowcast.json
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from pyproj import Transformer

# pysteps importy
import pysteps
from pysteps import motion, nowcasts
from pysteps.utils import transformation

# Sdílené funkce z ingest
sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, DEFAULT_LAT, DEFAULT_LON, read_odim_dbz

import os

# ── Konstanty ──────────────────────────────────────────────────────────────────
RAIN_THRESHOLD_MM_H = 0.1   # mm/h — práh pro "příchod srážek"
TIMESTEP_MIN        = 10    # minuty mezi extrapolovanými snímky
N_LEADTIMES         = 12    # 12 × 10 min = 2 h dopředu


# ── 1. Pixel lokace ────────────────────────────────────────────────────────────

def latlon_to_pixel(lat: float, lon: float, meta: dict) -> tuple[int, int]:
    """
    Převede zeměpisné souřadnice na (řádek, sloupec) v rastru.
    Čte projdef, xscale, yscale, LL_lon, LL_lat, UR_lon, UR_lat z ODIM /where metadat.
    Žádná hodnota není hardcodována.
    """
    projdef = meta["projdef"]
    xscale  = meta["xscale"]   # šířka pixelu v proj. jednotkách (m)
    yscale  = meta["yscale"]   # výška pixelu v proj. jednotkách (m)

    # Rohové souřadnice gridu v proj. prostoru
    t = Transformer.from_crs("EPSG:4326", projdef, always_xy=True)
    ll_x, ll_y = t.transform(meta["LL_lon"], meta["LL_lat"])
    ur_x, ur_y = t.transform(meta["UR_lon"], meta["UR_lat"])

    # Cílový bod
    px, py = t.transform(lon, lat)

    # Sloupec: od levého okraje
    col = (px - ll_x) / xscale
    # Řádek: od horního okraje (řádek 0 = sever = UR)
    row = (ur_y - py) / yscale

    nrows, ncols = meta["shape"]
    row_i = int(round(row))
    col_i = int(round(col))

    print(f"  Lokace ({lat}, {lon}) → pixel (row={row_i}, col={col_i}), "
          f"grid {nrows}×{ncols}")
    if not (0 <= row_i < nrows and 0 <= col_i < ncols):
        raise ValueError(
            f"Pixel ({row_i}, {col_i}) leží mimo grid {nrows}×{ncols}! "
            f"Zkontroluj projdef a rohové souřadnice."
        )
    return row_i, col_i


# ── 2. Načtení sekvence snímků ─────────────────────────────────────────────────

def load_sequence(files: list[Path]) -> tuple[np.ndarray, list[datetime]]:
    """
    Načte sekvenci HDF5 snímků, zamaskuje nodata/undetect → NaN.
    Vrátí (stack [N, rows, cols] float32, list UTC datetime).
    """
    arrays, times = [], []
    for f in files:
        dbz, meta = read_odim_dbz(f)
        arrays.append(dbz)
        if "utc_time" in meta:
            times.append(datetime.fromisoformat(meta["utc_time"]))
        else:
            times.append(datetime.now(timezone.utc))
    return np.stack(arrays, axis=0), times


# ── 3. dBZ → rain rate (Marshall–Palmer) ──────────────────────────────────────

def dbz_to_rainrate(dbz_stack: np.ndarray) -> np.ndarray:
    """
    Převede pole dBZ na mm/h přes Marshall–Palmer Z–R vztah.
    NaN zůstanou NaN. Vrátí pole stejného tvaru.
    """
    rr_stack = np.full_like(dbz_stack, np.nan)
    for i, frame in enumerate(dbz_stack):
        mask = np.isnan(frame)
        # pysteps to_rainrate očekává (rows, cols) bez NaN — pracujeme jen s platnými px
        valid = frame.copy()
        valid[mask] = -32.0  # bezpečná hodnota pod prahem
        rr, _ = transformation.dBZ_to_rainrate(valid, zr_a=200.0, zr_b=1.6)
        rr[mask] = np.nan
        rr_stack[i] = rr
    return rr_stack


# ── 4. Pohybové pole + extrapolace ─────────────────────────────────────────────

def run_extrapolation(
    rr_stack: np.ndarray,
    n_leadtimes: int,
    timestep_min: int,
) -> np.ndarray:
    """
    Odhadne pohybové pole z posledních dvou snímků (lucaskanade)
    a extrapoluje n_leadtimes kroků dopředu.
    Vrátí (n_leadtimes, rows, cols) float32.
    """
    # lucaskanade pracuje na dBZ (log-prostoru), ne na mm/h — převedeme zpět
    # Ale pysteps extrapolation může pracovat přímo na rain rate, klíčové je
    # aby vstupní pole bylo bez NaN → nahradíme NaN nulou (žádné srážky)
    rr_clean = np.nan_to_num(rr_stack, nan=0.0)

    # Pohybové pole z poslední dvojice snímků
    oflow_method = motion.get_method("lucaskanade")
    motion_field = oflow_method(rr_clean[-2:])   # (2, rows, cols) → (2, rows, cols) UV

    # Extrapolace: bereme poslední snímek jako startovní
    extrap_method = nowcasts.get_method("extrapolation")
    forecast = extrap_method(
        rr_clean[-1],
        motion_field,
        n_leadtimes,
        extrap_kwargs={"allow_nonfinite_values": True},
    )   # výstup: (n_leadtimes, rows, cols)

    return forecast.astype(np.float32)


# ── 5. Extrakce časové řady pro pixel ─────────────────────────────────────────

def extract_timeseries(
    forecast: np.ndarray,
    t0: datetime,
    row: int,
    col: int,
    timestep_min: int,
    threshold: float,
) -> dict:
    """
    Pro pixel (row, col) vytáhne časovou řadu z extrapolace.
    Vrátí dict s časem příchodu, špičkovou intenzitou a odhadem úhrnu.
    """
    n = forecast.shape[0]
    times_utc = [
        (t0 + timedelta(minutes=(i + 1) * timestep_min)).isoformat()
        for i in range(n)
    ]
    values = forecast[:, row, col].tolist()

    # Nahraď NaN nulou pro součty (extrapolace mimo dosah = žádné srážky)
    values_clean = [v if (v is not None and not (isinstance(v, float) and np.isnan(v))) else 0.0
                    for v in values]

    # Čas příchodu: první krok s intenzitou > práh
    arrival_utc = None
    for t, v in zip(times_utc, values_clean):
        if v >= threshold:
            arrival_utc = t
            break

    peak_mm_h  = float(max(values_clean)) if values_clean else 0.0
    total_mm   = float(sum(values_clean)) * (timestep_min / 60.0)  # mm/h × h = mm

    return {
        "pixel":         {"row": row, "col": col},
        "t0_utc":        t0.isoformat(),
        "timestep_min":  timestep_min,
        "horizon_h":     n * timestep_min / 60,
        "threshold_mm_h": threshold,
        "arrival_utc":   arrival_utc,
        "peak_mm_h":     round(peak_mm_h, 2),
        "total_mm":      round(total_mm, 2),
        "timeseries": [
            {"time_utc": t, "mm_h": round(v, 3)}
            for t, v in zip(times_utc, values_clean)
        ],
    }


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    # Načti metadata z ingestu
    meta_path = DATA_DIR / "radar_meta.json"
    if not meta_path.exists():
        print("ERROR: data/radar_meta.json nenalezen — spusť nejdřív ingest.py", file=sys.stderr)
        sys.exit(1)

    with open(meta_path) as f:
        radar_meta = json.load(f)

    meta_latest = radar_meta["meta_latest"]
    # shape je uložen jako string "(378, 598)" — parsujeme
    shape_str = meta_latest.get("shape", "")
    if shape_str:
        shape_vals = [int(x) for x in shape_str.strip("()").split(",")]
        meta_latest["shape"] = tuple(shape_vals)
    # Číselné hodnoty jsou uloženy jako string v JSON — převeď zpět
    for k in ("xscale", "yscale", "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if k in meta_latest and isinstance(meta_latest[k], str):
            meta_latest[k] = float(meta_latest[k])

    # ── 1. Pixel lokace ────────────────────────────────────────────────────────
    print(f"\n=== Pixel lokace ===")
    row_px, col_px = latlon_to_pixel(lat, lon, meta_latest)

    # ── 2. Načti MAX_Z sekvenci pro pohyb ─────────────────────────────────────
    print(f"\n=== Načítám MAX_Z sekvenci ===")
    radar_dir = DATA_DIR / "radar"
    maxz_names = radar_meta.get("maxz_files", [])
    maxz_paths = [radar_dir / "maxz" / n for n in maxz_names]
    missing = [p for p in maxz_paths if not p.exists()]
    if missing:
        print(f"ERROR: Chybí soubory: {missing}", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    print(f"  MAX_Z stack: {maxz_stack.shape}, časy UTC: {[t.isoformat() for t in maxz_times]}")
    nan_pct = 100.0 * np.isnan(maxz_stack).mean()
    print(f"  NaN v MAX_Z stacku: {nan_pct:.1f}%")

    # ── 3. Načti srážkové snímky (CAPPI/MERGE) nebo fallback na MAX_Z ─────────
    precip_product = radar_meta.get("precip_product")
    if precip_product:
        print(f"\n=== Načítám {precip_product.upper()} sekvenci (Z→R) ===")
        precip_names = radar_meta.get("precip_files", [])
        precip_paths = [radar_dir / precip_product / n for n in precip_names]
        missing_p = [p for p in precip_paths if not p.exists()]
        if missing_p:
            print(f"  Varování: chybí {missing_p}, fallback na MAX_Z pro Z→R")
            precip_stack = maxz_stack.copy()
        else:
            precip_stack, _ = load_sequence(precip_paths)
            print(f"  {precip_product.upper()} stack: {precip_stack.shape}")
    else:
        print("\n  Varování: žádný CAPPI/MERGE — Z→R z MAX_Z (nadhodnocení možné)")
        precip_stack = maxz_stack.copy()

    # ── 4. dBZ → rain rate ────────────────────────────────────────────────────
    print(f"\n=== dBZ → rain rate (Marshall–Palmer) ===")
    rr_maxz   = dbz_to_rainrate(maxz_stack)    # pro pohyb
    rr_precip = dbz_to_rainrate(precip_stack)  # pro úhrny

    valid_rr = rr_precip[~np.isnan(rr_precip)]
    if valid_rr.size:
        print(f"  Rain rate (platné px): min={valid_rr.min():.3f}, "
              f"max={valid_rr.max():.1f}, mean={valid_rr.mean():.3f} mm/h")

    # ── 5. Pohybové pole + extrapolace ────────────────────────────────────────
    print(f"\n=== Extrapolace (lucaskanade + extrapolation) ===")
    if rr_maxz.shape[0] < 2:
        print("ERROR: Potřebné alespoň 2 snímky pro odhad pohybu", file=sys.stderr)
        sys.exit(1)

    forecast = run_extrapolation(rr_precip, N_LEADTIMES, TIMESTEP_MIN)
    print(f"  Forecast shape: {forecast.shape} "
          f"({N_LEADTIMES} kroků × {TIMESTEP_MIN} min = {N_LEADTIMES*TIMESTEP_MIN/60:.0f} h)")

    # ── 6. Časová řada pro cílový pixel ───────────────────────────────────────
    t0 = maxz_times[-1] if maxz_times else datetime.now(timezone.utc)
    print(f"\n=== Časová řada pro pixel ({row_px}, {col_px}) | t0={t0.isoformat()} ===")

    ts = extract_timeseries(forecast, t0, row_px, col_px, TIMESTEP_MIN, RAIN_THRESHOLD_MM_H)

    print(f"  Čas příchodu srážek : {ts['arrival_utc'] or 'žádné srážky v horizontu 2h'}")
    print(f"  Špičková intenzita  : {ts['peak_mm_h']} mm/h")
    print(f"  Odhad úhrnu (0–2 h) : {ts['total_mm']} mm")
    print(f"\n  Časová řada (10min kroky):")
    for step in ts["timeseries"]:
        bar = "█" * int(min(step["mm_h"], 20) / 0.5)
        print(f"    {step['time_utc']}  {step['mm_h']:6.3f} mm/h  {bar}")

    # Ulož
    out = {
        "location": {"lat": lat, "lon": lon},
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "motion_product":  "MAX_Z",
            "precip_product":  precip_product or "MAX_Z (fallback)",
            "extrapolation":   "lucaskanade+extrapolation",
            "valid_horizon_h": 2,
        },
        "nowcast": ts,
    }
    out_path = DATA_DIR / "nowcast.json"
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n✓ Fáze 2 — Nowcast OK → {out_path}")


if __name__ == "__main__":
    main()
