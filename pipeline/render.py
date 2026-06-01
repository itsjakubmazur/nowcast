"""
Fáze 4c — Render radarových PNG snímků pro webovou smyčku
- 6 historických MAX_Z + 12 nowcast snímků = 18 RGBA PNG (pevné názvy, přepisují se)
- Barevná škála: průhledné (sucho) → modrá → zelená → žlutá → oranžová → červená
- PNG jsou georeferencované přes manifest (LL/UR rohy pro Leaflet imageOverlay)
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
from ingest import DATA_DIR, read_odim_dbz
from nowcast import (
    TIMESTEP_MIN, N_LEADTIMES,
    load_sequence, dbz_to_rainrate,
)

PRAGUE_TZ = ZoneInfo("Europe/Prague")
SCALE     = 2          # render 2× nativní rozlišení → ~1196×756 px
OUT_DIR   = DATA_DIR / "radar_frames"

# ── Barevná škála mm/h → RGBA ─────────────────────────────────────────────────
# Odpovídá standardní meteorologické stupnici.
# Dvojice (mm/h, (R, G, B, A)) — alfa 0 = plně průhledné (sucho).
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
_LUT_MAX  = CMAP[-1][0]  # 50 mm/h = saturace stupnice


def _build_lut() -> np.ndarray:
    """Předpočítá LUT (lookup table) CMAP → pole (LUT_SIZE, 4) uint8."""
    rr_pts   = np.array([c[0] for c in CMAP], dtype=float)
    rgba_pts = np.array([c[1] for c in CMAP], dtype=float)
    xs  = np.linspace(0, _LUT_MAX, _LUT_SIZE)
    lut = np.stack(
        [np.interp(xs, rr_pts, rgba_pts[:, ch]) for ch in range(4)],
        axis=-1,
    )
    return np.clip(lut, 0, 255).astype(np.uint8)


_LUT = _build_lut()


def rr_to_img(rr: np.ndarray) -> Image.Image:
    """2D pole mm/h (float32, NaN povoleno) → PIL RGBA Image ve SCALE× rozlišení."""
    rr_c = np.nan_to_num(rr, nan=0.0, posinf=0.0).clip(0, _LUT_MAX)
    idx  = ((rr_c / _LUT_MAX) * (_LUT_SIZE - 1)).astype(np.int32)
    rgba = _LUT[idx]   # (h, w, 4)
    img  = Image.fromarray(rgba, mode="RGBA")
    if SCALE != 1:
        h, w = rr.shape
        resample = getattr(Image.Resampling, "BILINEAR", Image.BILINEAR)
        img = img.resize((w * SCALE, h * SCALE), resample)
    return img


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    meta_path = DATA_DIR / "radar_meta.json"
    fc_path   = DATA_DIR / "forecast_array.npy"

    for p in (meta_path, fc_path):
        if not p.exists():
            print(f"ERROR: {p.name} chybí — spusť nejdřív ingest.py + nowcast.py",
                  file=sys.stderr)
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
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Historické snímky (MAX_Z → rain rate) ─────────────────────────────
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if not maxz_paths:
        print("ERROR: žádné MAX_Z soubory.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    t0    = maxz_times[-1]
    n_his = len(maxz_paths)

    print(f"\n=== Render radarových PNG ({SCALE}× scale, {n_his} hist + {N_LEADTIMES} nowcast) ===")
    print(f"  t0 = {t0.isoformat()}")

    # ── 2. Nowcast pole ─────────────────────────────────────────────────────────
    forecast = np.load(fc_path)   # (N_LEADTIMES, h, w) mm/h
    n_fut    = forecast.shape[0]

    # ── 3. Render všech snímků ──────────────────────────────────────────────────
    frames_meta: list[dict] = []
    total_bytes = 0

    def _render(rr: np.ndarray, fname: str, t: datetime, ftype: str) -> None:
        nonlocal total_bytes
        img   = rr_to_img(rr)
        fpath = OUT_DIR / fname
        img.save(fpath, format="PNG", optimize=True, compress_level=7)
        sz    = fpath.stat().st_size
        total_bytes += sz
        t_loc = t.astimezone(PRAGUE_TZ)
        valid = rr[~np.isnan(rr)]
        peak_s = f"max={valid.max():.1f}" if valid.size else "max=0.0"
        print(f"  {fname}  {t.strftime('%H:%M')} UTC  {ftype:7s}  {sz//1024:4d} kB  {peak_s}")
        frames_meta.append({
            "file":       fname,
            "time_utc":   t.isoformat(),
            "time_local": t_loc.strftime("%H:%M"),
            "type":       ftype,
        })

    # Historické snímky
    for i, (dbz, t) in enumerate(zip(maxz_stack, maxz_times)):
        ftype = "t0" if i == n_his - 1 else "past"
        _render(dbz_to_rainrate(dbz), f"frame_{i:02d}.png", t, ftype)

    # Nowcast snímky
    for i in range(n_fut):
        t = t0 + timedelta(minutes=(i + 1) * TIMESTEP_MIN)
        _render(forecast[i].copy(), f"frame_{n_his + i:02d}.png", t, "nowcast")

    # ── 4. Manifest ─────────────────────────────────────────────────────────────
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "t0_utc":           t0.isoformat(),
        "t0_index":         n_his - 1,   # index posledního historického snímku
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
    print(f"  {n_frames} snímků  |  celkem {total_bytes // 1024} kB  "
          f"|  průměr {total_bytes // n_frames // 1024} kB/snímek")
    print(f"  Manifest → {mpath}")
    print(f"  PNG → {OUT_DIR}/frame_00..{n_frames - 1:02d}.png")
    print(f"  Bounds pro Leaflet: {manifest['bounds']}")


if __name__ == "__main__":
    main()
