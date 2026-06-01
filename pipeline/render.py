"""
Fáze 4c — Render radarových PNG snímků pro webovou smyčku
- 6 historických MAX_Z + 12 nowcast snímků = 18 RGBA PNG (pevné názvy, přepisují se)
- VŠECHNY snímky ve STEJNÉ veličině (mm/h, Marshall–Palmer) a se SPOLEČNOU pevnou škálou,
  aby minulost a nowcast na sebe kolem t0 plynule navazovaly.
- Nowcast se advektuje ze STEJNÉHO MAX_Z rain-rate pole jako minulost (vizuální kontinuita).
  (Kvantitativní nowcast z MERGE zůstává v nowcast.py/grid.py — tohle je jen vizualizace.)
- PNG kvantizované (paleta 256, FASTOCTREE s alfou) → ~10–40 kB/snímek
- Výstup: data/radar_frames/frame_00..17.png + data/radar_manifest.json
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR
from nowcast import (
    TIMESTEP_MIN, N_LEADTIMES,
    load_sequence, dbz_to_rainrate, run_extrapolation,
)

PRAGUE_TZ = ZoneInfo("Europe/Prague")
SCALE     = 1          # nativní rozlišení (~598×378); mřížka je 1 km, 2× nemá smysl
OUT_DIR   = DATA_DIR / "radar_frames"

# ── Pevná SPOLEČNÁ barevná škála mm/h → RGBA (platí pro VŠECH 18 snímků) ───────
# Standardní meteorologická stupnice; alfa 0 = plně průhledné (sucho).
RR_MIN  = 0.10   # pod tímto prahem = plně průhledné
RR_MAX  = 50.0   # saturace stupnice (mm/h)
CMAP: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.00, (  0,   0,   0,   0)),
    (0.08, (  0,   0,   0,   0)),   # pod šumovým prahem = stále průhledné
    (0.10, (160, 210, 255, 155)),   # velmi slabý déšť — bledě modrá
    (0.30, ( 80, 170, 255, 180)),
    (0.50, (  0, 120, 255, 200)),   # světle modrá
    (1.00, (  0, 210, 130, 210)),   # modrozelená
    (2.00, (  0, 200,   0, 220)),   # zelená
    (5.00, (180, 220,   0, 228)),   # žlutozelená
    (7.00, (255, 220,   0, 235)),   # žlutá
    (10.0, (255, 150,   0, 242)),   # oranžová
    (15.0, (255,  60,   0, 250)),   # červenooranžová
    (20.0, (220,   0,   0, 255)),   # červená
    (30.0, (160,   0,  60, 255)),   # tmavě červená
    (50.0, (120,   0, 100, 255)),   # fialová
]

_LUT_SIZE = 2048


def _build_lut() -> np.ndarray:
    rr_pts   = np.array([c[0] for c in CMAP], dtype=float)
    rgba_pts = np.array([c[1] for c in CMAP], dtype=float)
    xs  = np.linspace(0, RR_MAX, _LUT_SIZE)
    lut = np.stack([np.interp(xs, rr_pts, rgba_pts[:, ch]) for ch in range(4)], axis=-1)
    return np.clip(lut, 0, 255).astype(np.uint8)


_LUT = _build_lut()


def rr_to_img(rr: np.ndarray) -> Image.Image:
    """2D pole mm/h (float32, NaN povoleno) → kvantizovaný PIL Image (paleta + alfa)."""
    rr_c = np.nan_to_num(rr, nan=0.0, posinf=0.0).clip(0, RR_MAX)
    idx  = ((rr_c / RR_MAX) * (_LUT_SIZE - 1)).astype(np.int32)
    img  = Image.fromarray(_LUT[idx], mode="RGBA")
    if SCALE != 1:
        h, w = rr.shape
        img = img.resize((w * SCALE, h * SCALE), Image.Resampling.BILINEAR)
    # Kvantizace na paletu 256 barev s alfou (FASTOCTREE umí alfa kanál) — zmenší 5–10×
    return img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    meta_path = DATA_DIR / "radar_meta.json"
    if not meta_path.exists():
        print("ERROR: radar_meta.json chybí — spusť nejdřív ingest.py", file=sys.stderr)
        sys.exit(1)

    with open(meta_path) as f:
        radar_meta = json.load(f)

    meta = radar_meta["meta_latest"]
    for k in ("LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if k in meta and isinstance(meta[k], str):
            meta[k] = float(meta[k])

    radar_dir = DATA_DIR / "radar"
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Historické MAX_Z → rain rate (mm/h) ──────────────────────────────────
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 2:
        print("ERROR: potřeba ≥ 2 MAX_Z snímky.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    t0    = maxz_times[-1]
    n_his = len(maxz_paths)

    # Minulé snímky jako rain rate (mm/h) — STEJNÁ veličina jako nowcast
    past_rr = [dbz_to_rainrate(maxz_stack[i]) for i in range(n_his)]

    # ── 2. Nowcast advekce ze STEJNÉHO MAX_Z rain-rate pole (kontinuita) ─────────
    # Startovní pole = poslední historický snímek (past_rr[-1]); pohyb z MAX_Z dBZ.
    print(f"\n=== Render radarových PNG (scale {SCALE}×, {n_his} hist + {N_LEADTIMES} nowcast) ===")
    print(f"  Veličina: rain rate mm/h (Marshall–Palmer) — SPOLEČNÁ pro všech "
          f"{n_his + N_LEADTIMES} snímků")
    print(f"  Pevná škála: {RR_MIN}–{RR_MAX} mm/h "
          f"(průhledné < {RR_MIN}, saturace ≥ {RR_MAX})")
    print(f"  t0 = {t0.isoformat()}")

    forecast = run_extrapolation(maxz_stack, past_rr[-1], N_LEADTIMES, TIMESTEP_MIN)
    n_fut = forecast.shape[0]

    # ── 3. Render všech snímků (společná škála) ─────────────────────────────────
    frames_meta: list[dict] = []
    total_bytes = 0

    def _render(rr: np.ndarray, fname: str, t: datetime, ftype: str, tag: str) -> None:
        nonlocal total_bytes
        img   = rr_to_img(rr)
        fpath = OUT_DIR / fname
        img.save(fpath, format="PNG", optimize=True)
        sz    = fpath.stat().st_size
        total_bytes += sz
        valid = rr[~np.isnan(rr)]
        mx    = float(valid.max()) if valid.size else 0.0
        print(f"  {fname}  {t.strftime('%H:%M')} UTC  {tag:>9s}  "
              f"max={mx:6.1f} mm/h  {sz//1024:3d} kB")
        frames_meta.append({
            "file":       fname,
            "time_utc":   t.isoformat(),
            "time_local": t.astimezone(PRAGUE_TZ).strftime("%H:%M"),
            "type":       ftype,
            "max_mm_h":   round(mx, 1),
        })

    print("\n  Snímek         čas    typ         maximum         velikost")
    # Historické (minulost → t0)
    for i in range(n_his):
        ftype = "t0" if i == n_his - 1 else "past"
        tag   = "● TEĎ" if i == n_his - 1 else f"-{(n_his-1-i)*TIMESTEP_MIN} min"
        _render(past_rr[i], f"frame_{i:02d}.png", maxz_times[i], ftype, tag)
    # Nowcast (budoucnost)
    for i in range(n_fut):
        t = t0 + timedelta(minutes=(i + 1) * TIMESTEP_MIN)
        _render(forecast[i].copy(), f"frame_{n_his + i:02d}.png", t,
                "nowcast", f"+{(i+1)*TIMESTEP_MIN} min")

    # ── 4. Manifest ─────────────────────────────────────────────────────────────
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "t0_utc":           t0.isoformat(),
        "t0_index":         n_his - 1,
        "step_min":         TIMESTEP_MIN,
        "scale_mm_h":       {"min": RR_MIN, "max": RR_MAX},
        "bounds": [
            [meta["LL_lat"], meta["LL_lon"]],   # SW roh pro Leaflet
            [meta["UR_lat"], meta["UR_lon"]],   # NE roh
        ],
        "frames": frames_meta,
    }
    mpath = DATA_DIR / "radar_manifest.json"
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    n_frames = len(frames_meta)
    print(f"\n✓ Fáze 4c — Render OK")
    print(f"  {n_frames} snímků  |  CELKEM {total_bytes/1024:.0f} kB "
          f"({total_bytes/1024/1024:.2f} MB)  |  průměr {total_bytes//n_frames//1024} kB/snímek")
    print(f"  Návaznost minulost→nowcast kolem t0 (max mm/h):")
    near = frames_meta[max(0, n_his-2):n_his+2]
    print("    " + " → ".join(f"{fm['max_mm_h']:.1f}({fm['type']})" for fm in near))
    print(f"  Manifest → {mpath}")


if __name__ == "__main__":
    main()
