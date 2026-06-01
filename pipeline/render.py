"""
Fáze 4c — Render radarových PNG snímků pro webovou smyčku
- VŠECH 18 snímků (6 historických + 12 nowcast) z JEDNOHO zdroje: MAX_Z odrazivost.
  → konzistentní škála, plynulá návaznost přes t0, žádný skok mezi zdroji.
- Minulost: 6 skutečných MAX_Z snímků (10-min kroky) → kalibrované Z→R.
- Nowcast: poslední MAX_Z pole advektované pohybovým polem (12 kroků) → reálný pohyb.
- KALIBRACE: dBZ ořez na 55 dBZ PŘED Z→R (odřízne kroupová jádra), výsledek tvrdě
  na max 30 mm/h. Cíl: realistická maxima, sanity check (>50) nikdy nehlásí.
- POZN.: tohle je VIZUÁLNÍ odhad intenzity z odrazivosti, NE přesné QPE.
  Číselný odhad úhrnů (MERGE) zůstává v nowcast.py/grid.py — render to needituje.
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
    load_sequence,
)
from pysteps import motion, nowcasts

PRAGUE_TZ = ZoneInfo("Europe/Prague")
SCALE     = 1          # nativní rozlišení (~598×378)
N_PAST    = 6          # počet historických snímků (skutečné MAX_Z, 10-min kroky)
OUT_DIR   = DATA_DIR / "radar_frames"

# ── Kalibrace odrazivosti → intenzita ─────────────────────────────────────────
DBZ_CAP   = 55.0   # strop dBZ PŘED Z→R — odřízne kroupová/ledová jádra, co přepalují
RR_MIN    = 0.10   # pod tímto prahem = plně průhledné
RR_MAX    = 30.0   # saturace stupnice (mm/h) — výsledek se sem tvrdě ořízne
SANITY_MAX = 50.0  # nad touto hodnotou = podezření na chybu (nesmí nikdy nastat)

# ── Pevná SPOLEČNÁ barevná škála mm/h → RGBA (všech 18 snímků) ────────────────
CMAP: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.00, (  0,   0,   0,   0)),
    (0.08, (  0,   0,   0,   0)),
    (0.10, (160, 210, 255, 150)),
    (0.50, ( 60, 140, 255, 190)),
    (1.00, (  0, 200, 120, 210)),
    (2.00, (  0, 200,   0, 220)),
    (4.00, (180, 220,   0, 228)),
    (7.00, (255, 210,   0, 236)),
    (10.0, (255, 140,   0, 244)),
    (15.0, (255,  60,   0, 250)),
    (20.0, (220,   0,   0, 255)),
    (30.0, (150,   0,  80, 255)),
]

_LUT_SIZE = 2048


def _build_lut() -> np.ndarray:
    rr_pts   = np.array([c[0] for c in CMAP], dtype=float)
    rgba_pts = np.array([c[1] for c in CMAP], dtype=float)
    xs  = np.linspace(0, RR_MAX, _LUT_SIZE)
    lut = np.stack([np.interp(xs, rr_pts, rgba_pts[:, ch]) for ch in range(4)], axis=-1)
    return np.clip(lut, 0, 255).astype(np.uint8)


_LUT = _build_lut()


def dbz_to_rr_calibrated(dbz: np.ndarray) -> np.ndarray:
    """
    Kalibrovaný převod dBZ → mm/h pro VIZUÁL.
    1. Ořež dBZ na DBZ_CAP (55) — odřízne kroupová/ledová jádra, která přepalují.
    2. Marshall–Palmer Z→R: R = (10^(dBZ/10) / 200)^(1/1.6).
    3. Výsledek tvrdě ořež na RR_MAX (30 mm/h) — saturace škály.
    NaN → 0. Pod 0.1 mm/h → 0 (šum).
    """
    d = np.nan_to_num(dbz, nan=-100.0).clip(max=DBZ_CAP)
    with np.errstate(invalid="ignore"):
        Z  = 10.0 ** (d / 10.0)
        rr = (Z / 200.0) ** (1.0 / 1.6)
    rr = np.where(rr < RR_MIN, 0.0, rr)
    return rr.clip(0, RR_MAX).astype(np.float32)


def rr_to_img(rr: np.ndarray) -> Image.Image:
    """2D pole mm/h (float32) → kvantizovaný PIL Image (paleta + alfa)."""
    rr_c = np.nan_to_num(rr, nan=0.0, posinf=0.0).clip(0, RR_MAX)
    idx  = ((rr_c / RR_MAX) * (_LUT_SIZE - 1)).astype(np.int32)
    img  = Image.fromarray(_LUT[idx], mode="RGBA")
    if SCALE != 1:
        h, w = rr.shape
        img = img.resize((w * SCALE, h * SCALE), Image.Resampling.BILINEAR)
    return img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)


def _centroid(rr: np.ndarray) -> tuple[float, float]:
    """Těžiště srážkového pole (row, col) vážené intenzitou; (nan,nan) když sucho."""
    m = rr > RR_MIN
    if not m.any():
        return float("nan"), float("nan")
    rows, cols = np.nonzero(m)
    w = rr[rows, cols]
    return float((rows * w).sum() / w.sum()), float((cols * w).sum() / w.sum())


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

    # ── 1. MAX_Z sekvence: pohybové pole + historické i nowcast snímky ──────────
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 2:
        print("ERROR: potřeba ≥ 2 MAX_Z snímky.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)   # dBZ, nejstarší→nejnovější
    t0 = maxz_times[-1]
    n_maxz = len(maxz_paths)

    print(f"\n=== Render radarových PNG (scale {SCALE}×, {N_PAST} hist + {N_LEADTIMES} nowcast) ===")
    print(f"  JEDEN zdroj pro všech 18 snímků: MAX_Z odrazivost (orientační intenzita)")
    print(f"  Kalibrace: dBZ ořez ≤ {DBZ_CAP}, Z→R, výsledek ořez ≤ {RR_MAX} mm/h")
    print(f"  Pevná škála: {RR_MIN}–{RR_MAX} mm/h")
    print(f"  t0 = {t0.isoformat()}  ({n_maxz} MAX_Z souborů)")

    motion_field = motion.get_method("lucaskanade")(np.nan_to_num(maxz_stack, nan=0.0))

    # Kalibrovaná rain-rate pole pro celý stack
    maxz_rr = dbz_to_rr_calibrated(maxz_stack)   # (N, r, c) mm/h

    # ── 2. Nowcast: advekce posledního MAX_Z rain-rate pole ─────────────────────
    extrap = nowcasts.get_method("extrapolation")
    rr0 = maxz_rr[-1].copy()   # t0 pole
    fwd = extrap(rr0, motion_field, N_LEADTIMES,
                 extrap_kwargs={"allow_nonfinite_values": True})

    # ── 3. Render ────────────────────────────────────────────────────────────────
    frames_meta: list[dict] = []
    total_bytes = 0
    sanity_hits = []

    def _render(rr: np.ndarray, fname: str, t: datetime, ftype: str, tag: str, src: str) -> tuple:
        nonlocal total_bytes
        img   = rr_to_img(rr)
        fpath = OUT_DIR / fname
        img.save(fpath, format="PNG", optimize=True)
        sz    = fpath.stat().st_size
        total_bytes += sz
        valid = rr[~np.isnan(rr)]
        mx    = float(valid.max()) if valid.size else 0.0
        flag  = "  ⚠ EXTRÉM" if mx > SANITY_MAX else ""
        if mx > SANITY_MAX:
            sanity_hits.append((fname, mx))
        cr, cc = _centroid(rr)
        print(f"  {fname}  {t.strftime('%H:%M')} UTC  {tag:>9s}  "
              f"max={mx:5.1f} mm/h  {sz//1024:3d} kB  [{src}]{flag}")
        frames_meta.append({
            "file":       fname,
            "time_utc":   t.isoformat(),
            "time_local": t.astimezone(PRAGUE_TZ).strftime("%H:%M"),
            "type":       ftype,
            "source":     src,
            "max_mm_h":   round(mx, 1),
        })
        return cr, cc

    print("\n  Snímek         čas    typ         maximum       velikost  zdroj")

    # Historické: posledních N_PAST MAX_Z snímků (nebo méně + padding na začátek)
    n_hist = min(N_PAST, n_maxz)
    hist_indices = list(range(n_maxz - n_hist, n_maxz))   # včetně posledního = t0
    n_pad = N_PAST - n_hist
    for k in range(n_pad):
        frame_idx = k
        t = t0 - timedelta(minutes=(N_PAST - 1 - k) * TIMESTEP_MIN)
        empty = np.zeros_like(maxz_rr[-1])
        _render(empty, f"frame_{frame_idx:02d}.png", t, "past",
                f"-{(N_PAST-1-k)*TIMESTEP_MIN} min", "empty")
    for rank, si in enumerate(hist_indices):
        frame_idx = n_pad + rank
        t   = maxz_times[si]
        lag = int((t0 - t).total_seconds() / 60)
        ftype = "t0" if si == n_maxz - 1 else "past"
        tag   = "● TEĎ" if si == n_maxz - 1 else f"-{lag} min"
        _render(maxz_rr[si].copy(), f"frame_{frame_idx:02d}.png", t, ftype, tag, "maxz")

    # Nowcast: advekce + sledování těžiště pro důkaz pohybu
    centroids: list[tuple[int, tuple]] = []
    for i in range(N_LEADTIMES):
        t = t0 + timedelta(minutes=(i + 1) * TIMESTEP_MIN)
        cr, cc = _render(fwd[i].copy(), f"frame_{N_PAST + i:02d}.png", t,
                         "nowcast", f"+{(i+1)*TIMESTEP_MIN} min", "maxz_extrap")
        centroids.append(((i + 1) * TIMESTEP_MIN, (cr, cc)))

    # ── 4. Manifest ─────────────────────────────────────────────────────────────
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "t0_utc":           t0.isoformat(),
        "t0_index":         N_PAST - 1,
        "step_min":         TIMESTEP_MIN,
        "source":           "maxz_reflectivity",
        "source_label":     "Radarová odrazivost (orientační intenzita)",
        "scale_mm_h":       {"min": RR_MIN, "max": RR_MAX},
        "bounds": [
            [meta["LL_lat"], meta["LL_lon"]],
            [meta["UR_lat"], meta["UR_lon"]],
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
    print(f"  Maxima mm/h (všech {n_frames} snímků): "
          + " ".join(f"{fm['max_mm_h']:.1f}" for fm in frames_meta))
    # Důkaz pohybu: těžiště srážek napříč nowcast kroky
    print(f"  Těžiště srážek (row,col) v nowcastu — důkaz pohybu:")
    for lead, (cr, cc) in centroids[::3]:   # každý 3. krok (+30, +60, +90, +120 min)
        if cr == cr:   # not NaN
            print(f"    +{lead:3d} min: ({cr:6.1f}, {cc:6.1f})")
        else:
            print(f"    +{lead:3d} min: (sucho)")
    if sanity_hits:
        print(f"  ⚠  SANITY: {len(sanity_hits)} snímků > {SANITY_MAX} mm/h "
              f"(podezření na chybu): {sanity_hits}")
    else:
        print(f"  ✓ SANITY OK: žádný snímek nepřekročil {SANITY_MAX} mm/h")
    print(f"  Manifest → {mpath}")


if __name__ == "__main__":
    main()
