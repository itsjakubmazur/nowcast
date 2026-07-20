"""
ALADIN/ČHMÚ — numerická předpověď z opendata.chmi.cz → data/aladin.json.

Jediný veřejný high-res model přímo od ČHMÚ (1 km, 72 h, běhy 00/06/12/18 UTC).
Open-Meteo ho nenabízí, tak si ho stahujeme a parsujeme sami z GRIB1.

Struktura na serveru (zjištěno sondou):
  CZ_1km/{00,06,12,18}/ALADCZ1K4opendata_{YYYYMMDDHH}_{VAR}.grb.bz2
  bz2 GRIB, jeden soubor na proměnnou, uvnitř 73 hodinových kroků (0–72 h).
  Mřížka regular_ll 501×290 od (48.5N,12.0E), krok 0.014°/0.009°, S→N, Z→V.
  CLSTEMPERATURE = 2m teplota (K), SURFPREC_TOTAL = kumul. srážky od začátku běhu.

Výstup data/aladin.json: řídká mřížka bodů nad ČR, per bod hodinová teplota
(°C) a hodinové srážky (mm, deakumulované) na prvních HOURS hodin. Klient
(models.js) najde nejbližší bod a zapojí ALADIN do panelu modelů i do
učícího se žebříčku přesnosti.
"""

import bz2
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR

BASE = "https://opendata.chmi.cz/meteorology/weather/nwp_aladin/CZ_1km/"
RUN_HOURS = ["18", "12", "06", "00"]
HOURS = 48          # kolik hodin dopředu uložit (72 je zbytečně velké)
GRID_STEP = 0.25    # ° — řídká mřížka nad ČR (klient sampluje nejbližší bod)
CZ = dict(lat_min=48.6, lat_max=51.0, lon_min=12.2, lon_max=18.8)
BUDGET_S = 90

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def list_dir(url: str) -> list[str]:
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    return [h for h in re.findall(r'href="([^"]+)"', r.text)
            if h not in ("../", "/") and not h.startswith("?")]


def latest_run() -> str | None:
    """Nejnovější dostupný běh (YYYYMMDDHH) — hledá napříč hodinovými adresáři
    podle CLSTEMPERATURE (ta je vždy)."""
    best = None
    for hh in RUN_HOURS:
        try:
            files = list_dir(BASE + hh + "/")
        except Exception:
            continue
        for f in files:
            m = re.match(r"ALADCZ1K4opendata_(\d{10})_CLSTEMPERATURE\.grb\.bz2$", f)
            if m and (best is None or int(m.group(1)) > int(best)):
                best = m.group(1)
    return best


def var_url(run: str, var: str) -> str:
    return f"{BASE}{run[8:10]}/ALADCZ1K4opendata_{run}_{var}.grb.bz2"


def download_grib(url: str) -> bytes | None:
    try:
        raw = SESSION.get(url, timeout=120).content
        return bz2.decompress(raw)
    except Exception as e:
        print(f"  {url.split('/')[-1]}: {e}")
        return None


def build_targets():
    """Řídká mřížka bodů nad ČR: (lat, lon) list + jejich indexy do ALADIN pole."""
    lats = np.arange(CZ["lat_min"], CZ["lat_max"] + 1e-9, GRID_STEP)
    lons = np.arange(CZ["lon_min"], CZ["lon_max"] + 1e-9, GRID_STEP)
    pts = [(round(float(la), 3), round(float(lo), 3)) for la in lats for lo in lons]
    return pts


