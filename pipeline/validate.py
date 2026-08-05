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
    summarize()


def summarize():
    """
    Jednořádkový soupis toho, co se právě publikuje.

    Vzniklo z praktické potřeby: kroky pipeline píšou své počty rozeseté po
    celém logu a některé selžou tiše (nechají starý soubor a tváří se jako
    úspěch). Tenhle řádek je poslední před uploadem, takže stačí kouknout na
    konec logu a je vidět, co je opravdu v datech.
    """
    parts = []
    for name, key in (("chmi_stations.json", "stations"),
                      ("metar_stations.json", "stations"),
                      ("euro_stations.json", "stations"),
                      ("chmi_rain.json", "stations"),
                      ("wu_stations.json", "stations")):
        try:
            d = json.loads((DATA_DIR / name).read_text())
            parts.append(f"{name.replace('_stations.json', '').replace('.json', '')}={len(d.get(key) or [])}")
        except Exception:
            parts.append(f"{name.split('.')[0]}=—")
    try:
        idx = json.loads((DATA_DIR / "metar" / "index.json").read_text())
        parts.append(f"svět={idx.get('stations')}")
    except Exception:
        parts.append("svět=—")
    try:
        eu = json.loads((DATA_DIR / "euro_stations.json").read_text()).get("stations") or []
        by = {}
        for st in eu:
            by[st.get("country")] = by.get(st.get("country"), 0) + 1
        if by:
            parts.append("sousedé[" + " ".join(f"{k}:{v}" for k, v in sorted(by.items())) + "]")
    except Exception:
        pass

    # Historie a rekordy — tyhle se plní postupně (crawler má rozpočet na běh
    # a mezi běhy pokračuje), takže bez čísla v logu není poznat, jestli
    # postupují, nebo se každý běh restartují od nuly.
    try:
        idx = json.loads((DATA_DIR / "chmi_series_index.json").read_text())
        n_dir = len(list((DATA_DIR / "chmi_series").glob("*.json")))
        parts.append(f"řady={len(idx.get('stations') or {})}/{n_dir} souborů")
    except Exception:
        parts.append("řady=—")
    try:
        h = list((DATA_DIR / "chmi_history").glob("*.json"))
        kb = sum(p.stat().st_size for p in h) // 1024
        parts.append(f"historie={max(0, len(h) - 1)} stanic/{kb} kB")
    except Exception:
        parts.append("historie=—")
    try:
        st = json.loads((DATA_DIR / "chmi_stats.json").read_text()).get("stations") or {}
        s_rec = sum(1 for v in st.values() if v.get("records"))
        parts.append(f"rekordy={s_rec}/{len(st)}")
    except Exception:
        parts.append("rekordy=—")
    try:
        wh = json.loads((DATA_DIR / "wu_history.json").read_text()).get("stations") or {}
        tot = sum(len(v.get("series") or []) for v in wh.values())
        own = sum(len(v.get("series") or []) for v in wh.values() if v.get("own"))
        parts.append(f"wu_historie={tot} zázn. (vlastní {own})")
    except Exception:
        parts.append("wu_historie=—")

    print("  publikuje se: " + ", ".join(parts))


if __name__ == "__main__":
    main()
