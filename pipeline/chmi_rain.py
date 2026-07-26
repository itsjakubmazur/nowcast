"""
ČHMÚ srážkoměrná síť — 436 stanic navíc k 40 klimatologickým.

JAK JSME NA NĚ PŘIŠLI (a proč tu nebyly dřív): chmi.py hledal stanice
regexem `10m-0-20000-0-(\\d+)-DATE.json`, tedy VÝHRADNĚ WIGOS prefix
0-20000-0 — mezinárodně vyměňované stanice, kterých má ČHMÚ 40. Prefix
0-203-0 (česká národní síť) tím propadl celý: dalších 436 stanic.
Sonda to změřila bez předpokladu o tvaru názvu: now/data/ obsahuje
476 unikátních stanic, z toho 436 národních.

CO TO JE A CO TO NENÍ: národní stanice hlásí ve většině případů jediný
prvek SRA10M — srážky za 10 minut. Nemají teplotu, takže žebříček přesnosti
modelů (ten jede na teplotě) nezahustí ani o jednu. Zahustí ale to, co náš
nowcast vlastně předpovídá — SRÁŽKY — a to z 40 bodů na ~476, tedy
z rozestupu ~50 km na ~15 km.

Souřadnice mají všechny (ověřeno: 436/436 je v číselníku meta1).
Rozsah 48.62–51.02 N, 12.18–18.83 E — čistě ČR, nic za hranicemi.

Výstup: data/chmi_rain.json
  {generated_at_utc, count, stations: [{id, name, lat, lon, elev,
    time_utc, mm_10m, mm_1h, mm_3h, mm_6h, mm_24h}]}
"""

import json
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

# záměrně bez importu ingest.py — ten tahá h5py, které tenhle skript nepotřebuje
DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/meteorology/climate/now"

ELEMENT = "SRA10M"          # srážky za 10 min [mm]
MAX_WORKERS = 12            # ČHMÚ zvládá, ale nechceme se na něj vrhnout
BUDGET_S = 150              # tvrdý strop, ať krok pipeline nikdy nevisí
MAX_AGE_MIN = 120           # starší hlášení nemá pro "kolik spadlo" cenu
SESSION_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
    "Accept": "application/json,text/html,*/*",
}


def _session():
    s = requests.Session()
    s.headers.update(SESSION_HEADERS)
    return s


def load_metadata(session, dates):
    """WSI → {name, lat, lon, elev} z meta1. Pozor: GEOGR1 je LONGITUDA,
    GEOGR2 latituda (ověřeno na vzorku: Reykjavík -21.9 / 64.1)."""
    for d in dates:
        try:
            r = session.get(f"{BASE}/metadata/meta1-{d}.json", timeout=(10, 45))
            if not r.ok:
                continue
            values = r.json()["data"]["data"]["values"]
        except Exception as e:
            print(f"  meta1-{d}: {e}", file=sys.stderr)
            continue
        out = {}
        for row in values:
            if len(row) < 6:
                continue
            wsi = str(row[0])
            try:
                lon, lat, elev = float(row[3]), float(row[4]), float(row[5])
            except (TypeError, ValueError):
                continue
            out[wsi] = {"name": str(row[2]) or wsi, "lat": lat, "lon": lon,
                        "elev": elev}
        if out:
            print(f"  číselník meta1-{d}: {len(out)} stanic", file=sys.stderr)
            return out
    return {}


def list_rain_stations(session, dates, metadata):
    """Národní stanice (0-203-0), které dnes/včera publikují 10min soubor."""
    import re
    try:
        r = session.get(f"{BASE}/data/", timeout=(10, 60))
        r.raise_for_status()
    except Exception as e:
        print(f"  výpis now/data/ selhal: {e}", file=sys.stderr)
        return []
    found = {}
    for d in dates:
        for wsi in re.findall(rf'10m-(0-203-0-\d+)-{d}\.json', r.text):
            found.setdefault(wsi, d)
    known = [(w, d) for w, d in found.items() if w in metadata]
    print(f"  národních stanic v datech: {len(found)}, "
          f"se souřadnicemi: {len(known)}", file=sys.stderr)
    return known


