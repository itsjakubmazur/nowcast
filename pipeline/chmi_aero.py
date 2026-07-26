"""
Aerologické indexy z radiosondáží Praha a Prostějov → data/chmi_aero.json.

Nečekaně levný zdroj: výpis je 84 bajtů a obsahuje přesně ty veličiny, které
u bouřek rozhodují a které z radaru vyčíst nejde.

Ověřeno sondou (běh 30219708883), soubor
  radiosounding/Praha/recent/ascent/26072612_Praha_ascent_vypis_111506.csv:
    sep=,
    MU CAPE,10
    MU CINH,-80
    MU DCI,21.500
    Tkonv,34.000
    VKH,2.500,700
    KKH,1.600,656

  MU CAPE — konvektivní dostupná potenciální energie nejnestabilnější částice
            (J/kg); hrubě: <300 slabá, 300–1000 mírná, 1000–2500 silná,
            >2500 velmi silná konvekce
  MU CINH — konvektivní zábrana (J/kg, záporná); silně záporná drží pokličku
  MU DCI  — deep convective index
  Tkonv   — konvektivní teplota (°C): teplota, na kterou se musí přízemní
            vzduch ohřát, aby se konvekce spustila sama
  VKH/KKH — výstupná a konvekční kondenzační hladina, dvojice čísel

POZOR na VKH/KKH: druhé číslo je zjevně tlak v hPa (656–804), ale první číslo
NENÍ výška v km, jak by se nabízelo. Praha měla VKH 2,500 při 700 hPa (~3 km,
zhruba sedí), ale Prostějov 10,500 při 804 hPa — a 804 hPa je asi 1,9 km, ne
10,5 km. Pravděpodobně jde o teplotu na té hladině, jisté to ale není.
Ukládáme proto obě čísla surově a do UI je nepouštíme; popisují se až tehdy,
až se význam potvrdí z dokumentace ČHMÚ. Do verdiktu jdou jen CAPE, CIN
a Tkonv, kde je jednotka jednoznačná.

Zásadní omezení, které se musí dostat i do UI: dvě stanice a dva vzestupy
denně (00 a 12 UTC). Odpolední bouřka se řídí ranním sondážním profilem jen
volně. Je to indikátor prostředí, ne předpověď — a tak to bude i formulované.

Výstup: data/chmi_aero.json
"""

import csv
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/meteorology/weather/radiosounding"
TIMEOUT = (10, 30)
MAX_AGE_H = 30      # dva vzestupy denně → do 30 h je vždycky nějaký čerstvý

# název: 26072612_Praha_ascent_vypis_111506.csv  →  YYMMDDHH + město
FILE_RE = re.compile(r'href="((\d{8})_([A-Za-z]+)_ascent_vypis_\d+\.csv)"')

STATIONS = {
    "Praha": {"name": "Praha-Libuš", "lat": 50.008, "lon": 14.447},
    "Prostejov": {"name": "Prostějov", "lat": 49.454, "lon": 17.126},
}

# klíč ve výpisu → (klíč ve výstupu, jednotka)
KEYS = {
    "MU CAPE": ("cape", "J/kg"),
    "MU CINH": ("cin", "J/kg"),
    "MU DCI": ("dci", ""),
    "TKONV": ("t_konv", "°C"),
    # Význam první hodnoty neověřen — viz poznámka v hlavičce. Do UI nejdou.
    "VKH": ("vkh_raw", ""),
    "KKH": ("kkh_raw", ""),
}
UNVERIFIED = {"vkh_raw", "kkh_raw"}

# Prahy CAPE pro slovní hodnocení. Orientační, pro střední Evropu.
CAPE_LEVELS = [(2500, "velmi silná"), (1000, "silná"), (300, "mírná"), (0, "slabá")]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def cape_label(cape) -> str | None:
    if cape is None:
        return None
    for threshold, label in CAPE_LEVELS:
        if cape >= threshold:
            return label
    return "slabá"


def parse_stamp(s: str) -> datetime | None:
    """26072612 → 2026-07-26 12:00 UTC."""
    try:
        return datetime.strptime(s, "%y%m%d%H").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_vypis(text: str) -> dict:
    """
    Řádky jsou 'klíč,hodnota' nebo 'klíč,hodnota1,hodnota2'. První řádek je
    direktiva 'sep=,' pro Excel — přeskočí se.
    """
    out = {}
    body = "\n".join(l for l in text.splitlines() if not l.lower().startswith("sep="))
    for row in csv.reader(io.StringIO(body)):
        if len(row) < 2:
            continue
        key = (row[0] or "").strip().upper()
        mapped = KEYS.get(key)
        if not mapped:
            continue
        name, _unit = mapped
        nums = []
        for cell in row[1:]:
            cell = (cell or "").strip().replace(",", ".")
            try:
                nums.append(float(cell))
            except ValueError:
                pass
        if not nums:
            continue
        # VKH/KKH mají dvě čísla; druhé je tlak v hPa, první zatím neurčené.
        # Ukládáme surově jako pole, ať se nic nepředstírá.
        out[name] = nums[:2] if len(nums) >= 2 else nums[0]
    return out


def fetch_station(city: str) -> dict | None:
    url = f"{BASE}/{city}/recent/ascent/"
    r = SESSION.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    matches = FILE_RE.findall(r.text)
    if not matches:
        return None
    # nejnovější podle YYMMDDHH v názvu
    matches.sort(key=lambda m: m[1])
    fname, stamp_s, _city = matches[-1]
    stamp = parse_stamp(stamp_s)
    if stamp is None:
        return None
    age_h = (datetime.now(timezone.utc) - stamp).total_seconds() / 3600
    if age_h > MAX_AGE_H:
        return None

    blob = SESSION.get(url + fname, timeout=TIMEOUT)
    blob.raise_for_status()
    vals = parse_vypis(blob.content.decode("utf-8", "replace"))
    if not vals:
        return None
    return {
        **STATIONS.get(city, {"name": city}),
        "file": fname,
        "sounding_utc": stamp.isoformat(),
        "age_h": round(age_h, 1),
        **vals,
        "cape_label": cape_label(vals.get("cape")),
    }


def main():
    stations = []
    for city in STATIONS:
        try:
            st = fetch_station(city)
        except Exception as e:
            print(f"  {city}: {str(e)[:120]}", file=sys.stderr)
            continue
        if st:
            stations.append(st)
            print(f"  {city}: CAPE {st.get('cape')} J/kg ({st.get('cape_label')}), "
                  f"CIN {st.get('cin')}, stáří {st['age_h']} h")

    if not stations:
        print("chmi_aero.py: žádná použitelná sondáž — vynechávám", file=sys.stderr)
        return

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "ČHMÚ — radiosondáž (weather/radiosounding)",
        "caveat": ("Dvě stanice, dva vzestupy denně (00 a 12 UTC). Popisuje "
                   "prostředí, ve kterém by bouřka vznikala, ne předpověď "
                   "konkrétní bouřky."),
        "units": {v[0]: v[1] for v in KEYS.values() if v[1]},
        "unverified": sorted(UNVERIFIED),
        "cape_levels": {label: v for v, label in CAPE_LEVELS},
        "stations": stations,
    }
    path = DATA_DIR / "chmi_aero.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_aero.py: {len(stations)} stanic, {path.stat().st_size / 1024:.1f} kB")


if __name__ == "__main__":
    main()
