"""
Sonda: publikuje NOAA SWPC Kp index v tom tvaru, se kterým počítá aurora.py?

Proč sonda existuje: aurora.py se psal v sandboxu BEZ odchozího přístupu na
services.swpc.noaa.gov, takže tvar odpovědi je odvozený z dokumentace, ne
ověřený na živých datech. To je přesně situace, kdy repo nesmí spoléhat na
„vypadá to správně" — claude.md to zakazuje výslovně („nehardcoduj názvy
z hlavy — ověř živě").

Sonda nic neimplementuje ani neopravuje. Vytiskne, co zdroj doopravdy vrací,
a zkontroluje ty čtyři předpoklady, na kterých parser stojí:
  1. odpověď je pole polí a první řádek je hlavička,
  2. hlavička obsahuje `time_tag` a `kp` (jinak by se sloupce nenašly),
  3. čas jde přečíst jako 'YYYY-MM-DD HH:MM:SS' v UTC,
  4. sloupec `observed` nese hodnoty observed/estimated/predicted.

Návratový kód je nenulový, když některý předpoklad padne — sonda se tak dá
pustit v CI jako hlídač, ne jen jako výpis k přečtení.

Spouštění: python pipeline/probe_aurora.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import aurora  # noqa: E402

URLS = [
    ("předpověď (hlavní zdroj)", aurora.URL_FORECAST, True),
    ("pozorovaná řada (záloha)", aurora.URL_OBSERVED, False),
]

PROBLEMS = []


def note(ok, msg):
    print(f"  {'✓' if ok else '✗'} {msg}")
    if not ok:
        PROBLEMS.append(msg)


def probe(label, url, expect_kind):
    print(f"=== {label} ===")
    print(f"  {url}")
    try:
        rows = aurora.fetch_rows(url)
    except Exception as e:  # noqa: BLE001 — sonda hlásí, nepadá
        note(False, f"stažení/tvar selhalo: {e}")
        return

    header = rows[0]
    print(f"  hlavička: {header}")
    print(f"  řádků:    {len(rows) - 1}")
    for r in rows[1:4]:
        print(f"    {r}")
    print("    …")
    for r in rows[-2:]:
        print(f"    {r}")

    idx = aurora.columns(header, {
        "t": ["time_tag"], "kp": ["kp", "kp_index"], "kind": ["observed"],
    })
    note("t" in idx, f"hlavička má čas (time_tag) → index {idx.get('t')}")
    note("kp" in idx, f"hlavička má Kp → index {idx.get('kp')}")
    if expect_kind:
        note("kind" in idx, f"hlavička má sloupec typu (observed) → index {idx.get('kind')}")

    if "t" not in idx or "kp" not in idx:
        return

    body = [r for r in rows[1:] if isinstance(r, list) and len(r) > max(idx.values())]
    times = [aurora.parse_time(r[idx["t"]]) for r in body]
    kps = [aurora.kp_value(r[idx["kp"]]) for r in body]
    note(sum(t is not None for t in times) > len(body) * 0.9,
         f"čas jde přečíst u {sum(t is not None for t in times)}/{len(body)} řádků")
    note(sum(k is not None for k in kps) > len(body) * 0.5,
         f"Kp jde přečíst u {sum(k is not None for k in kps)}/{len(body)} řádků")

    good = [k for k in kps if k is not None]
    if good:
        print(f"  Kp rozsah: {min(good)} – {max(good)}")
        note(max(good) <= 9.0, f"nejvyšší Kp {max(good)} je v oboru 0–9")

    ts = [t for t in times if t]
    if len(ts) > 2:
        steps = {round((b - a).total_seconds() / 3600, 2)
                 for a, b in zip(sorted(ts), sorted(ts)[1:])}
        print(f"  krok (h): {sorted(steps)}")
        note(3.0 in steps, "krok řady je 3 h (aurora.py to hlásí jako cadence_h)")

    if expect_kind and "kind" in idx:
        kinds = {str(r[idx["kind"]]).strip().lower() for r in body}
        print(f"  hodnoty sloupce typu: {sorted(kinds)}")
        known = {k for k in kinds if k.startswith(("obs", "est", "pred"))}
        note(bool(known), f"typ se dá rozpoznat u {len(known)} z {len(kinds)} hodnot")


def main():
    for label, url, expect_kind in URLS:
        probe(label, url, expect_kind)
        print()

    if PROBLEMS:
        print(f"❌ {len(PROBLEMS)} předpokladů neplatí — aurora.py potřebuje úpravu:")
        for p in PROBLEMS:
            print(f"   - {p}")
        return 1
    print("✅ zdroj odpovídá tomu, s čím aurora.py počítá")
    return 0


if __name__ == "__main__":
    sys.exit(main())