def fetch_series(session, wsi, date, deadline):
    """Vrátí [(dt, mm), …] pro jednu stanici a den, nebo None."""
    if time.monotonic() > deadline:
        return None
    url = f"{BASE}/data/10m-{wsi}-{date}.json"
    try:
        r = session.get(url, timeout=(10, 30))
        if not r.ok:
            return None
        d = r.json()["data"]["data"]
        out = []
        for row in d.get("values", []):
            # STATION,ELEMENT,DT,VAL,FLAG,QUALITY
            if len(row) < 4 or row[1] != ELEMENT or row[3] is None:
                continue
            try:
                dt = datetime.fromisoformat(str(row[2]).replace("Z", "+00:00"))
                out.append((dt, float(row[3])))
            except (TypeError, ValueError):
                continue
        return sorted(out)
    except Exception:
        return None


def totals(series, now):
    """Součty za posledních 1/3/6/24 h z 10minutových úhrnů."""
    def s(hours):
        cut = now - timedelta(hours=hours)
        return round(sum(v for dt, v in series if dt > cut), 1)
    return s(1), s(3), s(6), s(24)


def main():
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y%m%d")
    yday = (now - timedelta(days=1)).strftime("%Y%m%d")
    dates = (today, yday)
    print("=== ČHMÚ srážkoměrná síť (národní stanice 0-203-0) ===")

    session = _session()
    metadata = load_metadata(session, dates)
    if not metadata:
        print("  číselník nedostupný — nechávám starý soubor", file=sys.stderr)
        raise SystemExit(0)

    stations = list_rain_stations(session, dates, metadata)
    if len(stations) < 100:
        print(f"  příliš málo stanic ({len(stations)}) — nepřepisuji",
              file=sys.stderr)
        raise SystemExit(0)

    deadline = time.monotonic() + BUDGET_S
    t0 = time.monotonic()
    # Dnešní soubor stačí na 1/3/6h; na 24h přisypeme včerejší, ale jen když
    # zbývá rozpočet — 24h úhrn je bonus, 1h je to hlavní.
    series = defaultdict(list)

    def grab(args):
        wsi, date = args
        return wsi, fetch_series(session, wsi, date, deadline)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        for wsi, ser in ex.map(grab, [(w, today) for w, _ in stations]):
            if ser:
                series[wsi].extend(ser)
        done_today = len(series)
        if time.monotonic() < deadline:
            for wsi, ser in ex.map(grab, [(w, yday) for w, _ in stations]):
                if ser:
                    series[wsi].extend(ser)
    print(f"  stažen dnešek pro {done_today} stanic, s včerejškem "
          f"{len(series)} za {time.monotonic() - t0:.1f}s", file=sys.stderr)

    out = []
    for wsi, ser in series.items():
        if not ser:
            continue
        ser.sort()
        last_dt, last_mm = ser[-1]
        age_min = (now - last_dt).total_seconds() / 60
        meta = metadata[wsi]
        h1, h3, h6, h24 = totals(ser, now)
        out.append({
            "id": wsi,
            "name": meta["name"],
            "lat": round(meta["lat"], 4), "lon": round(meta["lon"], 4),
            "elev": meta["elev"],
            "time_utc": last_dt.astimezone(timezone.utc).isoformat(),
            "stale": age_min > MAX_AGE_MIN,
            "mm_10m": round(last_mm, 1),
            "mm_1h": h1, "mm_3h": h3, "mm_6h": h6, "mm_24h": h24,
        })
    out.sort(key=lambda s: s["name"])

    fresh = [s for s in out if not s["stale"]]
    if len(fresh) < 100:
        print(f"  čerstvých jen {len(fresh)} — nepřepisuji", file=sys.stderr)
        raise SystemExit(0)

    payload = {
        "generated_at_utc": now.isoformat(),
        "count": len(out),
        "fresh": len(fresh),
        "source": "ČHMÚ opendata — srážkoměrná síť (SRA10M)",
        "stations": out,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = DATA_DIR / "chmi_rain.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    wet = [s for s in fresh if s["mm_1h"] > 0]
    print(f"✓ chmi_rain.json — {len(out)} stanic ({len(fresh)} čerstvých), "
          f"{p.stat().st_size // 1024} kB, prší na {len(wet)}")
    for s in sorted(fresh, key=lambda s: -s["mm_24h"])[:8]:
        print(f"    {s['name'][:30]:32s} 1h {s['mm_1h']:5.1f}  24h {s['mm_24h']:6.1f} mm",
              file=sys.stderr)


if __name__ == "__main__":
    main()
