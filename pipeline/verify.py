"""
Verifikace přesnosti nowcastu — zpětná (leave-out) hindcast validace.

Poctivé měření bez čekání na budoucnost: při KAŽDÉM běhu použijeme jen prvních
N-2 stažených MAX_Z snímků k odhadu pohybu a extrapolaci +1 a +2 kroky dopředu
(úplně stejným kódem jako produkční nowcast.py), a porovnáme predikci s
posledními dvěma snímky, které pipeline právě reálně stáhla — tedy se
skutečností, kterou v době predikce ještě neznala. Je to out-of-sample test
metody samotné, ne srovnání s dosud neproběhlou budoucností.

Výstup:
  data/accuracy.json                    — publikovaná rolling statistika (30 dní)
  pipeline/state/accuracy_history.json  — perzistentní surová historie (commitovaná)
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, DEFAULT_LAT, DEFAULT_LON
from nowcast import (
    RAIN_THRESHOLD_MM_H, TIMESTEP_MIN,
    load_sequence, dbz_to_rainrate, run_extrapolation, latlon_to_pixel,
)

STATE_DIR     = Path(__file__).parent / "state"
HISTORY_PATH  = STATE_DIR / "accuracy_history.json"
WINDOW_DAYS   = 30
SAMPLE_RADIUS = 2   # ±2 px kolem domovské lokace = 5×5 = 25 vzorků / leadtime


def _metrics(pred: np.ndarray, actual: np.ndarray, r0, r1, c0, c1) -> dict:
    p = np.nan_to_num(pred[r0:r1, c0:c1], nan=0.0).ravel()
    a = np.nan_to_num(actual[r0:r1, c0:c1], nan=0.0).ravel()
    mae = float(np.mean(np.abs(p - a)))
    hit = float(np.mean((p >= RAIN_THRESHOLD_MM_H) == (a >= RAIN_THRESHOLD_MM_H)))
    return {"mae_mm_h": round(mae, 3), "hit_rate": round(hit, 4), "n": int(p.size)}


def _aggregate(history: list, key: str) -> dict:
    vals = [e[key] for e in history if key in e]
    if not vals:
        return {"mae_mm_h": None, "hit_rate_pct": None, "n": 0}
    n_total = sum(v["n"] for v in vals)
    if n_total == 0:
        return {"mae_mm_h": None, "hit_rate_pct": None, "n": 0}
    mae = sum(v["mae_mm_h"] * v["n"] for v in vals) / n_total
    hit = sum(v["hit_rate"] * v["n"] for v in vals) / n_total
    return {
        "mae_mm_h": round(mae, 3),
        "hit_rate_pct": round(hit * 100, 1),
        "n": n_total,
    }


def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    meta_path = DATA_DIR / "radar_meta.json"
    if not meta_path.exists():
        print("verify.py: radar_meta.json chybí — přeskakuji", file=sys.stderr)
        return

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
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 4:
        print(f"verify.py: jen {len(maxz_paths)} MAX_Z snímků (potřeba ≥4) — přeskakuji",
              file=sys.stderr)
        return

    stack, times = load_sequence(maxz_paths)
    if stack.shape[0] < 4:
        print("verify.py: nedostatek snímků po načtení — přeskakuji", file=sys.stderr)
        return

    # Ponech poslední 2 snímky jako "budoucnost" k porovnání, zbytek jako trénink.
    train_stack = stack[:-2]
    actual_1 = dbz_to_rainrate(stack[-2])
    actual_2 = dbz_to_rainrate(stack[-1])

    start_rr = dbz_to_rainrate(train_stack[-1])
    try:
        forecast = run_extrapolation(train_stack, start_rr, 2, TIMESTEP_MIN)
    except Exception as e:
        print(f"verify.py: extrapolace selhala: {e}", file=sys.stderr)
        return
    pred_1, pred_2 = forecast[0], forecast[1]

    try:
        row, col = latlon_to_pixel(lat, lon, meta)
    except Exception as e:
        print(f"verify.py: pixel mimo grid: {e}", file=sys.stderr)
        return

    nrows, ncols = meta["shape"]
    r0, r1 = max(0, row - SAMPLE_RADIUS), min(nrows, row + SAMPLE_RADIUS + 1)
    c0, c1 = max(0, col - SAMPLE_RADIUS), min(ncols, col + SAMPLE_RADIUS + 1)

    m1 = _metrics(pred_1, actual_1, r0, r1, c0, c1)
    m2 = _metrics(pred_2, actual_2, r0, r1, c0, c1)

    now_utc = datetime.now(timezone.utc)
    entry = {
        "run_utc":    now_utc.isoformat(),
        "t0_utc":     times[-1].isoformat(),
        "leadtime_1": m1,
        "leadtime_2": m2,
    }

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    history = []
    if HISTORY_PATH.exists():
        try:
            history = json.loads(HISTORY_PATH.read_text())
        except Exception:
            history = []

    history.append(entry)
    cutoff = (now_utc - timedelta(days=WINDOW_DAYS)).isoformat()
    history = [e for e in history if e.get("run_utc", "") >= cutoff]
    HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False))
    print(f"verify.py: +1 záznam, {len(history)} v okně {WINDOW_DAYS} dní "
          f"(MAE₁₀={m1['mae_mm_h']} hit₁₀={m1['hit_rate']:.0%})")

    out = {
        "generated_at_utc": now_utc.isoformat(),
        "window_days":      WINDOW_DAYS,
        "n_runs":           len(history),
        "method": ("Zpětná (leave-out) hindcast validace: extrapolace natrénovaná "
                   "bez posledních 2 stažených snímků porovnaná s tím, co radar "
                   "skutečně zachytil. Stejný kód jako produkční nowcast."),
        "leadtime_10min":   _aggregate(history, "leadtime_1"),
        "leadtime_20min":   _aggregate(history, "leadtime_2"),
        "threshold_mm_h":   RAIN_THRESHOLD_MM_H,
        "sample_location":  {"lat": lat, "lon": lon, "radius_px": SAMPLE_RADIUS},
    }
    (DATA_DIR / "accuracy.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"✓ accuracy.json — MAE₁₀={out['leadtime_10min']['mae_mm_h']} mm/h, "
          f"shoda={out['leadtime_10min']['hit_rate_pct']}%  (n_runs={len(history)})")


if __name__ == "__main__":
    main()
