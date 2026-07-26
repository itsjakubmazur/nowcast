"""
ČHMÚ COTREC nowcast — nezávislý druhý extrapolační běh vedle našeho pysteps.

ČHMÚ publikuje vlastní extrapolaci každých 5 minut do composite/fct_maxz/hdf5/
jako tar se šesti ODIM HDF5 soubory (ft10…ft60, krok 10 min, dosah 1 h).

Ověřeno sondou (běh 30219188301): mřížka fct_maxz je bit za bitem stejná jako
composite/maxz, který už čteme v ingest.py — 598×378, projdef merc,
xscale=yscale=1555.7, gain 0.5 / offset -32 / nodata 255 / quantity DBZH.
Proto tu není ani řádek reprojekce: read_odim_dbz() i latlon_to_pixel() platí
beze změny a pixel z gridjoin.py ukazuje na tentýž bod.

/how/comment u těch souborů říká "Extrapolation forecast based on COTREC
method". COTREC je jiný algoritmus než náš lucaskanade z pysteps, takže tohle
není duplicita, ale nezávislý druhý názor: shoda = důvěra, rozptyl = nejistota.

Vedle výstupu pro web ukládá i predikce k pozdější verifikaci — COTREC nelze
ověřit přehráním na zadrženém úseku jako naši extrapolaci (je to publikovaná
předpověď, ne něco, co si počítáme sami), takže se musí porovnat s pozorováním,
které dorazí až za hodinu. To dělá verify.py.

Výstup: data/chmi_fct.json + pipeline/state/cotrec_pending.json
"""

import io
import json
import os
import re
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, DEFAULT_LAT, DEFAULT_LON, read_odim_dbz
from nowcast import RAIN_THRESHOLD_MM_H, dbz_to_rainrate, latlon_to_pixel
from gridjoin import aligned_points, load_grid_json, load_radar_meta

BASE = ("https://opendata.chmi.cz/meteorology/weather/radar/composite/"
        "fct_maxz/hdf5/")
TAR_RE = re.compile(r'href="(T_PABV23_C_OKPR_\d{8}\.\d{4}\.ft\d+s\d+\.tar)"')
MEMBER_RE = re.compile(r"_(\d{14})_ft(\d+)\.hdf$")

TIMEOUT = (10, 60)
MAX_AGE_MIN = 25    # starší běh nemá smysl míchat s naší čerstvou extrapolací
STEP_MIN = 10       # ft10…ft60 → stejný krok jako náš TIMESTEP_MIN

STATE_DIR = Path(__file__).parent / "state"
PENDING_PATH = STATE_DIR / "cotrec_pending.json"
PENDING_MAX = 400   # strop, ať soubor neroste donekonečna při výpadku verify

# Musí se rovnat verify.SAMPLE_RADIUS, jinak by se COTREC hodnotil na jiném
# okně než naše extrapolace a čísla by nešlo porovnat. Hlídá to test.
BOX_RADIUS = 2

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def latest_tar_name() -> str | None:
    r = SESSION.get(BASE, timeout=TIMEOUT)
    r.raise_for_status()
    names = sorted(set(TAR_RE.findall(r.text)))
    return names[-1] if names else None


def parse_base_time(tar_name: str) -> datetime:
    """T_PABV23_C_OKPR_20260726.2030.ft60s10.tar → 2026-07-26 20:30 UTC."""
    m = re.search(r"_(\d{8})\.(\d{4})\.", tar_name)
    if not m:
        raise ValueError(f"nečekaný název souboru: {tar_name}")
    return (datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M")
            .replace(tzinfo=timezone.utc))


def load_fields(tar_bytes: bytes) -> list[tuple[int, datetime, np.ndarray]]:
    """Vrátí [(lead_min, valid_utc, rain_rate mm/h)] seřazené podle lead_min."""
    out = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        for m in tf.getmembers():
            hit = MEMBER_RE.search(m.name)
            if not hit:
                continue
            valid = (datetime.strptime(hit.group(1), "%Y%m%d%H%M%S")
                     .replace(tzinfo=timezone.utc))
            member = tf.extractfile(m)
            if member is None:
                continue
            # h5py umí file-like objekt, takže nic nemusí na disk
            dbz, _ = read_odim_dbz(io.BytesIO(member.read()))
            out.append((int(hit.group(2)), valid, dbz_to_rainrate(dbz)))
    out.sort(key=lambda t: t[0])
    return out


def box_values(field: np.ndarray, row: int, col: int) -> list[float]:
    """Hodnoty v okně ±BOX_RADIUS kolem pixelu, zploštěné — stejné okno,
    jaké verify.py používá pro naši extrapolaci."""
    nrows, ncols = field.shape
    win = field[max(0, row - BOX_RADIUS): min(nrows, row + BOX_RADIUS + 1),
                max(0, col - BOX_RADIUS): min(ncols, col + BOX_RADIUS + 1)]
    return [round(float(v), 3) for v in np.nan_to_num(win, nan=0.0).ravel()]


