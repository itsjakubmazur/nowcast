"""
Testy pro pipeline/chmi_fct.py a pipeline/echotop.py — parsování názvů,
geometrie okna a konzistence s verify.py.

Proč zrovna tohle: oba moduly indexují CIZÍ rastr našimi pixely. Když se
mřížky rozejdou, dostaneme čísla — jen ze špatného místa, bez jediné chyby
v logu. Testy proto hlídají hlavně ty tiché předpoklady.

Spouštění: python tests/test_chmi_fct.py
"""

import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# pysteps je těžká závislost (kompiluje se ze zdrojů) a nic z toho, co se tady
# testuje, ji nepotřebuje — chmi_fct si z nowcast.py bere jen konstanty a dvě
# čisté funkce. Odstíníme ji, ať jdou testy pustit i tam, kde není nainstalovaná.
if "pysteps" not in sys.modules:
    _stub = types.ModuleType("pysteps")
    _stub.motion = types.SimpleNamespace(get_method=lambda *a, **k: None)
    _stub.nowcasts = types.SimpleNamespace(get_method=lambda *a, **k: None)
    sys.modules["pysteps"] = _stub

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import chmi_fct  # noqa: E402
import echotop  # noqa: E402
import verify  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def main():
    print("=== chmi_fct — COTREC nowcast ČHMÚ ===")

    # --- parsování názvu tar ------------------------------------------------
    name = "T_PABV23_C_OKPR_20260726.2030.ft60s10.tar"
    base = chmi_fct.parse_base_time(name)
    check("báze běhu se přečte z názvu tar",
          base == datetime(2026, 7, 26, 20, 30, tzinfo=timezone.utc), str(base))
    check("regex chytí reálný název ze sondy",
          chmi_fct.TAR_RE.findall(f'href="{name}"') == [name])
    check("regex nechytí HDF ze sousední větve",
          chmi_fct.TAR_RE.findall('href="T_PABV23_C_OKPR_20260726203000.hdf"') == [])
    try:
        chmi_fct.parse_base_time("neco_uplne_jineho.tar")
        check("rozbitý název skončí výjimkou, ne tichým nesmyslem", False)
    except ValueError:
        check("rozbitý název skončí výjimkou, ne tichým nesmyslem", True)

    # --- členové tar --------------------------------------------------------
    member = "20260726.2030/T_PABV23_C_OKPR_20260726204000_ft10.hdf"
    hit = chmi_fct.MEMBER_RE.search(member)
    check("z cesty uvnitř tar se vytáhne čas platnosti i lead", hit is not None)
    if hit:
        check("lead = 10 min", int(hit.group(2)) == 10, hit.group(2))
        check("čas platnosti = 20:40 UTC",
              datetime.strptime(hit.group(1), "%Y%m%d%H%M%S")
              == datetime(2026, 7, 26, 20, 40), hit.group(1))
    check("adresářový člen tar se ignoruje",
          chmi_fct.MEMBER_RE.search("20260726.2030") is None)

    # --- okno musí sedět s verify.py ---------------------------------------
    # Kdyby se rozešly, hodnotil by se COTREC na jiném okně než naše
    # extrapolace a srovnání by nic neříkalo.
    check("BOX_RADIUS odpovídá verify.SAMPLE_RADIUS",
          chmi_fct.BOX_RADIUS == verify.SAMPLE_RADIUS,
          f"{chmi_fct.BOX_RADIUS} vs {verify.SAMPLE_RADIUS}")

    field = np.arange(378 * 598, dtype=np.float32).reshape(378, 598)
    box = chmi_fct.box_values(field, 100, 200)
    check("okno uprostřed rastru má 5×5 = 25 hodnot", len(box) == 25, str(len(box)))
    check("střed okna je hodnota pixelu", box[12] == field[100, 200], f"{box[12]}")
    edge = chmi_fct.box_values(field, 0, 0)
    check("okno v rohu se ořízne, nespadne", len(edge) == 9, str(len(edge)))
    nan_field = np.full((378, 598), np.nan, dtype=np.float32)
    check("NaN se v okně převede na nulu, ne na NaN",
          all(v == 0.0 for v in chmi_fct.box_values(nan_field, 50, 50)))

    # --- krok odpovídá našemu nowcastu -------------------------------------
    from nowcast import TIMESTEP_MIN
    check("krok COTREC (10 min) je stejný jako náš TIMESTEP_MIN",
          chmi_fct.STEP_MIN == TIMESTEP_MIN,
          f"{chmi_fct.STEP_MIN} vs {TIMESTEP_MIN}")

    print("\n=== echotop — hloubka konvekce ===")

    check("regex chytí reálný název snímku",
          echotop.FILE_RE.findall('href="T_PADV23_C_OKPR_20260726203000.hdf"')
          == ["T_PADV23_C_OKPR_20260726203000.hdf"])
    check("regex nechytí maxz (jiný prefix produktu)",
          echotop.FILE_RE.findall('href="T_PABV23_C_OKPR_20260726203000.hdf"') == [])

    # Prahy musí být sestupné, jinak by severity() vracela vždycky první.
    thresholds = [m for m, _ in echotop.SEVERITY_M]
    check("prahy závažnosti jsou seřazené sestupně",
          thresholds == sorted(thresholds, reverse=True), str(thresholds))
    cases = [(12000, "extrémní"), (11000, "extrémní"), (9500, "silná"),
             (8000, "silná"), (6000, "mírná"), (5000, "mírná"),
             (3000, "mělká"), (0, "mělká")]
    bad = [f"{m}→{echotop.severity(m)} (čekáno {exp})"
           for m, exp in cases if echotop.severity(m) != exp]
    check("výška vrcholu se mapuje na správnou závažnost", not bad, "; ".join(bad))

    # gain 100 znamená metry — kontrola, že jsme si nespletli jednotky
    check("prahy jsou v metrech, ne v kilometrech",
          max(thresholds) > 1000, str(max(thresholds)))

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy chmi_fct + echotop prošly")


if __name__ == "__main__":
    main()
