"""
Fáze 1 — Ingest
- Stáhne posledních N radarových kompozitů MAX_Z z ČHMÚ opendata (HDF5/ODIM)
- Stáhne aktuální předpověď z Open-Meteo pro zadanou lokaci
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
RADAR_BASE = "https://opendata.chmi.cz/meteorology/weather/radar/composite/maxz/hdf5/"
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
DATA_DIR = Path(__file__).parent.parent / "data"
N_FRAMES = 6  # počet snímků pro odhad pohybu

# Defaultní lokace: Praha
DEFAULT_LAT = 50.08
DEFAULT_LON = 14.42

# ── Helpers ────────────────────────────────────────────────────────────────────

def fetch_radar_file_list(base_url: str) -> list[str]:
    """Parsuje directory listing a vrátí seřazené názvy .hdf souborů."""
    resp = requests.get(base_url, timeout=30)
    resp.raise_for_status()
    # ČHMÚ vrací Apache/nginx directory listing s href="..." odkazy
    files = re.findall(r'href="(T_[^"]+\.hdf)"', resp.text)
    if not files:
        # záložní: hledat libovolné .hdf soubory
        files = re.findall(r'"([^"]+\.hdf)"', resp.text)
    return sorted(set(files))  # seřazení podle timestampu v názvu


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


def inspect_hdf5(path: Path) -> dict:
    """Čte základní metadata z ODIM HDF5 souboru."""
    info = {}
    with h5py.File(path, "r") as f:
        # ODIM: /what obsahuje datum, čas, objekt
        what = f.get("what", {})
        info["date"] = what.attrs.get("date", b"").decode() if hasattr(what, "attrs") else ""
        info["time"] = what.attrs.get("time", b"").decode() if hasattr(what, "attrs") else ""
        info["object"] = what.attrs.get("object", b"").decode() if hasattr(what, "attrs") else ""

        # ODIM: /where obsahuje projekci a rozměry gridu
        where = f.get("where", {})
        if hasattr(where, "attrs"):
            for key in ("projdef", "xsize", "ysize", "xscale", "yscale",
                        "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
                val = where.attrs.get(key)
                if val is not None:
                    info[key] = val.decode() if isinstance(val, bytes) else float(val)

        # Najdi první dataset s daty
        for ds_name in f.keys():
            if not ds_name.startswith("dataset"):
                continue
            ds = f[ds_name]
            for d_name in ds.keys():
                if not d_name.startswith("data"):
                    continue
                data_node = ds[d_name].get("data")
                if data_node is not None:
                    info["shape"] = tuple(data_node.shape)
                    info["dtype"] = str(data_node.dtype)
                    # gain/offset pro přepočet raw → dBZ
                    what_ds = ds[d_name].get("what")
                    if what_ds is not None and hasattr(what_ds, "attrs"):
                        info["gain"] = float(what_ds.attrs.get("gain", 0.5))
                        info["offset"] = float(what_ds.attrs.get("offset", -32.0))
                        info["nodata"] = float(what_ds.attrs.get("nodata", 255))
                        info["undetect"] = float(what_ds.attrs.get("undetect", 0))
                    break
            if "shape" in info:
                break

    return info


def fetch_open_meteo(lat: float, lon: float) -> dict:
    """Stáhne krátkodobou předpověď z Open-Meteo."""
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
        "timezone": "Europe/Prague",
        "forecast_days": 1,
        "models": "icon_d2",  # DWD ICON-D2: nejlepší pro krátký horizont nad ČR
    }
    resp = requests.get(OPEN_METEO_URL, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    radar_dir = DATA_DIR / "radar"
    radar_dir.mkdir(exist_ok=True)

    # ── 1. Radar HDF5 ──────────────────────────────────────────────────────────
    print(f"\n=== Radar ingest ({RADAR_BASE}) ===")
    all_files = fetch_radar_file_list(RADAR_BASE)
    if not all_files:
        print("ERROR: Nenalezeny žádné soubory v directory listingu!", file=sys.stderr)
        sys.exit(1)

    latest = all_files[-N_FRAMES:]
    print(f"Nalezeno {len(all_files)} souborů, stahuju posledních {len(latest)}:")

    downloaded = []
    for fname in latest:
        url = RADAR_BASE + fname
        dest = radar_dir / fname
        downloaded.append(download_file(url, dest))

    # Inspect první a poslední soubor
    print("\n--- Metadata HDF5 (nejstarší snímek) ---")
    meta_old = inspect_hdf5(downloaded[0])
    for k, v in meta_old.items():
        print(f"  {k}: {v}")

    print("\n--- Metadata HDF5 (nejnovější snímek) ---")
    meta_new = inspect_hdf5(downloaded[-1])
    for k, v in meta_new.items():
        print(f"  {k}: {v}")

    # Ulož metadata pro navazující kroky
    meta_path = DATA_DIR / "radar_meta.json"
    with open(meta_path, "w") as f:
        json.dump({
            "downloaded": [str(p.name) for p in downloaded],
            "base_url": RADAR_BASE,
            "meta_latest": {k: str(v) for k, v in meta_new.items()},
        }, f, indent=2)
    print(f"\nMetadata uložena → {meta_path}")

    # ── 2. Open-Meteo ──────────────────────────────────────────────────────────
    print(f"\n=== Open-Meteo ingest (lat={lat}, lon={lon}) ===")
    om_data = fetch_open_meteo(lat, lon)
    om_path = DATA_DIR / "openmeteo.json"
    with open(om_path, "w") as f:
        json.dump(om_data, f, indent=2)

    # Shrnutí: počty záznamů
    m15 = om_data.get("minutely_15", {})
    hourly = om_data.get("hourly", {})
    print(f"  15min záznamy : {len(m15.get('time', []))}")
    print(f"  Hodinové záznamy: {len(hourly.get('time', []))}")
    print(f"  Model: {om_data.get('model', 'N/A')}")
    print(f"  Open-Meteo data uložena → {om_path}")

    print("\n✓ Fáze 1 — Ingest OK")


if __name__ == "__main__":
    main()
