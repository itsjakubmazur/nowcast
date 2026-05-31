"""
Fáze 1 — Ingest
- Stáhne posledních N radarových kompozitů MAX_Z (pohyb) z ČHMÚ opendata
- Stáhne MERGE (hodinový QPE radar+srážkoměry) pro odhad úhrnů
- Stáhne aktuální předpověď z Open-Meteo pro zadanou lokaci (vše v UTC)
- Uloží data do data/ a vypíše shape gridu
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import h5py
import numpy as np
import requests

# ── Konfigurace ────────────────────────────────────────────────────────────────
# MAX_Z: maximum odrazivosti ve sloupci — pro odhad pohybu (advekci)
RADAR_MAXZ_BASE  = "https://opendata.chmi.cz/meteorology/weather/radar/composite/maxz/hdf5/"
# MERGE: hodinový QPE (radar + srážkoměry) — nejpřesnější úhrn u země
# Publikuje se se zpožděním ~20–30 min, proto UTC timestampy se musí zarovnávat.
RADAR_MERGE_BASE = "https://opendata.chmi.cz/meteorology/weather/radar/composite/merge1h/hdf5/"

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
DATA_DIR = Path(__file__).parent.parent / "data"
N_FRAMES = 6   # počet MAX_Z snímků pro odhad pohybu
N_MERGE  = 3   # MERGE je hodinový → stačí poslední 3 (= 3 h)

# Defaultní lokace: Praha
DEFAULT_LAT = 50.08
DEFAULT_LON = 14.42

# ── Helpers ────────────────────────────────────────────────────────────────────

def fetch_radar_file_list(base_url: str) -> list[str]:
    """Parsuje directory listing a vrátí seřazené názvy .hdf souborů."""
    resp = requests.get(base_url, timeout=30)
    resp.raise_for_status()
    files = re.findall(r'href="(T_[^"]+\.hdf)"', resp.text)
    if not files:
        files = re.findall(r'"([^"]+\.hdf)"', resp.text)
    return sorted(set(files))  # timestamp je součástí názvu → řazení = chronologie


def download_file(url: str, dest: Path) -> Path:
    """Stáhne soubor pokud ještě neexistuje."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        print(f"  [cache] {dest.name}")
        return dest
    print(f"  [down]  {dest.name}")
    with requests.get(url, timeout=60, stream=True) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                f.write(chunk)
    return dest


