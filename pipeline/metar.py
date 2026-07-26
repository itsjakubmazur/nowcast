"""
METAR — letištní meteostanice jako doplněk řídké sítě ČHMÚ.

Proč: ČHMÚ v now/ publikuje jen ~40 stanic na celou ČR (rozestup ~50 km) a
WU síť tímhle klíčem nejde procházet (vlastní stanice ANO, ale /pws/nearby
vrací 401), takže hodnocení modelů i kontrola biasu se pro většinu míst
nikdy nerozjely.
Letiště hlásí METAR každých 30 min, zdarma, bez klíče (NOAA Aviation Weather),
a v ČR + těsném pohraničí jich je několik desítek — síť se tím zahustí.

Dvě větve, každá svým vstupem:

1) DOMA (ČR + pohraničí) — JSON API s bboxem. Vrací i jména stanic
   ("Brno/Tuřany"), takže domovský pohled zůstává čitelný.
   Výstup: data/metar_stations.json ve STEJNÉM tvaru jako chmi_stations.json.

2) SVĚT — bulk dump metars.cache.csv.gz: 250 kB gzip, ~5000 stanic z celého
   světa jedním requestem, bez klíče. Cesta přes bbox tudy nevede: sonda
   ukázala, že JSON API výřezy nad ~10° PODVZORKUJE (celý svět vrátil jen
   158 stanic), takže by to chtělo 100+ dotazů. Bulk to řeší jedním.
   CSV nemá jména stanic, jen ICAO — u světových stanic proto svítí kód.
   Výstup: data/metar/{ty}_{tx}.json — dlaždice 10° s přesahem, aby
   jeden fetch vždy pokryl okolí bodu, a data/metar/index.json.

Zdroje:
  https://aviationweather.gov/api/data/metar?bbox=...&format=json
  https://aviationweather.gov/data/cache/metars.cache.csv.gz
"""

import csv
import gzip
import io
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

# záměrně bez importu ingest.py — ten tahá h5py, které tenhle skript nepotřebuje
# (a bez kterého by nešly spustit ani offline testy parsování)
DATA_DIR = Path(__file__).parent.parent / "data"

API = "https://aviationweather.gov/api/data/metar"
BULK = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
STATIONINFO = "https://aviationweather.gov/api/data/stationinfo"
PAGES_BASE = "https://itsjakubmazur.github.io/nowcast"
NAME_BATCH = 200            # kolik ICAO se vejde do jednoho dotazu
HISTORY_HOURS = 48
# ČR + pásmo pohraničí (DE/PL/AT/SK letiště pomůžou u hranic)
BBOX = "48.3,11.8,51.3,19.2"          # lat0,lon0,lat1,lon1
MAX_AGE_MIN = 150                      # starší hlášení nemá pro "teď" cenu

