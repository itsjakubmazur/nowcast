"""
Krajské (areálové) průměry teploty a srážek 1961→současnost + normály.

Dá appce dlouhou klimatickou řadu pro kraj uživatele: "letošní červenec je
o 2,1 °C nad normálem 1991–2020" s reálnou řadou za 65 let pod tím.

Ověřeno sondou (běh 30219708883):
  products/regional_averages/temperature/Annual_areal_temperature_mean.csv
  products/regional_averages/temperature/Monthly_areal_temperature_mean.csv
  products/regional_averages/temperature/Monthly_areal_temperature_mean_2026.csv
  products/regional_averages/temperature/Normal_1991_2020_areal_temperature.csv
  products/regional_averages/precipitation/Annual_areal_pecipitation.csv   (sic)
  products/regional_averages/precipitation/Monthly_areal_precipitation.csv
  products/regional_averages/precipitation/Normal_1991_2020_areal_precipitation.csv

Tři pasti, všechny ověřené na obsahu:
  1) Oddělovač NENÍ jednotný: teploty ',', srážky ';'. Zjišťuje se z hlavičky.
  2) V teplotních souborech je první kraj zapsaný jako "¬esko" — bajty
     0xC2 0xAC, tedy platné UTF-8 pro znak "¬". Není to chyba kódování na naší
     straně, ale rozbitý zdroj; ve srážkových souborech je na témže místě
     korektní "Cesko". Sloupec proto NEidentifikujeme podle jména, ale podle
     pozice: první sloupec za popisnými je vždy celá ČR.
  3) Název souboru s ročními srážkami má překlep "pecipitation" — je to tak
     na serveru, ne tady.

Výstup: data/chmi_regional.json
"""

import csv
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/meteorology/products/regional_averages"
TIMEOUT = (10, 30)

# (klíč, podadresář, soubor, popisné sloupce na začátku řádku)
#
# Měsíční řady za celé období (Monthly_areal_*.csv, 1961→dnes) se ZÁMĚRNĚ
# nestahují: je to 65 let × 12 měsíců × 14 krajů, tedy zdaleka největší část
# souboru, a appka z nich neukazuje nic, co by roční řada + normál + letošní
# rok nepokryly. Na mobilu by to byly stovky kB navíc za nic.
SOURCES = [
    ("temp_annual",   "temperature",   "Annual_areal_temperature_mean.csv",        ("Year", "Element")),
    ("temp_current",  "temperature",   f"Monthly_areal_temperature_mean_{datetime.now(timezone.utc).year}.csv",
                                                                                   ("Year", "Month", "Element")),
    ("temp_normal",   "temperature",   "Normal_1991_2020_areal_temperature.csv",   ("Month", "Element")),
    # pozor: "pecipitation" je překlep přímo v názvu souboru na serveru
    ("prec_annual",   "precipitation", "Annual_areal_pecipitation.csv",            ("Year", "Element")),
    ("prec_current",  "precipitation", f"Monthly_areal_precipitation_{datetime.now(timezone.utc).year}.csv",
                                                                                   ("Year", "Month", "Element")),
    ("prec_normal",   "precipitation", "Normal_1991_2020_areal_precipitation.csv", ("Month", "Element")),
]

# Kraje tak, jak je appka zná. "CR" = celá republika (v teplotních souborech
# zapsané rozbitě jako "¬esko", proto se bere podle pozice, ne podle jména).
REGION_LABELS = {
    "CR": "Česko", "JHC": "Jihočeský", "JHM": "Jihomoravský",
    "KVK": "Karlovarský", "HKK": "Královéhradecký", "LBK": "Liberecký",
    "MSK": "Moravskoslezský", "OLK": "Olomoucký", "PAK": "Pardubický",
    "PLK": "Plzeňský", "PHA+STC": "Praha a Střední Čechy",
    "ULK": "Ústecký", "VYS": "Vysočina", "ZLK": "Zlínský",
}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def sniff(header: str) -> str:
    """Oddělovač z hlavičky — teploty ',', srážky ';'. Podle názvu souboru to
    hádat nejde, ČHMÚ to nedrží jednotně."""
    return ";" if header.count(";") > header.count(",") else ","


def parse_csv(text: str, lead: tuple) -> tuple[list, list] | None:
    """
    Vrátí (kódy krajů, řádky). Řádek = {popisné sloupce} + {"v": [hodnoty]}.
    Pořadí hodnot odpovídá pořadí kódů krajů.
    """
    lines = text.splitlines()
    if not lines:
        return None
    delim = sniff(lines[0])
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    if len(rows) < 2:
        return None

    header = [h.strip() for h in rows[0]]
    n_lead = len(lead)
    # První sloupec za popisnými je celá ČR — v teplotních souborech má
    # rozbitý název, takže se pojmenuje podle pozice, ne podle hlavičky.
    codes = ["CR"] + [h for h in header[n_lead + 1:]]

    out = []
    for row in rows[1:]:
        if len(row) < n_lead + 1:
            continue
        rec = {}
        for i, name in enumerate(lead):
            rec[name.lower()] = row[i].strip()
        vals = []
        for cell in row[n_lead: n_lead + len(codes)]:
            cell = (cell or "").strip().replace(",", ".")
            try:
                vals.append(float(cell))
            except ValueError:
                vals.append(None)
        if not any(v is not None for v in vals):
            continue
        rec["v"] = vals
        out.append(rec)
    return (codes, out) if out else None


def main():
    now = datetime.now(timezone.utc)
    result, codes_seen = {}, None

    for key, sub, name, lead in SOURCES:
        url = f"{BASE}/{sub}/{name}"
        try:
            r = SESSION.get(url, timeout=TIMEOUT)
            if not r.ok:
                # Soubor pro aktuální rok nemusí na začátku ledna existovat —
                # to není chyba, jen zatím není co číst.
                print(f"  {name}: HTTP {r.status_code} — přeskakuji", file=sys.stderr)
                continue
            parsed = parse_csv(r.content.decode("utf-8", "replace"), lead)
        except Exception as e:
            print(f"  {name}: {str(e)[:120]} — přeskakuji", file=sys.stderr)
            continue
        if not parsed:
            print(f"  {name}: nic k parsování — přeskakuji", file=sys.stderr)
            continue
        codes, rows = parsed
        if codes_seen is None:
            codes_seen = codes
        elif codes != codes_seen:
            # Kdyby se sada krajů mezi soubory lišila, indexy hodnot by
            # neseděly a klient by četl cizí kraj. Radši ten soubor vynechat.
            print(f"  {name}: jiná sada krajů {codes} — přeskakuji", file=sys.stderr)
            continue
        result[key] = rows
        print(f"  {name}: {len(rows)} řádků")

    if not result or not codes_seen:
        print("chmi_regional.py: nic se nenačetlo — vynechávám", file=sys.stderr)
        return

    out = {
        "generated_at_utc": now.isoformat(),
        "source": "ČHMÚ — areálové průměry po krajích (products/regional_averages)",
        "normal_period": "1991-2020",
        "regions": [{"code": c, "name": REGION_LABELS.get(c, c)} for c in codes_seen],
        **result,
    }
    path = DATA_DIR / "chmi_regional.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_regional.py: {len(codes_seen)} krajů, {len(result)} sad, "
          f"{path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
