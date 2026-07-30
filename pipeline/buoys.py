"""
Bóje NOAA NDBC — měřená teplota vzduchu tam, kde nejsou letiště.

Proč zrovna tohle a proč to není "celosvětová síť" v tom smyslu, v jakém ji
člověk čeká: žádný veřejný feed neposílá jedním dotazem všechny pozemní
stanice světa. METAR (už ho máme) dá ~5000 letišť, ale letiště nejsou nad
mořem, na ostrovech ani na pobřeží mimo města — a přesně tam mapa zela
prázdnotou. NDBC to zalepí jedním souborem:

  https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt
  ~100 kB, 886 stanic, z toho 534 hlásí teplotu vzduchu, bez klíče,
  bez registrace, jeden request za běh. (Naměřeno sondou probe_world.py.)

Formát je pevně sloupcovaný text se dvěma řádky hlavičky:

  #STN  LAT  LON  YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
  #text deg  deg   yr mo dy hr mn degT  m/s m/s    m sec sec degT  hPa  hPa degC degC degC nmi   ft

Chybějící hodnota je "MM". Sloupce se hledají podle jména v hlavičce, ne podle
pozice — NDBC už jednou pořadí měnilo a natvrdo zapsané indexy by to přešly
mlčky se špatnými čísly.

POZOR na jedno omezení, které je v kódu vidět dál: bóje měří teplotu nad vodou.
Jako tečka na mapě je to poctivé měření, ale jako referenční stanice pro
hodnocení modelů na souši by lhala — moře je v létě chladnější a v zimě teplejší
než pevnina pár kilometrů odtud. Proto nesou source "ndbc" a frontend je z
výběru "nejbližší měřená stanice" vynechává.
"""

import sys
from datetime import datetime, timezone

import requests

URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
TIMEOUT = (15, 60)
MAX_AGE_MIN = 180        # bóje hlásí po hodině; 3 h je horní mez použitelnosti
MISSING = {"MM", "-", "", "N/A"}


def _num(v):
    if v is None or v in MISSING:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse(text, now):
    """Text NDBC → seznam záznamů ve stejném tvaru, jaký používá metar.py."""
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return []
    # První řádek je hlavička sloupců (začíná #STN), druhý jednotky.
    header = lines[0].lstrip("#").split()
    try:
        idx = {name: i for i, name in enumerate(header)}
        i_stn = 0
        i_lat, i_lon = idx["LAT"], idx["LON"]
        i_y, i_mo, i_d = idx["YYYY"], idx["MM"], idx["DD"]
    except KeyError as e:
        print(f"buoys.py: v hlavičce chybí {e} — NDBC změnilo formát, vynechávám",
              file=sys.stderr)
        return []
    # "MM" je v hlavičce dvakrát: měsíc a chybějící hodnota nemají nic
    # společného, ale sloupec měsíce je ten první za YYYY.
    i_h, i_mi = idx.get("hh"), idx.get("mm")
    i_atmp, i_dewp = idx.get("ATMP"), idx.get("DEWP")
    i_wspd, i_wdir = idx.get("WSPD"), idx.get("WDIR")
    i_pres = idx.get("PRES")
    if i_atmp is None or i_h is None:
        print("buoys.py: chybí ATMP nebo hh — vynechávám", file=sys.stderr)
        return []

    out = []
    for line in lines[2:]:
        f = line.split()
        if len(f) <= max(i_atmp, i_lat, i_lon, i_mi):
            continue
        temp = _num(f[i_atmp])
        lat, lon = _num(f[i_lat]), _num(f[i_lon])
        if temp is None or lat is None or lon is None:
            continue
        try:
            dt = datetime(int(f[i_y]), int(f[i_mo]), int(f[i_d]),
                          int(f[i_h]), int(f[i_mi]), tzinfo=timezone.utc)
        except (ValueError, IndexError):
            continue
        age_min = (now - dt).total_seconds() / 60
        if age_min > MAX_AGE_MIN or age_min < -30:
            continue

        wspd = _num(f[i_wspd]) if i_wspd is not None and len(f) > i_wspd else None
        wdir = _num(f[i_wdir]) if i_wdir is not None and len(f) > i_wdir else None
        pres = _num(f[i_pres]) if i_pres is not None and len(f) > i_pres else None
        dewp = _num(f[i_dewp]) if i_dewp is not None and len(f) > i_dewp else None
        out.append({
            "id": f"ndbc-{f[i_stn]}",
            "name": f"{f[i_stn]} (bóje)",
            "lat": round(lat, 4), "lon": round(lon, 4),
            # Hladina moře. Není to odhad — bóje plave.
            "elev": 0,
            "time_utc": dt.isoformat(),
            "temp": round(temp, 1),
            "humidity": _rh(temp, dewp),
            "wind_kmh": round(wspd * 3.6, 1) if wspd is not None else None,
            "wind_dir": round(wdir) if wdir is not None else None,
            "pressure": pres,
            "source": "ndbc",
            "own": False,
        })
    return out


def _rh(t_c, td_c):
    """Relativní vlhkost z teploty a rosného bodu (Magnus)."""
    if t_c is None or td_c is None:
        return None
    import math
    e = 6.112 * math.exp(17.62 * td_c / (243.12 + td_c))
    es = 6.112 * math.exp(17.62 * t_c / (243.12 + t_c))
    if es <= 0:
        return None
    return round(max(0, min(100, 100 * e / es)))


def fetch(now, session=None):
    """Stáhne a zparsuje. Selhání nesmí shodit světové dlaždice."""
    s = session or requests
    try:
        r = s.get(URL, timeout=TIMEOUT,
                  headers={"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})
        r.raise_for_status()
    except Exception as e:
        print(f"buoys.py: stažení selhalo ({str(e)[:120]}) — pokračuji bez bójí",
              file=sys.stderr)
        return []
    recs = parse(r.text, now)
    print(f"  bóje NDBC: {len(recs)} stanic s teplotou", file=sys.stderr)
    return recs
