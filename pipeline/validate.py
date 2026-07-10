"""
Validace publikovaných JSON výstupů pipeline — poslední pojistka před deployem.

Kontroluje jen TVAR a rozumnost dat (ne přesnost predikce — na to je verify.py),
aby regrese ve formátu (např. přejmenované pole) spadla tady, ne až ve frontendu
uživatele. Kritické soubory (radar, grid) → exit(1) a deploy se zastaví.
Volitelné soubory (WU, ČHMÚ, accuracy) jen varují — nejsou nutné k základnímu
běhu webu.
"""

import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"

errors: list[str] = []
warnings: list[str] = []


def _load(name: str):
    p = DATA_DIR / name
    if not p.exists():
        return None, f"{name}: soubor neexistuje"
    try:
        return json.loads(p.read_text()), None
    except Exception as e:
        return None, f"{name}: neplatný JSON — {e}"


def check_manifest():
    data, err = _load("radar_manifest.json")
    if err:
        errors.append(err)
        return
    frames = data.get("frames", [])
    if not frames:
        errors.append("radar_manifest.json: 'frames' je prázdné")
        return
    t0i = data.get("t0_index")
    if not isinstance(t0i, int) or not (0 <= t0i < len(frames)):
        errors.append(f"radar_manifest.json: t0_index={t0i} mimo rozsah frames (len={len(frames)})")
    bounds = data.get("bounds")
    if not (isinstance(bounds, list) and len(bounds) == 2
            and all(isinstance(b, list) and len(b) == 2 for b in bounds)):
        errors.append("radar_manifest.json: 'bounds' má neočekávaný tvar")
    for f in frames:
        if "file" not in f or "time_utc" not in f:
            errors.append("radar_manifest.json: snímek bez 'file'/'time_utc'")
            break
        if not (DATA_DIR / "radar_frames" / f["file"]).exists():
            errors.append(f"radar_manifest.json: chybí PNG soubor {f['file']}")
            break


def check_grid():
    data, err = _load("forecast_grid.json")
    if err:
        errors.append(err)
        return
    pts = data.get("pts", [])
    if not pts:
        errors.append("forecast_grid.json: 'pts' je prázdné — grid.py selhal?")
        return
    act = data.get("act", {})
    for idx in list(act.keys())[:50]:
        try:
            i = int(idx)
        except ValueError:
            errors.append(f"forecast_grid.json: act klíč '{idx}' není číslo")
            break
        if not (0 <= i < len(pts)):
            errors.append(f"forecast_grid.json: act obsahuje index {i} mimo pts (len={len(pts)})")
            break
    nwp = data.get("nwp", {})
    if not nwp.get("pts"):
        warnings.append("forecast_grid.json: NWP body chybí (Open-Meteo nedostupné?)")
    for w in data.get("warnings", []):
        for key in ("event", "color", "onset_utc", "expires_utc"):
            if key not in w:
                errors.append(f"forecast_grid.json: výstraha bez klíče '{key}'")
                break


def check_forecast():
    data, err = _load("forecast.json")
    if err:
        warnings.append(err)
        return
    if not data.get("timeseries"):
        warnings.append("forecast.json: 'timeseries' je prázdné")


def check_optional(name: str, required_keys: tuple = ()):
    data, err = _load(name)
    if err:
        warnings.append(err)
        return
    for key in required_keys:
        if key not in data:
            warnings.append(f"{name}: chybí klíč '{key}'")


def main():
    check_manifest()
    check_grid()
    check_forecast()
    check_optional("chmi_stations.json", ("stations",))
    check_optional("wu_stations.json", ("stations",))
    check_optional("accuracy.json")

    if warnings:
        print("⚠ Varování (nekritické):")
        for w in warnings:
            print(f"  - {w}")

    if errors:
        print("✗ CHYBY (kritické):")
        for e in errors:
            print(f"  - {e}")
        print(f"\nvalidate.py: {len(errors)} kritických chyb — deploy se zastavuje.")
        sys.exit(1)

    print(f"✓ validate.py OK ({len(warnings)} nekritických varování)")


if __name__ == "__main__":
    main()
