"""
Geomagnetická aktivita (Kp index) → data/aurora.json.

Proč to sem patří: polární záře je jediný jev na obloze, který se v ČR dá
předpovědět dopředu a přitom ho žádná běžná předpovědní appka neukazuje.
Vstup je přitom jediné číslo — planetární Kp index — které NOAA SWPC publikuje
zdarma, bez klíče a jako malý JSON.

DĚLBA PRÁCE (drží princip „fyzika počítá čísla"):
  - tady se jen STÁHNE a znormalizuje Kp řada (pozorovaná + předpověď),
  - ve `web/js/aurora.js` se z ní pro KONKRÉTNÍ místo spočítá geomagnetická
    šířka a hranice ovalu.
Kp je planetární veličina, stejná pro celý svět, takže nemá smysl ji počítat
per-lokace v pipeline — ta neví, kam se uživatel zrovna dívá.

ZDROJE (obojí veřejné, bez klíče, řádově jednotky kB):

  products/noaa-planetary-k-index-forecast.json
      Hlavní zdroj — minulost i tři dny dopředu v jednom souboru. Sloupec
      `observed` říká, co je co ("observed" / "estimated" / "predicted").

  products/noaa-planetary-k-index.json
      Záloha, jen pozorovaná minulost (~7 dní).

TVAR ODPOVĚDI SE NEHÁDÁ. První verze tohohle modulu vznikla bez odchozího
přístupu na NOAA a vzala tvar z dokumentace — pole polí, první řádek hlavička.
Sonda `probe_aurora.py` v CI ukázala, že to tak není, a modul na živých datech
padal. Skutečný tvar (ověřeno během 34157851723, 7. 9. 2026) je POLE SLOVNÍKŮ:

  forecast (81 řádků, ~10 dní):
    {"time_tag": "2026-08-31T00:00:00", "kp": 3.0,
     "observed": "observed", "noaa_scale": null}
    `observed` nabývá "observed" / "estimated" / "predicted".

  observed (62 řádků, ~8 dní zpět):
    {"time_tag": "2026-08-31T00:00:00", "Kp": 3.0,
     "a_running": 15, "station_count": 8}
    Pozor na `station_count` — je to jednociferné číslo hned vedle Kp, takže
    při čtení podle POŘADÍ by prošlo jako platná hodnota.

`normalize()` přesto bere oba tvary a sonda zůstává v CI jako hlídač: zdroj
se už jednou rozešel s dokumentací a nic neslibuje, že se nerozejde znovu.

Sloupce se v obou případech hledají PODLE JMÉNA, ne podle pořadí. Kdyby NOAA
přidala sloupec, posunuté indexy by tiše zaměnily Kp za něco jiného — a tiše
špatné číslo je horší než chybějící panel.

Kp má krok 3 hodiny a hodnoty v třetinách (2, 2⅓, 2⅔ …); NOAA je posílá jako
"2", "2.33" nebo občas "2P"/"2M" (přípona = předběžná/dopočtená). Parser proto
bere jen vedoucí číslo.

Výstup: data/aurora.json
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
TIMEOUT = (10, 30)

BASE = "https://services.swpc.noaa.gov/products"
URL_FORECAST = f"{BASE}/noaa-planetary-k-index-forecast.json"
URL_OBSERVED = f"{BASE}/noaa-planetary-k-index.json"

# Kolik minulosti si necháváme. Graf v UI ukazuje ±3 dny kolem teď, takže
# víc než tři dny zpátky je jen zbytečně velký soubor.
KEEP_PAST_H = 72

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})

# "2", "2.33", "2P", "2M", "2.67 " → 2.0 / 2.33 / 2.0 / 2.0 / 2.67
NUM_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)")


def kp_value(raw):
    """Vedoucí číslo z buňky, nebo None. Nečíselné buňky se zahazují tiše —
    NOAA v řadě běžně posílá prázdné sloty do budoucna."""
    if raw is None:
        return None
    m = NUM_RE.match(str(raw))
    if not m:
        return None
    v = float(m.group(1))
    # Kp je definované na 0–9. Cokoli mimo je chyba zdroje, ne extrémní bouře.
    return v if 0.0 <= v <= 9.0 else None


def parse_time(raw):
    """Čas z NOAA → VŽDY aware datetime v UTC, nebo None.

    To „vždy aware" je celá pointa. Živý zdroj posílá ISO bez značky zóny
    ('2026-08-31T00:00:00'), takže `fromisoformat` vrátí NAIVNÍ datum — a
    main() ho porovnává s `datetime.now(timezone.utc)`. Python takové
    porovnání neumí a shodí celý modul: TypeError „can't compare
    offset-naive and offset-aware datetimes".

    Chyba by přitom neshořela nahlas tam, kde vznikla: v pipeline je krok
    fail-soft, takže by se panel jen nikdy neukázal a v logu by zbyl jeden
    řádek. Časy z tohohle zdroje jsou v UTC, takže se zóna doplní.
    """
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(str(raw).strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(str(raw).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def columns(header, wanted):
    """Indexy sloupců podle jména hlavičky (case-insensitive).

    `wanted` je {výstupní_klíč: [možná jména]}. Vrací {klíč: index} jen pro
    ty, které se opravdu našly — volající si sám rozhodne, co je povinné.
    """
    lower = [str(h).strip().lower() for h in header]
    out = {}
    for key, names in wanted.items():
        for n in names:
            if n in lower:
                out[key] = lower.index(n)
                break
    return out


def fetch_rows(url):
    """Stáhne a vrátí syrový JSON. Tvar neřeší — od toho je normalize()."""
    r = SESSION.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def normalize(payload):
    """Cokoli, co NOAA pošle → seznam slovníků {sloupec: hodnota}.

    Sonda v CI (běh 34157627666) ukázala, že tvar odpovědi NEODPOVÍDÁ tomu,
    co popisuje dokumentace: `/products/...` nevrací pole polí s hlavičkou
    v prvním řádku. Tenhle převod proto bere OBA tvary a jméno sloupce je
    v obou případech to jediné, podle čeho se hodnota hledá:

      - pole polí, první řádek hlavička  → spáruje se s ní
      - pole slovníků                    → použije se rovnou

    Klíče se převádějí na malá písmena, ať `columns()` funguje stejně
    v obou větvích.
    """
    if not isinstance(payload, list) or not payload:
        raise ValueError(f"nečekaný tvar odpovědi ({type(payload).__name__}, "
                         f"délka {len(payload) if isinstance(payload, list) else '—'})")

    if isinstance(payload[0], dict):
        return [{str(k).strip().lower(): v for k, v in row.items()}
                for row in payload if isinstance(row, dict)]

    if isinstance(payload[0], list):
        if len(payload) < 2:
            raise ValueError("tabulka má jen hlavičku, žádná data")
        header = [str(h).strip().lower() for h in payload[0]]
        out = []
        for row in payload[1:]:
            if not isinstance(row, list):
                continue
            out.append({header[i]: row[i] for i in range(min(len(header), len(row)))})
        return out

    raise ValueError(f"řádky nejsou ani pole, ani slovníky "
                     f"({type(payload[0]).__name__})")


def series_from(url, wanted, default_kind):
    """Jedna NOAA tabulka → [{dt, kp, kind}], seřazeno, bez duplicit v čase."""
    rows = normalize(fetch_rows(url))
    if not rows:
        raise ValueError("odpověď neobsahuje žádné řádky")

    # Sloupce se hledají podle JMÉNA, ne podle pořadí — kdyby NOAA přidala
    # sloupec, posunuté indexy by tiše zaměnily Kp za něco jiného.
    idx = columns(list(rows[0].keys()), wanted)
    if "t" not in idx or "kp" not in idx:
        raise ValueError(f"řádek nemá čas nebo Kp: {sorted(rows[0].keys())}")
    klice = list(rows[0].keys())
    kt, kkp = klice[idx["t"]], klice[idx["kp"]]
    kkind = klice[idx["kind"]] if "kind" in idx else None

    out = {}
    for row in rows:
        t = parse_time(row.get(kt))
        kp = kp_value(row.get(kkp))
        if t is None or kp is None:
            continue
        kind = default_kind
        if kkind:
            k = str(row.get(kkind) or "").strip().lower()
            if k.startswith("pred"):
                kind = "predicted"
            elif k.startswith("est"):
                kind = "estimated"
            elif k.startswith("obs"):
                kind = "observed"
        out[t] = {"dt": t, "kp": round(kp, 2), "kind": kind}
    return [out[k] for k in sorted(out)]


def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=KEEP_PAST_H)

    merged = {}
    used = []

    # Předpovědní soubor jako první: nese minulost i budoucnost naráz.
    try:
        for p in series_from(
            URL_FORECAST,
            {"t": ["time_tag"], "kp": ["kp", "kp_index"], "kind": ["observed"]},
            "predicted",
        ):
            merged[p["dt"]] = p
        used.append("noaa-planetary-k-index-forecast")
    except Exception as e:  # noqa: BLE001 — zdroj je volitelný, panel smí chybět
        print(f"aurora.py: předpovědní řada selhala ({e})", file=sys.stderr)

    # Pozorovaná řada jen doplňuje minulost. Nepřepisuje to, co už máme
    # z předpovědního souboru — ten je autoritativnější v tom, co je
    # pozorované a co dopočtené.
    try:
        for p in series_from(
            URL_OBSERVED,
            {"t": ["time_tag"], "kp": ["kp", "kp_index"]},
            "observed",
        ):
            merged.setdefault(p["dt"], p)
        used.append("noaa-planetary-k-index")
    except Exception as e:  # noqa: BLE001
        print(f"aurora.py: pozorovaná řada selhala ({e})", file=sys.stderr)

    points = [p for dt, p in sorted(merged.items()) if dt >= cutoff]

    if not points:
        print("aurora.py: žádná Kp data — soubor nezapisuji", file=sys.stderr)
        return 1

    # „Teď" = poslední bod, který NENÍ předpověď. Když takový není (NOAA někdy
    # publikuje jen předpověď), zůstane prázdný a UI to řekne — radši chybějící
    # číslo než předpověď vydávaná za měření.
    past = [p for p in points if p["kind"] != "predicted" and p["dt"] <= now]
    current = past[-1] if past else None

    future = [p for p in points if p["dt"] > now]
    peak = max(future, key=lambda p: p["kp"]) if future else None

    def pub(p):
        return None if p is None else {
            "t": p["dt"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "kp": p["kp"],
            "kind": p["kind"],
        }

    series = [pub(p) for p in points]

    out = {
        "generated_at_utc": now.isoformat(),
        "source": "NOAA SWPC — planetární Kp index",
        "source_urls": [URL_FORECAST, URL_OBSERVED],
        "used": used,
        "caveat": (
            "Kp je planetární tříhodinový index geomagnetické aktivity, ne "
            "předpověď pro konkrétní místo. Říká, jak daleko na jih sahá "
            "polární oval — ne jestli je zrovna jasno."
        ),
        "cadence_h": 3,
        "now": pub(current),
        "peak_next": pub(peak),
        "series": series,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / "aurora.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    kp_now = current["kp"] if current else "—"
    print(
        f"aurora.py: {len(series)} bodů, Kp teď {kp_now}, "
        f"max vpřed {peak['kp'] if peak else '—'}, {path.stat().st_size / 1024:.1f} kB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
