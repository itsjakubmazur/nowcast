"""
Fáze 4c — Render radarových PNG snímků pro webovou smyčku
- VŠECH 18 snímků (6 historických + 12 nowcast) ze stejného zdroje: MAX_Z odrazivost.
- Barvení PŘÍMO v dBZ (žádný Z→R, žádný strop) — jako ČHMÚ/Windy.
- Pevná škála 5–65 dBZ, plynulý gradient, < 5 dBZ průhledné.
- Nowcast: poslední MAX_Z pole advektované pohybovým polem (lucaskanade).
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
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR
from nowcast import TIMESTEP_MIN, N_LEADTIMES, load_sequence
from pysteps import motion, nowcasts

PRAGUE_TZ = ZoneInfo("Europe/Prague")
SCALE     = 1
N_PAST    = 6
OUT_DIR   = DATA_DIR / "radar_frames"

# ── Standardní radarová dBZ škála ─────────────────────────────────────────────
# Rozsah 5–65 dBZ, plynulý gradient, průhlednost klesá se slabší ozvěnou.
# Hodnoty mimo rozsah: < 5 → plně průhledné; > 65 → saturace (tmavě fialová).
DBZ_MIN = 5.0
DBZ_MAX = 65.0

# (dBZ, (R, G, B, A))
# Průhledné zarážky (A=0) mají RGB shodné s první viditelnou barvou — kdyby
# byly černé, interpolace LUT by u okrajů ozvěn míchala do modré černou a
# kolem každé srážkové buňky by vznikl tmavý lem.
CMAP_DBZ: list[tuple[float, tuple[int, int, int, int]]] = [
    ( 0.0, (160, 210, 255,   0)),   # pod prahem = průhledné
    ( 5.0, (160, 210, 255,   0)),   # stále průhledné (odtud alfa plynule roste)
    (10.0, (160, 210, 255, 100)),   # velmi slabé — bledě modrá, poloprůhledná
    (15.0, ( 80, 160, 255, 140)),
    (20.0, ( 30, 120, 230, 170)),   # slabé — modrá
    (25.0, (  0, 200, 160, 190)),   # modrozelená
    (30.0, (  0, 200,  50, 210)),   # zelená
    (35.0, ( 80, 210,   0, 220)),   # žlutozelená
    (40.0, (200, 220,   0, 230)),   # žlutá
    (45.0, (255, 180,   0, 238)),   # žlutooranžová
    (48.0, (255, 120,   0, 244)),   # oranžová (silné)
    (52.0, (255,  50,   0, 250)),   # červenooranžová
    (55.0, (220,   0,   0, 255)),   # červená (velmi silné)
    (60.0, (160,   0,  60, 255)),   # tmavě červená
    (65.0, (100,   0, 120, 255)),   # fialová (extrém/kroupy)
]

_LUT_SIZE = 2048


def _build_lut() -> np.ndarray:
    dbz_pts  = np.array([c[0] for c in CMAP_DBZ], dtype=float)
    rgba_pts = np.array([c[1] for c in CMAP_DBZ], dtype=float)
    xs  = np.linspace(DBZ_MIN, DBZ_MAX, _LUT_SIZE)
    lut = np.stack([np.interp(xs, dbz_pts, rgba_pts[:, ch]) for ch in range(4)], axis=-1)
    return np.clip(lut, 0, 255).astype(np.uint8)


_LUT = _build_lut()
# Průhledná barva pro hodnoty pod DBZ_MIN
_TRANSPARENT = np.array([0, 0, 0, 0], dtype=np.uint8)


# Supersampling + vyhlazení: radarový grid (~1 km/px) vypadá po roztažení
# Leafletem přes celou ČR kostičkovaně. Pole proto před obarvením 2× zvětšíme
# bilineárně přímo v dBZ a lehce vyhladíme Gaussem (σ<1 px na 2× gridu ≈
# σ<0.5 px původního — detaily buněk zůstávají, schodovité hrany zmizí).
UPSAMPLE   = 2
SMOOTH_SIG = 0.9


def _upsample_smooth(dbz: np.ndarray) -> np.ndarray:
    """Bilineární 2× upsample + jemný Gauss; NaN/pod prahem drží pod DBZ_MIN."""
    # NaN → hodnota hluboko pod prahem, ať interpolace na okraji ozvěny plynule
    # klesá pod DBZ_MIN místo šíření NaN do sousedních pixelů.
    fill = DBZ_MIN - 10.0
    d = np.nan_to_num(dbz, nan=fill)
    d = np.maximum(d, fill)
    up = ndimage.zoom(d, UPSAMPLE, order=1, prefilter=False)
    return ndimage.gaussian_filter(up, sigma=SMOOTH_SIG)


def dbz_to_img(dbz: np.ndarray) -> Image.Image:
    """
    2D pole dBZ (float32, NaN povoleno) → kvantizovaný PIL Image (paleta + alfa).
    Hodnoty < DBZ_MIN nebo NaN → průhledné.
    """
    d = _upsample_smooth(dbz)
    mask_vis = d >= DBZ_MIN   # pixely s detekovatelnou ozvěnou
    d_clamped = np.clip(d, DBZ_MIN, DBZ_MAX)
    idx = ((d_clamped - DBZ_MIN) / (DBZ_MAX - DBZ_MIN) * (_LUT_SIZE - 1)).astype(np.int32)

    # RGBA array: začni jako průhledné, pak nastav viditelné pixely z LUT
    rgba = np.zeros((*d.shape, 4), dtype=np.uint8)
    rgba[mask_vis] = _LUT[idx[mask_vis]]

    img = Image.fromarray(rgba, mode="RGBA")
    if SCALE != 1:
        h, w = d.shape
        img = img.resize((w * SCALE, h * SCALE), Image.Resampling.BILINEAR)
    return img.quantize(colors=256, method=Image.Quantize.FASTOCTREE)


def palette_stops() -> list[list]:
    """Barevné zarážky CMAP_DBZ jako [dbz, '#rrggbb'] — pro legendu na webu,
    ať UI vždy zrcadlí přesně to, co se opravdu vykreslilo do PNG."""
    return [
        [dbz, f"#{r:02x}{g:02x}{b:02x}"]
        for dbz, (r, g, b, a) in CMAP_DBZ if a > 0
    ]


def _centroid(dbz: np.ndarray) -> tuple[float, float]:
    """Těžiště (row, col) vážené dBZ intenzitou; (nan,nan) když sucho."""
    m = dbz >= DBZ_MIN
    if not m.any():
        return float("nan"), float("nan")
    rows, cols = np.nonzero(m)
    w = dbz[rows, cols]
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

    # ── 1. MAX_Z sekvence ────────────────────────────────────────────────────────
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 2:
        print("ERROR: potřeba ≥ 2 MAX_Z snímky.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)   # dBZ, nejstarší→nejnovější
    t0     = maxz_times[-1]
    n_maxz = len(maxz_paths)

    print(f"\n=== Render radarových PNG (scale {SCALE}×, {N_PAST} hist + {N_LEADTIMES} nowcast) ===")
    print(f"  Zdroj: MAX_Z odrazivost, barveno přímo v dBZ (bez Z→R)")
    print(f"  Škála: {DBZ_MIN}–{DBZ_MAX} dBZ  (průhledné < {DBZ_MIN})")
    print(f"  t0 = {t0.isoformat()}  ({n_maxz} MAX_Z souborů)")

    motion_field = motion.get_method("lucaskanade")(np.nan_to_num(maxz_stack, nan=0.0))

    # ── 2. Nowcast: advekce posledního dBZ pole ──────────────────────────────────
    extrap = nowcasts.get_method("extrapolation")
    dbz0   = np.nan_to_num(maxz_stack[-1], nan=0.0)
    fwd    = extrap(dbz0, motion_field, N_LEADTIMES,
                    extrap_kwargs={"allow_nonfinite_values": True})

    # ── 3. Render ────────────────────────────────────────────────────────────────
    frames_meta: list[dict] = []
    total_bytes = 0

    def _render(dbz: np.ndarray, fname: str, t: datetime,
                ftype: str, tag: str, src: str) -> tuple[float, float]:
        nonlocal total_bytes
        img   = dbz_to_img(dbz)
        fpath = OUT_DIR / fname
        img.save(fpath, format="PNG", optimize=True)
        sz    = fpath.stat().st_size
        total_bytes += sz
        valid = dbz[~np.isnan(dbz) & (dbz >= DBZ_MIN)]
        mn    = float(valid.min()) if valid.size else 0.0
        mx    = float(valid.max()) if valid.size else 0.0
        print(f"  {fname}  {t.strftime('%H:%M')} UTC  {tag:>9s}  "
              f"dBZ {mn:4.0f}–{mx:4.0f}  {sz//1024:3d} kB  [{src}]")
        frames_meta.append({
            "file":       fname,
            "time_utc":   t.isoformat(),
            "time_local": t.astimezone(PRAGUE_TZ).strftime("%H:%M"),
            "type":       ftype,
            "source":     src,
            "dbz_min":    round(mn, 1),
            "dbz_max":    round(mx, 1),
        })
        return _centroid(dbz)

    def _render_og(dbz: np.ndarray, t: datetime) -> None:
        """1200×630 sdílecí obrázek (OG card) — design v og_card.py."""
        from og_card import build_card
        radar_img = dbz_to_img(dbz).convert("RGBA")
        card = build_card(radar_img, t.astimezone(PRAGUE_TZ).strftime("%H:%M"))
        card.save(DATA_DIR / "og.png", format="PNG", optimize=True)
        print(f"  ✓ og.png (sdílecí obrázek) — {(DATA_DIR / 'og.png').stat().st_size // 1024} kB")

    print("\n  Snímek         čas    typ         rozsah dBZ    vel.  zdroj")

    # Historické: posledních N_PAST MAX_Z snímků (nebo méně + padding)
    n_hist = min(N_PAST, n_maxz)
    hist_indices = list(range(n_maxz - n_hist, n_maxz))
    n_pad  = N_PAST - n_hist
    for k in range(n_pad):
        t = t0 - timedelta(minutes=(N_PAST - 1 - k) * TIMESTEP_MIN)
        empty = np.full_like(maxz_stack[-1], np.nan)
        _render(empty, f"frame_{k:02d}.png", t, "past",
                f"-{(N_PAST-1-k)*TIMESTEP_MIN} min", "empty")
    for rank, si in enumerate(hist_indices):
        frame_idx = n_pad + rank
        t     = maxz_times[si]
        lag   = int((t0 - t).total_seconds() / 60)
        ftype = "t0" if si == n_maxz - 1 else "past"
        tag   = "● TEĎ" if si == n_maxz - 1 else f"-{lag} min"
        _render(maxz_stack[si].copy(), f"frame_{frame_idx:02d}.png", t, ftype, tag, "maxz")

    # Nowcast + sledování těžiště
    centroids: list[tuple[int, tuple[float, float]]] = []
    for i in range(N_LEADTIMES):
        t = t0 + timedelta(minutes=(i + 1) * TIMESTEP_MIN)
        cr, cc = _render(fwd[i].copy(), f"frame_{N_PAST + i:02d}.png", t,
                         "nowcast", f"+{(i+1)*TIMESTEP_MIN} min", "maxz_extrap")
        centroids.append(((i + 1) * TIMESTEP_MIN, (cr, cc)))

    # ── 3b. OG sdílecí obrázek (nejnovější MAX_Z, tj. "teď") ──────────────────────
    try:
        _render_og(maxz_stack[-1].copy(), t0)
    except Exception as e:
        print(f"  Varování: og.png se nepodařilo vygenerovat: {e}")

    # ── 4. Manifest ─────────────────────────────────────────────────────────────
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "t0_utc":           t0.isoformat(),
        "t0_index":         N_PAST - 1,
        "step_min":         TIMESTEP_MIN,
        "source":           "maxz_reflectivity_dbz",
        "source_label":     "Radarová odrazivost (dBZ) — orientační intenzita srážek",
        "scale_dbz":        {"min": DBZ_MIN, "max": DBZ_MAX},
        "palette":          palette_stops(),
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
    print(f"  dBZ maxima (všech {n_frames} snímků): "
          + " ".join(str(fm["dbz_max"]) for fm in frames_meta))
    print(f"  Těžiště srážek (row,col) v nowcastu — důkaz pohybu:")
    for lead, (cr, cc) in centroids[::3]:
        if cr == cr:
            print(f"    +{lead:3d} min: row={cr:6.1f}  col={cc:6.1f}")
        else:
            print(f"    +{lead:3d} min: (sucho)")
    print(f"  Manifest → {mpath}")


if __name__ == "__main__":
    main()
