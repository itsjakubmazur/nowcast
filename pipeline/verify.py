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
COTREC_PENDING = STATE_DIR / "cotrec_pending.json"
COTREC_HISTORY = STATE_DIR / "cotrec_history.json"
WINDOW_DAYS   = 30
SAMPLE_RADIUS = 2   # ±2 px kolem domovské lokace = 5×5 = 25 vzorků / leadtime
COTREC_TOL_MIN = 5  # tolerance shody času predikce a pozorování


def _metrics_flat(p: np.ndarray, a: np.ndarray) -> dict:
    mae = float(np.mean(np.abs(p - a)))
    hit = float(np.mean((p >= RAIN_THRESHOLD_MM_H) == (a >= RAIN_THRESHOLD_MM_H)))
    return {"mae_mm_h": round(mae, 3), "hit_rate": round(hit, 4), "n": int(p.size)}


def _metrics(pred: np.ndarray, actual: np.ndarray, r0, r1, c0, c1) -> dict:
    return _metrics_flat(
        np.nan_to_num(pred[r0:r1, c0:c1], nan=0.0).ravel(),
        np.nan_to_num(actual[r0:r1, c0:c1], nan=0.0).ravel(),
    )


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


def score_cotrec(stack, times, row, col, nrows, ncols) -> int:
    """
    Vyhodnotí čekající předpovědi ČHMÚ COTREC proti tomu, co radar mezitím
    naměřil, a přesune je do cotrec_history.json.

    Proč zvlášť a ne jako naši extrapolaci: COTREC si nepočítáme, ale stahujeme
    hotový. Nedá se tedy přehrát na zadrženém úseku — musí se uložit a počkat,
    až dorazí pozorování pro čas jeho platnosti. Metrika je záměrně úplně
    stejná (_metrics_flat, okno ±SAMPLE_RADIUS), jinak by srovnání nic neříkalo.

    Vrací počet nově vyhodnocených záznamů.
    """
    if not COTREC_PENDING.exists():
        return 0
    try:
        pending = json.loads(COTREC_PENDING.read_text())
    except Exception:
        return 0
    if not isinstance(pending, list) or not pending:
        return 0

    r0, r1 = max(0, row - SAMPLE_RADIUS), min(nrows, row + SAMPLE_RADIUS + 1)
    c0, c1 = max(0, col - SAMPLE_RADIUS), min(ncols, col + SAMPLE_RADIUS + 1)
    obs = {t: dbz_to_rainrate(stack[i]) for i, t in enumerate(times)}

    history = []
    if COTREC_HISTORY.exists():
        try:
            history = json.loads(COTREC_HISTORY.read_text())
        except Exception:
            history = []

    now_utc = datetime.now(timezone.utc)
    still_pending, scored = [], 0
    for p in pending:
        try:
            valid = datetime.fromisoformat(p["valid_utc"])
            pred = np.asarray(p["pred_box"], dtype=np.float32)
        except Exception:
            continue   # rozbitý záznam zahodíme, ať se nehromadí

        match = next((t for t in obs
                      if abs((t - valid).total_seconds()) <= COTREC_TOL_MIN * 60), None)
        if match is None:
            # Pozorování ještě nedorazilo → počkáme. Pokud je ale čas platnosti
            # dávno pryč a snímek nikdy nepřišel, záznam zahodíme.
            if (now_utc - valid).total_seconds() < 3 * 3600:
                still_pending.append(p)
            continue

        actual = np.nan_to_num(obs[match][r0:r1, c0:c1], nan=0.0).ravel()
        if actual.size != pred.size:
            # Okno u kraje rastru — nedá se srovnat, záznam zahodíme.
            continue
        m = _metrics_flat(pred, actual)
        history.append({
            "run_utc": now_utc.isoformat(),
            "base_utc": p.get("base_utc"),
            "valid_utc": p["valid_utc"],
            "lead_min": p.get("lead_min"),
            f"leadtime_{max(1, int(p.get('lead_min', 10)) // TIMESTEP_MIN)}": m,
        })
        scored += 1

    cutoff = (now_utc - timedelta(days=WINDOW_DAYS)).isoformat()
    history = [e for e in history if e.get("run_utc", "") >= cutoff]
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    COTREC_HISTORY.write_text(json.dumps(history, ensure_ascii=False))
    COTREC_PENDING.write_text(json.dumps(still_pending, ensure_ascii=False))
    if scored:
        print(f"verify.py: vyhodnoceno {scored} předpovědí COTREC "
              f"({len(still_pending)} čeká, {len(history)} v historii)")
    return scored


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

    # Ponech poslední 2–3 snímky jako "budoucnost" k porovnání, zbytek jako
    # trénink. Při dostatku snímků validujeme i +30 min — přesnost podle
    # lead-time je vidět na webu (radar degraduje s časem, ať je to poctivě
    # změřené, ne jen tvrzené).
    n_holdout = 3 if stack.shape[0] >= 6 else 2
    train_stack = stack[:-n_holdout]
    actuals = [dbz_to_rainrate(stack[-(n_holdout - k)]) for k in range(n_holdout)]

    start_rr = dbz_to_rainrate(train_stack[-1])
    try:
        forecast = run_extrapolation(train_stack, start_rr, n_holdout, TIMESTEP_MIN)
    except Exception as e:
        print(f"verify.py: extrapolace selhala: {e}", file=sys.stderr)
        return

    try:
        row, col = latlon_to_pixel(lat, lon, meta)
    except Exception as e:
        print(f"verify.py: pixel mimo grid: {e}", file=sys.stderr)
        return

    nrows, ncols = meta["shape"]
    r0, r1 = max(0, row - SAMPLE_RADIUS), min(nrows, row + SAMPLE_RADIUS + 1)
    c0, c1 = max(0, col - SAMPLE_RADIUS), min(ncols, col + SAMPLE_RADIUS + 1)

    now_utc = datetime.now(timezone.utc)
    entry = {
        "run_utc":    now_utc.isoformat(),
        "t0_utc":     times[-1].isoformat(),
    }
    for k in range(n_holdout):
        entry[f"leadtime_{k + 1}"] = _metrics(forecast[k], actuals[k], r0, r1, c0, c1)
    m1 = entry["leadtime_1"]

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

    # Zpožděné hodnocení COTREC ČHMÚ. Selhání tady nesmí shodit accuracy.json —
    # naše vlastní verifikace na něm nezávisí.
    cot_history = []
    try:
        score_cotrec(stack, times, row, col, nrows, ncols)
        if COTREC_HISTORY.exists():
            cot_history = json.loads(COTREC_HISTORY.read_text())
    except Exception as e:
        print(f"verify.py: hodnocení COTREC selhalo ({e}) — pokračuji", file=sys.stderr)

    # Denní rozpad (posledních 7 dní) — pro webovou kartu "Trefili jsme se?":
    # transparentní verifikace po dnech, ne jen jedno souhrnné číslo
    by_day: dict[str, list] = {}
    for e in history:
        by_day.setdefault(e.get("run_utc", "")[:10], []).append(e)
    daily = []
    for day in sorted(by_day)[-7:]:
        agg = _aggregate(by_day[day], "leadtime_1")
        if agg["hit_rate_pct"] is not None:
            daily.append({"date": day, "hit_rate_pct": agg["hit_rate_pct"],
                          "mae_mm_h": agg["mae_mm_h"], "n_runs": len(by_day[day])})

    out = {
        "generated_at_utc": now_utc.isoformat(),
        "window_days":      WINDOW_DAYS,
        "n_runs":           len(history),
        "daily":            daily,
        "method": ("Zpětná (leave-out) hindcast validace: extrapolace natrénovaná "
                   "bez posledních 2 stažených snímků porovnaná s tím, co radar "
                   "skutečně zachytil. Stejný kód jako produkční nowcast."),
        "leadtime_10min":   _aggregate(history, "leadtime_1"),
        "leadtime_20min":   _aggregate(history, "leadtime_2"),
        "leadtime_30min":   _aggregate(history, "leadtime_3"),
        "threshold_mm_h":   RAIN_THRESHOLD_MM_H,
        "sample_location":  {"lat": lat, "lon": lon, "radius_px": SAMPLE_RADIUS},
    }

    # Srovnání s COTREC ČHMÚ — stejná metrika, stejné okno, stejná lokace.
    # Teprve tohle odpovídá na otázku, jestli má smysl držet vlastní pysteps běh.
    if cot_history:
        out["cotrec"] = {
            "source": "ČHMÚ COTREC (composite/fct_maxz)",
            "method": ("Publikovaná předpověď uložená v čase vydání a porovnaná "
                       "s pozorováním, které dorazilo později. Stejná metrika "
                       "i okno jako u naší extrapolace."),
            "n_runs": len(cot_history),
            "leadtime_10min": _aggregate(cot_history, "leadtime_1"),
            "leadtime_20min": _aggregate(cot_history, "leadtime_2"),
            "leadtime_30min": _aggregate(cot_history, "leadtime_3"),
            "leadtime_60min": _aggregate(cot_history, "leadtime_6"),
        }
    (DATA_DIR / "accuracy.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"✓ accuracy.json — MAE₁₀={out['leadtime_10min']['mae_mm_h']} mm/h, "
          f"shoda={out['leadtime_10min']['hit_rate_pct']}%  (n_runs={len(history)})")


if __name__ == "__main__":
    main()