TILE_DEG = 10
# Přesah dlaždice: hledání nejbližší stanice sahá do 40 km, takže dlaždice
# musí obsahovat i stanice kousek za svou hranicí — jinak by bod u okraje
# "neviděl" letiště hned vedle. 1.5° pokryje 40 km i kolem 70° s. š.
TILE_MARGIN_DEG = 1.5

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def _num(v):
    """METAR pole chodí jako číslo, string i None — vrať float nebo None."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def rh_from_dewpoint(t_c, td_c):
    """Relativní vlhkost z teploty a rosného bodu (Magnus)."""
    if t_c is None or td_c is None:
        return None
    a, b = 17.625, 243.04
    try:
        rh = 100 * math.exp(a * td_c / (b + td_c)) / math.exp(a * t_c / (b + t_c))
        return round(max(0.0, min(100.0, rh)))
    except (ValueError, OverflowError, ZeroDivisionError):
        return None


def parse_time(m) -> str | None:
    """reportTime bývá 'YYYY-MM-DD HH:MM:SS' (UTC), obsTime unix epoch."""
    rt = m.get("reportTime")
    if isinstance(rt, str) and len(rt) >= 16:
        try:
            return datetime.strptime(rt[:19], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    ot = m.get("obsTime")
    if isinstance(ot, (int, float)) and ot > 0:
        return datetime.fromtimestamp(ot, timezone.utc).isoformat()
    return None


# ── Jména letišť ─────────────────────────────────────────────────────────────
# Bulk CSV má jen ICAO kód, takže by na mapě svítilo "LKPR" místo "Praha".
# stationinfo vrací pole `site` ve tvaru "Prague/Havel Arpt", "Munich Intl",
# "Tokyo/Haneda Intl". Z toho se dá vytáhnout město.
#
# Číselník se drží v data/metar_names.json a dotahují se jen ICAO, která v něm
# ještě nejsou — množina letišť je stabilní, takže po prvním naplnění je to
# nula requestů navíc.

AIRPORT_WORDS = ("intl", "arpt", "airport", "airfield", "afb", "aerodrome",
                 "int'l", "ap", "field", "muni", "municipal", "rgnl", "regional")


def city_from_site(site: str) -> str | None:
    """"Prague/Havel Arpt" → "Praha"? Ne — → "Prague". Překládat neumíme,
    ale ICAO kód nahradit umíme."""
    if not site:
        return None
    site = site.strip()
    if "/" in site:
        head, tail = site.split("/", 1)
        # "New York/JF Kennedy Intl" → město je před lomítkem, ale
        # "Hof/Plauen Arpt" jsou dvě města — první stačí.
        if any(w in tail.lower() for w in AIRPORT_WORDS):
            return head.strip() or None
        return head.strip() or None
    # bez lomítka: "Munich Intl" / "Dresden Arpt" → uřízni typ letiště
    parts = site.split()
    while parts and parts[-1].lower().strip(".") in AIRPORT_WORDS:
        parts.pop()
    return " ".join(parts).strip() or None


def load_name_cache():
    path = DATA_DIR / "metar_names.json"
    for src in ("local", "pages"):
        try:
            if src == "local":
                if not path.exists():
                    continue
                d = json.loads(path.read_text())
            else:
                r = SESSION.get(f"{PAGES_BASE}/data/metar_names.json", timeout=(10, 30))
                if not r.ok:
                    continue
                d = r.json()
            names = d.get("names") or {}
            if names:
                print(f"  číselník jmen ({src}): {len(names)}", file=sys.stderr)
                return names
        except Exception as e:
            print(f"  číselník jmen ({src}): {e}", file=sys.stderr)
    return {}


def fill_names(icaos, cache):
    """Doplní chybějící ICAO do cache. Vrací počet nově dotažených."""
    missing = sorted(i for i in icaos if i not in cache)
    if not missing:
        return 0
    added = 0
    for i in range(0, len(missing), NAME_BATCH):
        batch = missing[i:i + NAME_BATCH]
        try:
            r = SESSION.get(STATIONINFO, params={"ids": ",".join(batch),
                                                 "format": "json"}, timeout=(15, 60))
            if not r.ok:
                print(f"  stationinfo HTTP {r.status_code}", file=sys.stderr)
                break
            # Odpověď chodí buď jako pole, nebo zabalená v {"data": [...]}.
            # Bez tohohle rozlišení by se iterovaly KLÍČE slovníku (stringy)
            # a row.get() spadlo na AttributeError — což si vnější try spolkne
            # a jména se tiše nedoplní.
            payload = r.json()
            rows = payload if isinstance(payload, list) else (payload or {}).get("data") or []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                icao = (row.get("icaoId") or row.get("id") or "").strip()
                city = city_from_site(row.get("site") or "")
                if icao and city:
                    cache[icao] = city
                    added += 1
        except Exception as e:
            print(f"  stationinfo dávka {i // NAME_BATCH}: {e}", file=sys.stderr)
            break
    # ICAO, ke kterým jméno neexistuje, si zapamatuj jako prázdné — ať se
    # nedotahují znovu při každém běhu.
    for icao in missing:
        cache.setdefault(icao, "")
    print(f"  jména letišť: chybělo {len(missing)}, dotaženo {added}", file=sys.stderr)
    return added


def save_name_cache(cache, now):
    (DATA_DIR / "metar_names.json").write_text(json.dumps(
        {"generated_at_utc": now.isoformat(), "count": len(cache), "names": cache},
        ensure_ascii=False, separators=(",", ":")))


# ── Historie teplot (domácí letiště) ─────────────────────────────────────────
# Stejný princip jako wu_history.json: načti z Pages, přisyp aktuální měření,
# ořízni na 48 h. Záměrně jen pro domácí bbox — pro všech ~5000 světových
# letišť by jeden soubor narostl na jednotky MB a nikdo by ho nestahoval.

def update_history(stations, now):
    path = DATA_DIR / "metar_history.json"
    hist = {"stations": {}}
    for src in ("pages", "local"):
        try:
            if src == "pages":
                r = SESSION.get(f"{PAGES_BASE}/data/metar_history.json", timeout=(10, 30))
                if not r.ok:
                    continue
                hist = r.json()
            else:
                if not path.exists():
                    continue
                hist = json.loads(path.read_text())
            break
        except Exception as e:
            print(f"  historie ({src}): {e}", file=sys.stderr)
    hist.setdefault("stations", {})

    cutoff = (now - timedelta(hours=HISTORY_HOURS)).isoformat(timespec="minutes")
    for s in stations:
        if not s.get("time_utc") or s.get("temp") is None:
            continue
        rec = hist["stations"].setdefault(s["id"], {
            "name": s["name"], "lat": s["lat"], "lon": s["lon"], "series": [],
        })
        rec["name"] = s["name"]      # jméno se mohlo zpřesnit z číselníku
        entry = {"dt": s["time_utc"], "temp": s["temp"]}
        for k in ("humidity", "wind_kmh", "wind_dir", "pressure"):
            if s.get(k) is not None:
                entry[k] = s[k]
        series = rec["series"]
        if not series or series[-1].get("dt") != entry["dt"]:
            series.append(entry)
        rec["series"] = [e for e in series if e.get("dt", "") >= cutoff]

    hist["updated_at_utc"] = now.isoformat()
    path.write_text(json.dumps(hist, ensure_ascii=False, separators=(",", ":")))
    total = sum(len(v.get("series", [])) for v in hist["stations"].values())
    print(f"  ✓ metar_history.json — {len(hist['stations'])} stanic, "
          f"{total} záznamů", file=sys.stderr)


def tile_xy(lat, lon):
    """Index dlaždice 10°: tx 0..35 od -180°, ty 0..17 od -90°."""
    tx = int(((lon + 180) % 360) // TILE_DEG) % 36
    ty = min(17, max(0, int((lat + 90) // TILE_DEG)))
    return tx, ty


def tiles_for_station(lat, lon):
    """Dlaždice, do kterých stanice patří — včetně sousedních, pokud leží
    v pásu přesahu. Díky tomu stačí klientovi stáhnout JEDNU dlaždici."""
    out = set()
    for dlat in (-TILE_MARGIN_DEG, 0, TILE_MARGIN_DEG):
        for dlon in (-TILE_MARGIN_DEG, 0, TILE_MARGIN_DEG):
            la = max(-90.0, min(90.0, lat + dlat))
            lo = ((lon + dlon + 180) % 360) - 180
            out.add(tile_xy(la, lo))
    return out


def parse_bulk_row(row, now):
    """Řádek metars.cache.csv → náš kompaktní záznam, nebo None."""
    lat, lon = _num(row.get("latitude")), _num(row.get("longitude"))
    temp = _num(row.get("temp_c"))
    icao = (row.get("station_id") or "").strip()
    t_iso = (row.get("observation_time") or "").strip()
    if lat is None or lon is None or temp is None or not icao or not t_iso:
        return None
    try:
        dt = datetime.fromisoformat(t_iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    age_min = (now - dt).total_seconds() / 60
    if age_min > MAX_AGE_MIN or age_min < -30:
        return None

    wspd_kt = _num(row.get("wind_speed_kt"))
    wdir = _num(row.get("wind_dir_degrees"))
    return {
        "id": f"metar-{icao}",
        # Bulk CSV jména stanic neobsahuje — u světových stanic proto ICAO.
        "name": f"{icao} (letiště)",
        "lat": round(lat, 4), "lon": round(lon, 4),
        "elev": _num(row.get("elevation_m")),
        "time_utc": dt.astimezone(timezone.utc).isoformat(),
        "temp": round(temp, 1),
        "humidity": rh_from_dewpoint(temp, _num(row.get("dewpoint_c"))),
        "wind_kmh": round(wspd_kt * 1.852, 1) if wspd_kt is not None else None,
        "wind_dir": round(wdir) if wdir is not None else None,
        "pressure": _num(row.get("altim_in_hg")),
        "source": "metar",
        "own": False,
    }


def build_world_tiles(now):
    """Celosvětové dlaždice z bulk dumpu. Selhání nesmí shodit domácí větev."""
    print("  — světové dlaždice z bulk dumpu —", file=sys.stderr)
    try:
        r = SESSION.get(BULK, timeout=(15, 90))
        r.raise_for_status()
        raw = gzip.decompress(r.content).decode("utf-8", "replace")
    except Exception as e:
        print(f"  bulk dump selhal: {e} — světové dlaždice nechávám staré",
              file=sys.stderr)
        return

    # Soubor občas začíná preambulí; hlavička je řádek začínající "raw_text"
    lines = raw.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("raw_text")), None)
    if start is None:
        print("  bulk dump nemá čekanou hlavičku — končím", file=sys.stderr)
        return

    reader = csv.DictReader(io.StringIO("\n".join(lines[start:])))
    best = {}
    total = 0
    for row in reader:
        total += 1
        rec = parse_bulk_row(row, now)
        if not rec:
            continue
        prev = best.get(rec["id"])
        if prev is None or rec["time_utc"] > prev["time_utc"]:
            best[rec["id"]] = rec
    print(f"  řádků: {total}, použitelných stanic: {len(best)}", file=sys.stderr)
    if len(best) < 500:
        print(f"  podezřele málo stanic ({len(best)}) — dlaždice nepřepisuji",
              file=sys.stderr)
        return

    # ICAO → město. Bez toho by na mapě svítily jen kódy typu LKPR.
    names = load_name_cache()
    icaos = {rec["id"].removeprefix("metar-") for rec in best.values()}
    try:
        fill_names(icaos, names)
        save_name_cache(names, now)
    except Exception as e:
        import traceback
        print(f"  doplnění jmen selhalo: {type(e).__name__}: {e} — jedu s ICAO",
              file=sys.stderr)
        traceback.print_exc()
    named = 0
    for rec in best.values():
        city = names.get(rec["id"].removeprefix("metar-"))
        if city:
            rec["name"] = f"{city} (letiště)"
            named += 1
    print(f"  pojmenováno městem: {named}/{len(best)}", file=sys.stderr)

    tiles = defaultdict(list)
    for rec in best.values():
        for tx, ty in tiles_for_station(rec["lat"], rec["lon"]):
            tiles[(ty, tx)].append(rec)

    out_dir = DATA_DIR / "metar"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()

    written, total_b = 0, 0
    index = []
    for (ty, tx), recs in sorted(tiles.items()):
        recs.sort(key=lambda s: s["name"])
        payload = {
            "generated_at_utc": now.isoformat(),
            "tile": f"{ty}_{tx}",
            "count": len(recs),
            "source": "NOAA Aviation Weather (METAR bulk)",
            "stations": recs,
        }
        p = out_dir / f"{ty}_{tx}.json"
        p.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        written += 1
        total_b += p.stat().st_size
        index.append({"tile": f"{ty}_{tx}", "count": len(recs)})

    (out_dir / "index.json").write_text(json.dumps({
        "generated_at_utc": now.isoformat(),
        "tile_deg": TILE_DEG,
        "margin_deg": TILE_MARGIN_DEG,
        "stations": len(best),
        "tiles": index,
    }, ensure_ascii=False, separators=(",", ":")))

    counts = sorted((t["count"] for t in index), reverse=True)
    print(f"  ✓ {written} dlaždic, {len(best)} stanic, celkem {total_b // 1024} kB "
          f"(největší {counts[0]} stanic, medián {counts[len(counts) // 2]})",
          file=sys.stderr)


def build_home(now):
    """ČR + pohraničí přes JSON API — kvůli jménům stanic."""
    try:
        r = SESSION.get(API, params={"bbox": BBOX, "format": "json"}, timeout=(10, 45))
        r.raise_for_status()
        raw = r.json()
    except Exception as e:
        print(f"  METAR fetch selhal: {e} — nechávám starý soubor", file=sys.stderr)
        return

    if not isinstance(raw, list):
        print(f"  Neočekávaný tvar odpovědi: {type(raw).__name__} — končím", file=sys.stderr)
        return
    print(f"  Hlášení v bboxu: {len(raw)}", file=sys.stderr)
    if raw:
        print(f"  [diag] klíče: {sorted(raw[0].keys())}", file=sys.stderr)

    stations, skipped = [], 0
    for m in raw:
        lat, lon = _num(m.get("lat")), _num(m.get("lon"))
        temp = _num(m.get("temp"))
        icao = m.get("icaoId") or m.get("station_id")
        t_iso = parse_time(m)
        if lat is None or lon is None or temp is None or not icao or not t_iso:
            skipped += 1
            continue
        age_min = (now - datetime.fromisoformat(t_iso)).total_seconds() / 60
        if age_min > MAX_AGE_MIN or age_min < -30:
            skipped += 1
            continue

        wspd_kt = _num(m.get("wspd"))          # uzly
        wdir = _num(m.get("wdir"))             # může být "VRB"
        name = (m.get("name") or icao).split(",")[0].strip()
        stations.append({
            "id": f"metar-{icao}",
            "name": f"{name} (letiště)",
            "lat": round(lat, 4), "lon": round(lon, 4),
            "elev": _num(m.get("elev")),
            "time_utc": t_iso,
            "temp": round(temp, 1),
            "humidity": rh_from_dewpoint(temp, _num(m.get("dewp"))),
            "wind_kmh": round(wspd_kt * 1.852, 1) if wspd_kt is not None else None,
            "wind_dir": round(wdir) if wdir is not None else None,
            "pressure": _num(m.get("altim")),
            "source": "metar",
            "own": False,
        })

    # jedno letiště může hlásit víckrát — nech nejnovější
    best = {}
    for s in stations:
        prev = best.get(s["id"])
        if prev is None or s["time_utc"] > prev["time_utc"]:
            best[s["id"]] = s
    stations = sorted(best.values(), key=lambda s: s["name"])

    out = {
        "generated_at_utc": now.isoformat(),
        "count": len(stations),
        "source": "NOAA Aviation Weather (METAR)",
        "stations": stations,
    }
    path = DATA_DIR / "metar_stations.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"  ✓ metar_stations.json — {len(stations)} stanic "
          f"(přeskočeno {skipped}), {path.stat().st_size // 1024} kB", file=sys.stderr)
    for s in stations[:25]:
        print(f"    {s['name'][:34]:36s} {s['lat']:.2f},{s['lon']:.2f}  "
              f"{s['temp']}°C  {s['time_utc'][11:16]}Z", file=sys.stderr)
    return stations


def main():
    now = datetime.now(timezone.utc)
    print("=== METAR (letištní stanice, NOAA) ===", file=sys.stderr)
    # Obě větve jsou nezávislé: když spadne domácí bbox, svět se stejně
    # postaví (a naopak). Dřív by jeden `return` tiše zabil obojí.
    home = build_home(now)
    print(f"  domácí větev vrátila: {len(home) if home else 0} stanic", file=sys.stderr)
    build_world_tiles(now)
    if home:
        update_history(home, now)
    else:
        print("  historie se nepíše — domácí větev nic nevrátila", file=sys.stderr)


if __name__ == "__main__":
    main()
