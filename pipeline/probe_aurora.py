"""
Sonda: publikuje NOAA SWPC Kp index v tom tvaru, se kterým počítá aurora.py?

Proč sonda existuje: aurora.py se psal v sandboxu BEZ odchozího přístupu na
services.swpc.noaa.gov, takže tvar odpovědi je odvozený z dokumentace, ne
ověřený na živých datech. To je přesně situace, kdy repo nesmí spoléhat na
„vypadá to správně" — claude.md to zakazuje výslovně („nehardcoduj názvy
z hlavy — ověř živě").

Sonda nic neimplementuje ani neopravuje. Nejdřív VYPÍŠE, co zdroj doopravdy
vrací (typ, délka, klíče, ukázkové řádky), a teprve pak kontroluje předpoklady:
  1. odpověď jde převést na řádky (`normalize` — pole polí i pole slovníků),
  2. řádky nesou `time_tag` a `kp`/`kp_index`,
  3. čas jde přečíst jako UTC,
  4. sloupec `observed` nese hodnoty observed/estimated/predicted,
  5. krok řady je tři hodiny.

Výpis je tu proto, že jeho absence sondu poprvé připravila o půl užitku:
spadla na tvaru a řekla jen „nečekaný tvar odpovědi (list)" — tedy že to
nesedí, ale ne CO tam je.

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


def dump_raw(payload):
    """Vypíše, co doopravdy přišlo — nezávisle na tom, jestli to umíme přečíst.

    První verze sondy tohle NEDĚLALA: volala rovnou parser, a když ten na tvaru
    spadl, zbyla hláška „nečekaný tvar odpovědi (list)" a nic víc. Sonda, která
    umí říct jen „nesedí to", ale neumí říct CO tam je, si o polovinu práce
    neřekla — a přesně kvůli téhle otázce existuje.
    """
    print(f"  typ:      {type(payload).__name__}")
    if isinstance(payload, dict):
        print(f"  klíče:    {sorted(payload.keys())[:20]}")
        return
    if not isinstance(payload, list):
        print(f"  hodnota:  {str(payload)[:300]}")
        return
    print(f"  délka:    {len(payload)}")
    if not payload:
        return
    print(f"  typ prvku: {type(payload[0]).__name__}")
    if isinstance(payload[0], dict):
        print(f"  klíče:    {sorted(payload[0].keys())}")
    for i, row in enumerate(payload[:3]):
        print(f"    [{i}] {str(row)[:300]}")
    if len(payload) > 4:
        print("    …")
        print(f"    [{len(payload) - 1}] {str(payload[-1])[:300]}")


def probe(label, url, expect_kind):
    print(f"=== {label} ===")
    print(f"  {url}")
    try:
        payload = aurora.fetch_rows(url)
    except Exception as e:  # noqa: BLE001 — sonda hlásí, nepadá
        note(False, f"stažení selhalo: {e}")
        return

    dump_raw(payload)

    try:
        rows = aurora.normalize(payload)
    except Exception as e:  # noqa: BLE001
        note(False, f"převod na řádky selhal: {e}")
        return
    note(True, f"tvar se dá převést na řádky ({len(rows)} řádků)")

    if not rows:
        note(False, "po převodu nezbyl žádný řádek")
        return

    klice = list(rows[0].keys())
    print(f"  sloupce:  {klice}")

    idx = aurora.columns(klice, {
        "t": ["time_tag"], "kp": ["kp", "kp_index"], "kind": ["observed"],
    })
    note("t" in idx, f"našel se sloupec času (time_tag) → {idx.get('t')}")
    note("kp" in idx, f"našel se sloupec Kp → {idx.get('kp')}")
    if expect_kind:
        note("kind" in idx, f"našel se sloupec typu (observed) → {idx.get('kind')}")

    if "t" not in idx or "kp" not in idx:
        return

    kt, kkp = klice[idx["t"]], klice[idx["kp"]]
    times = [aurora.parse_time(r.get(kt)) for r in rows]
    kps = [aurora.kp_value(r.get(kkp)) for r in rows]
    note(sum(t is not None for t in times) > len(rows) * 0.9,
         f"čas jde přečíst u {sum(t is not None for t in times)}/{len(rows)} řádků")
    note(sum(k is not None for k in kps) > len(rows) * 0.5,
         f"Kp jde přečíst u {sum(k is not None for k in kps)}/{len(rows)} řádků")

    good = [k for k in kps if k is not None]
    if good:
        print(f"  Kp rozsah: {min(good)} – {max(good)}")

    ts = sorted(t for t in times if t)
    if len(ts) > 2:
        steps = {round((b - a).total_seconds() / 3600, 2) for a, b in zip(ts, ts[1:])}
        print(f"  krok (h): {sorted(steps)[:6]}")
        note(3.0 in steps, "krok řady je 3 h (aurora.py to hlásí jako cadence_h)")
        print(f"  rozsah:   {ts[0].isoformat()} → {ts[-1].isoformat()}")

    if expect_kind and "kind" in idx:
        kkind = klice[idx["kind"]]
        kinds = {str(r.get(kkind)).strip().lower() for r in rows}
        print(f"  hodnoty sloupce typu: {sorted(kinds)[:10]}")
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
