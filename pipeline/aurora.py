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
      Hlavní zdroj. Pole polí, PRVNÍ ŘÁDEK JE HLAVIČKA:
        ["time_tag","kp","observed","noaa_scale"]
        ["2026-09-05 00:00:00","2","observed",null]
        ["2026-09-08 21:00:00","5","predicted","G1"]
      V jednom souboru je tedy minulost i tři dny dopředu — a sloupec
      `observed` říká, co je co ("observed" / "estimated" / "predicted").

  products/noaa-planetary-k-index.json
      Záloha, jen pozorovaná minulost (~7 dní):
        ["time_tag","Kp","a_running","station_count"]

Sloupce se hledají PODLE JMÉNA v hlavičce, ne podle pořadí. Kdyby NOAA přidala
sloupec, posunuté indexy by tiše zaměnily Kp za něco jiného — a tiše špatné
číslo je horší než chybějící panel.

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
    """NOAA posílá 'YYYY-MM-DD HH:MM:SS' v UTC, bez značky zóny."""
    try:
        return datetime.strptime(str(raw).strip(), "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None


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
    r = SESSION.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    rows = r.json()
    if not isinstance(rows, list) or len(rows) < 2 or not isinstance(rows[0], list):
        raise ValueError(f"nečekaný tvar odpovědi ({type(rows).__name__})")
    return rows


def series_from(url, wanted, default_kind):
    """Jedna NOAA tabulka → [{t, kp, kind}], seřazeno, bez duplicit v čase."""
    rows = fetch_rows(url)
    idx = columns(rows[0], wanted)
    if "t" not in idx or "kp" not in idx:
        raise ValueError(f"hlavička nemá čas nebo Kp: {rows[0]}")

    out = {}
    for row in rows[1:]:
        if not isinstance(row, list) or len(row) <= max(idx.values()):
            continue
        t = parse_time(row[idx["t"]])
        kp = kp_value(row[idx["kp"]])
        if t is None or kp is None:
            continue
        kind = default_kind
        if "kind" in idx:
            k = str(row[idx["kind"]] or "").strip().lower()
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