def save_pending(base_utc: datetime, entries: list[dict]) -> None:
    """
    Zapíše predikce pro domácí okno k pozdějšímu vyhodnocení ve verify.py.

    Ukládá se celé okno, ne jen střed: verify.py počítá MAE a shodu přes
    5×5 pixelů, takže bod proti boxu by byla jiná metrika a srovnání
    "naše pysteps vs. COTREC" by nic neříkalo.

    Selhání tady nesmí shodit hlavní výstup — je to jen sběr statistiky.
    """
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        pending = []
        if PENDING_PATH.exists():
            try:
                pending = json.loads(PENDING_PATH.read_text())
            except Exception:
                pending = []
        have = {(p.get("base_utc"), p.get("lead_min")) for p in pending}
        base_iso = base_utc.isoformat()
        for e in entries:
            if (base_iso, e["lead_min"]) in have:
                continue
            pending.append({"base_utc": base_iso, **e})
        pending.sort(key=lambda p: (p.get("valid_utc", ""), p.get("lead_min", 0)))
        PENDING_PATH.write_text(json.dumps(pending[-PENDING_MAX:], ensure_ascii=False))
    except Exception as e:
        print(f"chmi_fct.py: pending se neuložil ({e}) — pokračuji", file=sys.stderr)


def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    meta = load_radar_meta()
    if meta is None:
        print("chmi_fct.py: radar_meta.json chybí — spusť nejdřív ingest.py",
              file=sys.stderr)
        return

    try:
        name = latest_tar_name()
        if not name:
            raise RuntimeError("v listingu fct_maxz není žádný .tar")
        base_utc = parse_base_time(name)
        age_min = (datetime.now(timezone.utc) - base_utc).total_seconds() / 60
        if age_min > MAX_AGE_MIN:
            raise RuntimeError(f"nejnovější běh je {age_min:.0f} min starý "
                               f"(limit {MAX_AGE_MIN})")
        r = SESSION.get(BASE + name, timeout=TIMEOUT)
        r.raise_for_status()
        fields = load_fields(r.content)
        if not fields:
            raise RuntimeError("tar neobsahuje žádný ft*.hdf")
    except Exception as e:
        print(f"chmi_fct.py: {e} — vynechávám", file=sys.stderr)
        return

    # Pojistka proti tichému rozjetí: kdyby ČHMÚ někdy změnilo mřížku fct
    # produktu, indexovali bychom do jiného rastru a dostali nesmyslná čísla
    # BEZ jediné chyby v logu. Radši to tady skončí nahlas.
    if tuple(fields[0][2].shape) != tuple(meta["shape"]):
        print(f"chmi_fct.py: tvar {fields[0][2].shape} ≠ maxz {meta['shape']} — "
              "ČHMÚ změnilo mřížku, vynechávám", file=sys.stderr)
        return

    row, col = latlon_to_pixel(lat, lon, meta)
    series = [{"time_utc": v.isoformat(), "lead_min": lead,
               "mm_h": round(float(np.nan_to_num(rr[row, col])), 3)}
              for lead, v, rr in fields]
    vals = [s["mm_h"] for s in series]

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_utc": base_utc.isoformat(),
        "age_min": round(age_min, 1),
        "source": "ČHMÚ COTREC (composite/fct_maxz)",
        "method": "COTREC",
        "step_min": STEP_MIN,
        "horizon_h": round(len(fields) * STEP_MIN / 60, 2),
        "pixel": {"row": row, "col": col},
        "threshold_mm_h": RAIN_THRESHOLD_MM_H,
        "arrival_utc": next((s["time_utc"] for s in series
                             if s["mm_h"] >= RAIN_THRESHOLD_MM_H), None),
        "peak_mm_h": round(max(vals), 2) if vals else 0.0,
        "total_mm": round(sum(vals) * (STEP_MIN / 60), 2),
        "timeseries": series,
    }

    # Mřížka: napojíme se na body, které spočítal grid.py. POZOR — v
    # forecast_grid.json je pts = [[lat, lon], ...], ne [row, col]; pixely
    # proto přepočítá gridjoin.py toutéž funkcí jako grid.py.
    grid_json = load_grid_json()
    if grid_json:
        rebuilt = aligned_points(meta, grid_json)
        if rebuilt:
            cot = {}
            for i, (r_, c_, _lat, _lon) in enumerate(rebuilt):
                v = [round(float(np.nan_to_num(rr[r_, c_])), 1) for _, _, rr in fields]
                if max(v) >= RAIN_THRESHOLD_MM_H:
                    cot[str(i)] = v
            out["grid"] = {
                "t0_utc": grid_json.get("t0_utc"),   # klient ověří, že patří k sobě
                "n_pts": len(rebuilt),
                "step_min": STEP_MIN,
                "series": cot,
            }
            print(f"  mřížka: {len(cot)}/{len(rebuilt)} bodů se srážkami")

    path = DATA_DIR / "chmi_fct.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    save_pending(base_utc, [
        {"valid_utc": v.isoformat(), "lead_min": lead,
         "pred_box": box_values(rr, row, col)}
        for lead, v, rr in fields
    ])
    print(f"chmi_fct.py: {len(fields)} kroků, báze {base_utc:%H:%M} UTC "
          f"({age_min:.0f} min), špička {out['peak_mm_h']} mm/h, "
          f"{path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
