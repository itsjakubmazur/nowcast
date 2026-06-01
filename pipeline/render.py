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
    load_sequence, dbz_to_rainrate, pick_merge_start_field,
)
from pysteps import motion, nowcasts

PRAGUE_TZ = ZoneInfo("Europe/Prague")
SCALE     = 1          # nativní rozlišení (~598×378); mřížka je 1 km, 2× nemá smysl
N_PAST    = 6          # počet historických snímků (5 zpětně advektovaných + t0)
OUT_DIR   = DATA_DIR / "radar_frames"

# ── Pevná SPOLEČNÁ barevná škála mm/h → RGBA (platí pro VŠECH 18 snímků) ───────
# Realistická dešťová stupnice pro ČR; alfa 0 = plně průhledné (sucho).
# 0.1–1 slabý · 1–4 mírný · 4–10 silnější · 10–30 intenzivní/bouřkový · ≥30 saturace
RR_MIN  = 0.10   # pod tímto prahem = plně průhledné
RR_MAX  = 30.0   # saturace stupnice (mm/h) — v ČR už bouřkový extrém
SANITY_MAX = 50.0  # nad touto hodnotou = podezření na chybu (kroupy/MAX_Z artefakt)
CMAP: list[tuple[float, tuple[int, int, int, int]]] = [
    (0.00, (  0,   0,   0,   0)),
    (0.08, (  0,   0,   0,   0)),   # pod šumovým prahem = stále průhledné
    (0.10, (160, 210, 255, 150)),   # slabý déšť — bledě modrá
    (0.50, ( 60, 140, 255, 190)),   # modrá
    (1.00, (  0, 200, 120, 210)),   # mírný — modrozelená
    (2.00, (  0, 200,   0, 220)),   # zelená
    (4.00, (180, 220,   0, 228)),   # silnější — žlutozelená
    (7.00, (255, 210,   0, 236)),   # žlutá
    (10.0, (255, 140,   0, 244)),   # intenzivní — oranžová
    (15.0, (255,  60,   0, 250)),   # červenooranžová
    (20.0, (220,   0,   0, 255)),   # červená
    (30.0, (150,   0,  80, 255)),   # saturace — tmavě červená/fialová
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

    # ── 1. Pohybové pole z MAX_Z (JEN advekční vektory, ne hodnoty) ─────────────
    maxz_paths = [radar_dir / "maxz" / n for n in radar_meta.get("maxz_files", [])]
    maxz_paths = [p for p in maxz_paths if p.exists()]
    if len(maxz_paths) < 2:
        print("ERROR: potřeba ≥ 2 MAX_Z snímky.", file=sys.stderr)
        sys.exit(1)

    maxz_stack, maxz_times = load_sequence(maxz_paths)
    t0 = maxz_times[-1]

    print(f"\n=== Render radarových PNG (scale {SCALE}×, {N_PAST} hist + {N_LEADTIMES} nowcast) ===")
    print(f"  Veličina: MERGE QPE (mm/h u země) — NE MAX_Z (sloupcová odrazivost přepaluje)")
    print(f"  MAX_Z slouží JEN k odhadu pohybového pole (advekční vektory).")
    print(f"  Pevná škála: {RR_MIN}–{RR_MAX} mm/h (průhledné < {RR_MIN}, saturace ≥ {RR_MAX})")
    print(f"  t0 = {t0.isoformat()}")

    motion_field = motion.get_method("lucaskanade")(np.nan_to_num(maxz_stack, nan=0.0))

    # ── 2. Startovní pole = MERGE QPE (mm/h u země); fallback MAX_Z rain rate ────
    merge_paths = [radar_dir / "merge" / n for n in radar_meta.get("merge_files", [])]
    merge_paths = [p for p in merge_paths if p.exists()]
    start_rr, rr_source = pick_merge_start_field(merge_paths, t0)
    if start_rr is None:
        print(f"  ⚠  MERGE nedostupný ({rr_source}) — fallback na MAX_Z rain rate (může přepalovat)")
        start_rr = dbz_to_rainrate(maxz_stack[-1])
        rr_source = "maxz_fallback"
    else:
        print(f"  Startovní pole: {rr_source}")

    # ── 3. Advekce MERGE pole: dozadu (minulost) i dopředu (nowcast) ────────────
    extrap = nowcasts.get_method("extrapolation")
    rr_clean = np.nan_to_num(start_rr, nan=0.0)
    n_back = N_PAST - 1   # 5 zpětných + samotné t0 = 6 historických
    fwd = extrap(rr_clean, motion_field, N_LEADTIMES,
                 extrap_kwargs={"allow_nonfinite_values": True})
    bwd = extrap(rr_clean, -motion_field, n_back,
                 extrap_kwargs={"allow_nonfinite_values": True})  # bwd[k] = t0-(k+1)*step

    # ── 4. Render všech snímků (společná škála) ─────────────────────────────────
    frames_meta: list[dict] = []
    total_bytes = 0
    sanity_hits = []

    def _render(rr: np.ndarray, fname: str, t: datetime, ftype: str, tag: str) -> None:
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
        print(f"  {fname}  {t.strftime('%H:%M')} UTC  {tag:>9s}  "
              f"max={mx:6.1f} mm/h  {sz//1024:3d} kB{flag}")
        frames_meta.append({
            "file":       fname,
            "time_utc":   t.isoformat(),
            "time_local": t.astimezone(PRAGUE_TZ).strftime("%H:%M"),
            "type":       ftype,
            "max_mm_h":   round(mx, 1),
        })

    print("\n  Snímek         čas    typ         maximum         velikost")
    # Historické: 5 zpětných (nejstarší první) → t0
    for k in range(n_back, 0, -1):     # k = 5,4,3,2,1  → bwd index k-1
        t = t0 - timedelta(minutes=k * TIMESTEP_MIN)
        idx = n_back - k               # 0..4 (souborové pořadí)
        _render(bwd[k - 1].copy(), f"frame_{idx:02d}.png", t, "past", f"-{k*TIMESTEP_MIN} min")
    # t0 (samotné MERGE pole)
    _render(start_rr, f"frame_{n_back:02d}.png", t0, "t0", "● TEĎ")
    # Nowcast: dopředu
    for i in range(N_LEADTIMES):
        t = t0 + timedelta(minutes=(i + 1) * TIMESTEP_MIN)
        _render(fwd[i].copy(), f"frame_{N_PAST + i:02d}.png", t,
                "nowcast", f"+{(i+1)*TIMESTEP_MIN} min")

    # ── 5. Manifest ─────────────────────────────────────────────────────────────
    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "t0_utc":           t0.isoformat(),
        "t0_index":         N_PAST - 1,
        "step_min":         TIMESTEP_MIN,
        "source":           rr_source,
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
    print(f"  Maxima mm/h (všech {n_frames} snímků): "
          + " ".join(f"{fm['max_mm_h']:.1f}" for fm in frames_meta))
    if sanity_hits:
        print(f"  ⚠  SANITY: {len(sanity_hits)} snímků > {SANITY_MAX} mm/h "
              f"(podezření na chybu): {sanity_hits}")
    else:
        print(f"  ✓ SANITY OK: žádný snímek nepřekročil {SANITY_MAX} mm/h")
    print(f"  Manifest → {mpath}")


if __name__ == "__main__":
    main()
