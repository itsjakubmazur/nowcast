"""Sonda 8: ověření, že nová data ČHMÚ skutečně dorazila na nasazený web.

Kontroluje se to, co reálně uvidí prohlížeč, ne co proběhlo v pipeline —
soubor se může vyrobit a přesto se nedostat do deploye.
"""
import json
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 60)
PAGES = "https://itsjakubmazur.github.io/nowcast/data"

FILES = ["chmi_fct.json", "echotop.json", "chmi_normals.json", "chmi_air.json",
         "chmi_aero.json", "chmi_forecast.json", "chmi_regional.json",
         "forecast_grid.json", "accuracy.json"]


def main():
    print(f"Sonda 8 — {datetime.now(timezone.utc).isoformat()}\n")
    docs = {}
    for name in FILES:
        try:
            r = requests.get(f"{PAGES}/{name}", headers=UA, timeout=T)
            if not r.ok:
                print(f"  ✗ {name}: HTTP {r.status_code}")
                continue
            docs[name] = j = r.json()
            print(f"  ✓ {name}: {len(r.content) / 1024:.1f} kB")
        except Exception as e:
            print(f"  ✗ {name}: {str(e)[:120]}")

    grid = docs.get("forecast_grid.json") or {}

    print("\n=== COTREC ===")
    c = docs.get("chmi_fct.json")
    if c:
        print(f"  báze {c.get('base_utc')} (stáří {c.get('age_min')} min), "
              f"metoda {c.get('method')}, kroků {len(c.get('timeseries', []))}")
        print(f"  špička {c.get('peak_mm_h')} mm/h, příchod {c.get('arrival_utc')}")
        g = c.get("grid") or {}
        same = g.get("t0_utc") == grid.get("t0_utc")
        cnt = g.get("n_pts") == len(grid.get("pts", []))
        print(f"  mřížka: {len(g.get('series', {}))} bodů se srážkami z {g.get('n_pts')}")
        print(f"  párování s forecast_grid: t0 {'OK' if same else 'ROZEJITÉ'}, "
              f"počet bodů {'OK' if cnt else 'ROZEJITÝ'}")

    print("\n=== echotop ===")
    e = docs.get("echotop.json")
    if e:
        print(f"  pozorování {e.get('obs_utc')} (stáří {e.get('age_min')} min)")
        print(f"  max {e.get('max_m')} m ({e.get('max_severity')}), "
              f"p95 {e.get('p95_m')} m, pokrytí {e.get('coverage_pct')} %")
        print(f"  bodů s vrcholem: {len(e.get('tops_m', {}))} z {e.get('n_pts')}")
        print(f"  párování: {'OK' if e.get('grid_t0_utc') == grid.get('t0_utc') else 'ROZEJITÉ'}")

    print("\n=== normály ===")
    n = docs.get("chmi_normals.json")
    if n:
        st = n.get("stations", {})
        nat = [k for k in st if k.startswith("0-203-0")]
        print(f"  období {n.get('period')}, stanic {n.get('count')}, prvky {n.get('elements')}")
        print(f"  z toho národních (0-203-0): {len(nat)}")
        for k in list(st)[:2]:
            s = st[k]
            print(f"  {k} {s.get('name')} {s.get('lat')},{s.get('lon')} "
                  f"{s.get('elev')} m → {list(s.get('normals', {}))}")

    print("\n=== ovzduší ===")
    a = docs.get("chmi_air.json")
    if a:
        print(f"  stanic {a.get('count')}, látky {a.get('components')}, "
              f"stáří {a.get('age_min')} min")
        for s in a.get("stations", [])[:2]:
            print(f"  {s.get('name')} ({s.get('region')}): "
                  f"{ {k: v['val'] for k, v in (s.get('v') or {}).items()} } "
                  f"index={s.get('index')}")

    print("\n=== aerologie ===")
    ae = docs.get("chmi_aero.json")
    if ae:
        for s in ae.get("stations", []):
            print(f"  {s.get('name')}: CAPE {s.get('cape')} ({s.get('cape_label')}), "
                  f"CIN {s.get('cin')}, Tkonv {s.get('t_konv')}, "
                  f"VKH {s.get('lcl')}, KKH {s.get('ccl')}, stáří {s.get('age_h')} h")

    print("\n=== textová předpověď ===")
    f = docs.get("chmi_forecast.json")
    if f:
        print(f"  „{f.get('headline')}“ — {f.get('author')}, stáří {f.get('age_h')} h")
        for b in f.get("blocks", [])[:2]:
            print(f"  [{b.get('name')}] {(b.get('text') or '')[:150]}")

    print("\n=== krajské průměry ===")
    rg = docs.get("chmi_regional.json")
    if rg:
        print(f"  kraje: {[r['code'] for r in rg.get('regions', [])]}")
        for key in ("temp_annual", "temp_normal", "prec_annual", "temp_current"):
            v = rg.get(key)
            if v:
                print(f"  {key}: {len(v)} řádků, poslední {json.dumps(v[-1], ensure_ascii=False)[:120]}")

    print("\n=== srovnání přesnosti (COTREC vs. naše) ===")
    acc = docs.get("accuracy.json")
    if acc:
        print(f"  naše  10 min: {acc.get('leadtime_10min')}")
        cot = acc.get("cotrec")
        if cot:
            print(f"  COTREC 10 min: {cot.get('leadtime_10min')} (n_runs={cot.get('n_runs')})")
        else:
            print("  COTREC: zatím bez vyhodnocených záznamů "
                  "(pozorování pro čas platnosti musí teprve dorazit)")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
