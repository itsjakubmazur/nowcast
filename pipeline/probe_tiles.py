"""
Sonda: opravdu jsou na webu ty světové dlaždice, které slibuje rejstřík?

Vznikla ze stížnosti "dřív jsem tam měl hromady teplotních čidel po celém
světě, teď tam toto moc není". Podezření padlo na carry_over.py: ten při
fast běhu doplňuje soubory, které běh nevyrobil, a u dlaždic četl rejstřík
jako pole řetězců, přestože metar.py do něj zapisuje objekty
{"tile": "9_18", "count": 42}. URL pak vycházela ze str(dict) a každý
požadavek skončil 404 — přeneslo se tedy jen index.json a nula dlaždic.

Klient rejstříku věří (gate proti zbytečným 404), takže po takovém běhu
sice "ví" o 300 dlaždicích, ale žádnou nedostane a vrstva teplot je prázdná.

Sonda tedy netestuje kód, ale VÝSLEDEK na Pages: kolik dlaždic rejstřík
slibuje, kolik jich reálně vrací 200, a kolik je v nich stanic. K tomu
stav vlastních WU stanic a jejich historie, protože to je druhá půlka
téhož dotazu.
"""

import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# urllib, ne requests — sonda běží v probe-live.yml, kde se pipeline/
# requirements.txt neinstaluje (je to jen prohlížeč + pár skriptů).
PAGES = "https://itsjakubmazur.github.io/nowcast/data"
TIMEOUT = 30
SAMPLE = 40          # kolik dlaždic ověřit doopravdy (ne všech ~300)


def get(path):
    req = urllib.request.Request(f"{PAGES}/{path}",
                                 headers={"User-Agent": "nowcast-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return None, str(e)[:120]


def probe_tiles():
    print("\n== SVĚTOVÉ DLAŽDICE (METAR + bóje + národní sítě) ==")
    code, idx = get("metar/index.json")
    if code != 200 or not isinstance(idx, dict):
        print(f"  index.json: HTTP {code} — vrstva teplot NEMÁ z čeho čerpat")
        return
    tiles = idx.get("tiles") or []
    print(f"  index.json: HTTP 200, generováno {idx.get('generated_at_utc')}")
    print(f"  slibuje {len(tiles)} dlaždic, dohromady {idx.get('stations')} stanic")

    # Rejstřík je pole objektů {"tile","count"} — přesně to, na čem se
    # carry_over.py spálil, když to četl jako řetězce.
    ids = [t.get("tile") if isinstance(t, dict) else t for t in tiles]
    ids = [i for i in ids if i]
    step = max(1, len(ids) // SAMPLE)
    sample = ids[::step][:SAMPLE]

    def check(tid):
        c, doc = get(f"metar/{tid}.json")
        n = len(doc.get("stations") or []) if isinstance(doc, dict) else 0
        return tid, c, n

    with ThreadPoolExecutor(max_workers=8) as ex:
        res = list(ex.map(check, sample))

    ok = [r for r in res if r[1] == 200]
    miss = [r for r in res if r[1] != 200]
    stanic = sum(r[2] for r in ok)
    print(f"  vzorek {len(sample)} dlaždic: {len(ok)}× 200, {len(miss)}× chyba")
    print(f"  stanic ve vzorku: {stanic}")
    if miss:
        print(f"  CHYBĚJÍ (prvních 8): {[(m[0], m[1]) for m in miss[:8]]}")
        print("  → rejstřík slibuje dlaždice, které na webu nejsou."
              " Přesně to dělá rozbitý carry_over.")
    elif stanic == 0:
        print("  → dlaždice jsou, ale prázdné.")
    else:
        print("  → vrstva teplot má z čeho čerpat.")


def probe_stations():
    print("\n== STANICE ==")
    for name, key in [("metar_stations.json", "stations"),
                      ("euro_stations.json", "stations"),
                      ("chmi_stations.json", "stations"),
                      ("wu_stations.json", "stations")]:
        code, doc = get(name)
        if code != 200 or not isinstance(doc, dict):
            print(f"  {name}: HTTP {code}")
            continue
        st = doc.get(key) or []
        extra = ""
        if name == "wu_stations.json":
            own = [s for s in st if s.get("own")]
            extra = f", z toho vlastních {len(own)}: {[s.get('id') for s in own]}"
        print(f"  {name}: {len(st)} stanic (generováno {doc.get('generated_at_utc')}){extra}")


def probe_history():
    print("\n== HISTORIE ==")
    for name in ["wu_history.json", "metar_history.json", "chmi_series_index.json",
                 "chmi_stats.json"]:
        code, doc = get(name)
        if code != 200:
            print(f"  {name}: HTTP {code} — NEEXISTUJE")
            continue
        if not isinstance(doc, dict):
            print(f"  {name}: HTTP 200, ale není objekt")
            continue
        # Struktura se liší modul od modulu — vypiš, co v něm je.
        keys = [k for k in doc.keys() if k not in ("generated_at_utc",)]
        detail = ""
        for k in keys:
            v = doc[k]
            if isinstance(v, dict):
                detail += f" {k}={len(v)} klíčů"
                if v:
                    first = next(iter(v.items()))
                    n = len(first[1]) if isinstance(first[1], (list, dict)) else "?"
                    detail += f" (např. {first[0]}: {n} záznamů)"
            elif isinstance(v, list):
                detail += f" {k}=[{len(v)}]"
        print(f"  {name}: HTTP 200, generováno {doc.get('generated_at_utc')},{detail}")


def main():
    probe_tiles()
    probe_stations()
    probe_history()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"probe_tiles selhalo: {e}", file=sys.stderr)
        sys.exit(1)