def read_field_stack(grib: bytes, n_steps: int):
    """Vrátí (values[n_steps, Nj, Ni], geo, valid_times[list ISO])."""
    import eccodes as ec
    tmp = Path("/tmp/aladin.grib")
    tmp.write_bytes(grib)
    fields, times, geo = [], [], None
    with open(tmp, "rb") as f:
        while len(fields) < n_steps:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            if geo is None:
                geo = dict(
                    Ni=ec.codes_get(gid, "Ni"), Nj=ec.codes_get(gid, "Nj"),
                    lat0=ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                    lon0=ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees"),
                    di=ec.codes_get(gid, "iDirectionIncrementInDegrees"),
                    dj=ec.codes_get(gid, "jDirectionIncrementInDegrees"),
                )
            vd = ec.codes_get(gid, "validityDate")
            vt = ec.codes_get(gid, "validityTime")
            dt = datetime.strptime(f"{vd:08d}{vt:04d}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            times.append(dt.isoformat())
            vals = np.array(ec.codes_get_values(gid), dtype=np.float32)
            fields.append(vals.reshape(geo["Nj"], geo["Ni"]))  # j: S→N, i: Z→V
            ec.codes_release(gid)
    return np.stack(fields) if fields else None, geo, times


def sample(stack, geo, pts):
    """Bilineární výběr [n_steps, n_pts] pro cílové body z pravidelné mřížky."""
    n_steps = stack.shape[0]
    out = np.full((n_steps, len(pts)), np.nan, dtype=np.float32)
    Ni, Nj = geo["Ni"], geo["Nj"]
    for k, (la, lo) in enumerate(pts):
        fi = (lo - geo["lon0"]) / geo["di"]
        fj = (la - geo["lat0"]) / geo["dj"]
        i0, j0 = int(np.floor(fi)), int(np.floor(fj))
        if not (0 <= i0 < Ni - 1 and 0 <= j0 < Nj - 1):
            continue
        ti, tj = fi - i0, fj - j0
        v = (stack[:, j0, i0] * (1 - ti) * (1 - tj) + stack[:, j0, i0 + 1] * ti * (1 - tj)
             + stack[:, j0 + 1, i0] * (1 - ti) * tj + stack[:, j0 + 1, i0 + 1] * ti * tj)
        out[:, k] = v
    return out


def main():
    t_start = time.time()
    run = latest_run()
    if not run:
        print("aladin.py: žádný běh nenalezen — přeskakuji", file=sys.stderr)
        return
    run_iso = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc).isoformat()
    print(f"=== ALADIN/ČHMÚ běh {run_iso} ===")

    pts = build_targets()
    print(f"  cílových bodů nad ČR: {len(pts)}  (krok {GRID_STEP}°)")

    # Teplota (povinná)
    tg = download_grib(var_url(run, "CLSTEMPERATURE"))
    if tg is None:
        print("aladin.py: teplota se nestáhla — přeskakuji", file=sys.stderr)
        return
    tstack, geo, times = read_field_stack(tg, HOURS)
    if tstack is None:
        print("aladin.py: teplota bez zpráv — přeskakuji", file=sys.stderr)
        return
    temp_c = sample(tstack, geo, pts) - 273.15  # K → °C
    print(f"  teplota: {tstack.shape[0]} kroků, mřížka {geo['Ni']}×{geo['Nj']}")

    # Srážky (volitelné) — SURFPREC_TOTAL je kumulativní od začátku běhu → deakumuluj
    precip_h = None
    if time.time() - t_start < BUDGET_S:
        pg = download_grib(var_url(run, "SURFPREC_TOTAL"))
        if pg is not None:
            pstack, _, _ = read_field_stack(pg, tstack.shape[0])
            if pstack is not None:
                pc = sample(pstack, geo, pts)
                dif = np.diff(pc, axis=0, prepend=pc[:1])
                precip_h = np.clip(dif, 0, None)
                print(f"  srážky: {pstack.shape[0]} kroků (deakumulováno)")

    n_steps = tstack.shape[0]
    out = {
        "run_utc": run_iso,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "start_utc": times[0],
        "step_hours": 1,
        "n_hours": n_steps,
        "grid_step_deg": GRID_STEP,
        "pts": [list(p) for p in pts],
        "temp": {}, "precip": {},
    }
    for k in range(len(pts)):
        col = temp_c[:, k]
        if np.isnan(col).all():
            continue
        out["temp"][str(k)] = [round(float(v), 1) if not np.isnan(v) else None for v in col]
        if precip_h is not None:
            out["precip"][str(k)] = [round(float(v), 1) if not np.isnan(v) else None
                                     for v in precip_h[:, k]]

    path = DATA_DIR / "aladin.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    kb = path.stat().st_size / 1024
    # kontrolní bod: Praha
    pj = min(range(len(pts)), key=lambda i: abs(pts[i][0] - 50.09) + abs(pts[i][1] - 14.42))
    t0 = out["temp"].get(str(pj), [None])[0]
    print(f"✓ aladin.json — {len(out['temp'])} bodů, {n_steps} h, {kb:.0f} kB  "
          f"(Praha t0 ≈ {t0} °C)  [{time.time()-t_start:.1f}s]")


if __name__ == "__main__":
    main()