def read_odim_dbz(path: Path) -> tuple[np.ndarray, dict]:
    """
    Načte raw data z ODIM HDF5, zamaskuje nodata/undetect a vrátí pole dBZ s NaN.
    Vrací (dbz_array [float32, NaN kde žádný signál], metadata dict).
    """
    with h5py.File(path, "r") as f:
        # ── Projekce a rozměry gridu (/where) ──────────────────────────────────
        meta = {}
        where = f.get("where", {})
        if hasattr(where, "attrs"):
            for key in ("projdef", "xsize", "ysize", "xscale", "yscale",
                        "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
                val = where.attrs.get(key)
                if val is not None:
                    meta[key] = val.decode() if isinstance(val, bytes) else float(val)

        # ── Čas snímku (/what) — vždy UTC ──────────────────────────────────────
        what_root = f.get("what", {})
        if hasattr(what_root, "attrs"):
            date_s = what_root.attrs.get("date", b"").decode()
            time_s = what_root.attrs.get("time", b"").decode()
            if date_s and time_s:
                dt = datetime.strptime(date_s + time_s[:6], "%Y%m%d%H%M%S")
                meta["utc_time"] = dt.replace(tzinfo=timezone.utc).isoformat()

        # ── První dataset s daty ────────────────────────────────────────────────
        raw = None
        for ds_name in sorted(f.keys()):
            if not ds_name.startswith("dataset"):
                continue
            ds = f[ds_name]
            for d_name in sorted(ds.keys()):
                if not d_name.startswith("data"):
                    continue
                data_node = ds[d_name].get("data")
                if data_node is None:
                    continue
                raw = data_node[()].astype(np.float32)
                meta["shape"] = tuple(raw.shape)
                meta["dtype_raw"] = str(data_node.dtype)

                what_ds = ds[d_name].get("what")
                if what_ds is not None and hasattr(what_ds, "attrs"):
                    gain     = float(what_ds.attrs.get("gain",     0.5))
                    offset   = float(what_ds.attrs.get("offset",   -32.0))
                    nodata   = float(what_ds.attrs.get("nodata",   255.0))
                    undetect = float(what_ds.attrs.get("undetect", 0.0))
                    # quantity a unit: klíčové pro rozlišení dBZ (MAX_Z) vs mm/h (MERGE)
                    qty = what_ds.attrs.get("quantity", b"")
                    unit = what_ds.attrs.get("unit", b"")
                    meta.update({
                        "gain": gain, "offset": offset,
                        "nodata": nodata, "undetect": undetect,
                        "quantity": qty.decode() if isinstance(qty, bytes) else str(qty),
                        "unit":     unit.decode() if isinstance(unit, bytes) else str(unit),
                    })

                    mask = (raw == nodata) | (raw == undetect)
                    raw = raw * gain + offset
                    raw[mask] = np.nan

                break
            if raw is not None:
                break

    if raw is None:
        raise ValueError(f"Nenalezena data v {path}")

    return raw, meta


def inspect_hdf5(path: Path) -> dict:
    """Wrapper — vrátí jen metadata (pro tisk), data zahodí."""
    _, meta = read_odim_dbz(path)
    return meta


def fetch_open_meteo(lat: float, lon: float) -> dict:
    """
    Stáhne krátkodobou předpověď z Open-Meteo.
    timezone=UTC — časy jsou vždy UTC, bez letního posunu.
    Převod na lokální čas se provádí až ve finálním verdiktu.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "minutely_15": ",".join([
            "precipitation", "rain", "snowfall",
            "windspeed_10m", "winddirection_10m",
            "cape",
        ]),
        "hourly": ",".join([
            "precipitation", "rain", "showers",
            "windspeed_10m", "windgusts_10m",
            "cape", "lifted_index",
            "precipitation_probability",
        ]),
        "daily": ",".join([
            "precipitation_sum", "precipitation_hours",
            "windspeed_10m_max", "windgusts_10m_max",
        ]),
        "timezone": "UTC",
        "forecast_days": 1,
        "models": "icon_d2",
    }
    resp = requests.get(OPEN_METEO_URL, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_merge(radar_dir: Path, n: int) -> list[Path]:
    """
    Stáhne posledních n MERGE (hodinový QPE) souborů.
    MERGE se publikuje se zpožděním ~20–30 min oproti MAX_Z.
    Vrátí seznam stažených Path nebo prázdný seznam při chybě.
    """
    try:
        files = fetch_radar_file_list(RADAR_MERGE_BASE)
        if not files:
            print("  [MERGE] Directory listing prázdný.")
            return []
        latest = files[-n:]
        dest_dir = radar_dir / "merge"
        downloaded = [
            download_file(RADAR_MERGE_BASE + f, dest_dir / f)
            for f in latest
        ]
        print(f"  [MERGE] staženo {len(downloaded)} snímků")
        return downloaded
    except Exception as e:
        print(f"  [MERGE] nedostupné: {e}")
        return []


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    radar_dir = DATA_DIR / "radar"
    radar_dir.mkdir(exist_ok=True)

    # ── 1a. MAX_Z (pohyb / advekce) ────────────────────────────────────────────
    print(f"\n=== Radar MAX_Z ingest ===")
    maxz_files = fetch_radar_file_list(RADAR_MAXZ_BASE)
    if not maxz_files:
        print("ERROR: Nenalezeny soubory MAX_Z!", file=sys.stderr)
        sys.exit(1)

    latest_maxz = maxz_files[-N_FRAMES:]
    print(f"Nalezeno {len(maxz_files)} souborů MAX_Z, stahuju posledních {len(latest_maxz)}:")
    downloaded_maxz = [
        download_file(RADAR_MAXZ_BASE + f, radar_dir / "maxz" / f)
        for f in latest_maxz
    ]

    print("\n--- Metadata MAX_Z (nejnovější snímek) ---")
    meta_new = inspect_hdf5(downloaded_maxz[-1])
    for k, v in meta_new.items():
        print(f"  {k}: {v}")

    dbz, _ = read_odim_dbz(downloaded_maxz[-1])
    nan_pct = 100.0 * np.isnan(dbz).sum() / dbz.size
    print(f"\n  dBZ pole: shape={dbz.shape}, NaN={nan_pct:.1f}%")
    valid = dbz[~np.isnan(dbz)]
    if valid.size:
        print(f"  dBZ rozsah (platné px): min={valid.min():.1f}, max={valid.max():.1f}, "
              f"mean={valid.mean():.1f}")

    # ── 1b. MERGE (srážky u země, QPE) ────────────────────────────────────────
    print(f"\n=== Radar MERGE ingest (QPE pro odhad úhrnů) ===")
    downloaded_merge = fetch_merge(radar_dir, N_MERGE)
    if downloaded_merge:
        # Zaloguj UTC časy MERGE snímků — pro kontrolu zpoždění vůči MAX_Z
        for p in downloaded_merge:
            m = inspect_hdf5(p)
            print(f"  MERGE utc_time: {m.get('utc_time', 'N/A')}  ({p.name})")
        print(f"  Nejnovější MAX_Z : {meta_new.get('utc_time', 'N/A')}")
    else:
        print("  Varování: MERGE nedostupný — úhrny budou z MAX_Z (nadhodnocení možné)")

    # ── Ulož metadata ──────────────────────────────────────────────────────────
    meta_path = DATA_DIR / "radar_meta.json"
    with open(meta_path, "w") as f:
        json.dump({
            "maxz_files":      [p.name for p in downloaded_maxz],
            "merge_files":     [p.name for p in downloaded_merge],
            "maxz_base_url":   RADAR_MAXZ_BASE,
            "merge_base_url":  RADAR_MERGE_BASE,
            "meta_latest":     {k: str(v) for k, v in meta_new.items()},
            "ingested_at_utc": datetime.now(timezone.utc).isoformat(),
        }, f, indent=2)
    print(f"\nMetadata uložena → {meta_path}")

    # ── 2. Open-Meteo (UTC) ────────────────────────────────────────────────────
    print(f"\n=== Open-Meteo ingest (lat={lat}, lon={lon}, timezone=UTC, models=icon_d2) ===")
    om_data = fetch_open_meteo(lat, lon)
    om_path = DATA_DIR / "openmeteo.json"
    with open(om_path, "w") as f:
        json.dump(om_data, f, indent=2)

    m15    = om_data.get("minutely_15", {})
    hourly = om_data.get("hourly", {})
    print(f"  15min záznamy   : {len(m15.get('time', []))}")
    print(f"  Hodinové záznamy: {len(hourly.get('time', []))}")
    print(f"  Timezone v datech: {om_data.get('timezone', 'N/A')}")

    # Logujeme všechny top-level klíče, aby bylo vidět, kde model sedí
    top_keys = [k for k in om_data if not isinstance(om_data[k], dict)]
    print(f"  Top-level skalární klíče v odpovědi: {top_keys}")
    for k in top_keys:
        if "model" in k.lower() or k in ("timezone", "latitude", "longitude", "elevation"):
            print(f"    {k} = {om_data[k]}")

    if m15.get("time"):
        print(f"  První 15min timestamp: {m15['time'][0]}")
    print(f"  Open-Meteo data uložena → {om_path}")

    print("\n✓ Fáze 1 — Ingest OK")


if __name__ == "__main__":
    main()
