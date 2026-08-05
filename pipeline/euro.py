"""
Evropské národní sítě bez klíče — zahuštění mapy tam, kde ji reálně používáme.

Proč tohle a ne "celosvětová síť": žádná neexistuje. METAR dá 5000 letišť po
světě, bóje NDBC zalepí moře, ale pozemní stanice mimo letiště nikdo neposílá
jedním dotazem zadarmo. Zato několik národních úřadů publikuje svou síť
otevřeně, bez registrace a jedním requestem na stát — a zrovna v Evropě je to
přesně tam, kde se appka používá. Rychvald má polskou hranici pět kilometrů
daleko, takže polské stanice jsou pro něj bližší než většina českých.

Ověřeno sondou probe_world.py z runneru (všechno HTTP 200, bez klíče):

  SMHI (SE)         .../parameter/1/station-set/all/period/latest-hour   60 kB
  MeteoSwiss (CH)   messwerte-lufttemperatur-10min JSON                 167 kB
  GeoSphere (AT)    dataset.api.hub.geosphere.at, TAWES 10min            —
  IMGW (PL)         danepubliczne.imgw.pl/api/data/synop                 14 kB

Každý zdroj je samostatná funkce se samostatným try. Když spadne Švédsko,
Polsko se stejně stáhne — jeden mrtvý úřad nesmí sebrat zbytek.

Dvě pasti, které stály nejvíc práce a jsou proto okomentované u kódu:
  · MeteoSwiss posílá souřadnice v EPSG:2056 (švýcarský LV95), ne ve WGS84.
    Bez převodu by stanice skončily někde v Africe.
  · IMGW souřadnice NEPOSÍLÁ vůbec — jen id a název stanice. Doplňují se
    z číselníku Meteostatu podle WMO id a číselník se drží v data/, takže se
    tahá jednou za měsíc, ne každý běh.

Výstup: data/euro_stations.json ve stejném tvaru jako chmi_stations.json.
"""

import gzip
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
OUT = DATA_DIR / "euro_stations.json"
COORDS_CACHE = DATA_DIR / "imgw_coords.json"
PAGES = "https://itsjakubmazur.github.io/nowcast/data"
TIMEOUT = (15, 60)
MAX_AGE_MIN = 180          # starší měření pro "teď" nemá cenu
COORDS_MAX_AGE_DAYS = 30   # číselník stanic se skoro nemění

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def _f(v):
    """Číslo z čehokoli — API sem posílají čísla i stringy i prázdno."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _fresh(dt, now):
    if dt is None:
        return False
    age = (now - dt).total_seconds() / 60
    return -30 <= age <= MAX_AGE_MIN


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def rec(sid, name, lat, lon, elev, dt, temp, country, **extra):
    r = {
        "id": sid, "name": name,
        "lat": round(lat, 4), "lon": round(lon, 4),
        "elev": round(elev) if elev is not None else None,
        "time_utc": _iso(dt), "temp": round(temp, 1),
        "source": "euro", "country": country, "own": False,
    }
    r.update({k: v for k, v in extra.items() if v is not None})
    return r


# ── Švédsko ──────────────────────────────────────────────────────────────────
def smhi(now):
    url = ("https://opendata-download-metobs.smhi.se/api/version/1.0"
           "/parameter/1/station-set/all/period/latest-hour/data.json")
    d = SESSION.get(url, timeout=TIMEOUT).json()
    out = []
    for st in d.get("station") or []:
        lat, lon = _f(st.get("latitude")), _f(st.get("longitude"))
        vals = st.get("value") or []
        if lat is None or lon is None or not vals:
            continue
        v = vals[-1]
        temp = _f(v.get("value"))
        ms = v.get("date")
        if temp is None or not isinstance(ms, (int, float)):
            continue
        dt = datetime.fromtimestamp(ms / 1000, timezone.utc)
        if not _fresh(dt, now):
            continue
        out.append(rec(f"smhi-{st.get('key')}", st.get("name") or "?",
                       lat, lon, _f(st.get("height")), dt, temp, "SE"))
    return out


# ── Švýcarsko ────────────────────────────────────────────────────────────────
def meteoswiss(now):
    url = ("https://data.geo.admin.ch/ch.meteoschweiz.messwerte-lufttemperatur-10min"
           "/ch.meteoschweiz.messwerte-lufttemperatur-10min_en.json")
    d = SESSION.get(url, timeout=TIMEOUT).json()
    # Souřadnice chodí v EPSG:2056 (LV95). Bez převodu by stanice spadly
    # někam k rovníku — jsou to metry, ne stupně.
    to_wgs = None
    crs = ((d.get("crs") or {}).get("properties") or {}).get("name") or ""
    if "2056" in str(crs):
        try:
            from pyproj import Transformer
            to_wgs = Transformer.from_crs("EPSG:2056", "EPSG:4326", always_xy=True)
        except Exception as e:
            print(f"  MeteoSwiss: pyproj chybí ({e}) — vynechávám", file=sys.stderr)
            return []
    out = []
    for ft in d.get("features") or []:
        geom = ft.get("geometry") or {}
        props = ft.get("properties") or {}
        coords = geom.get("coordinates") or []
        if len(coords) < 2:
            continue
        x, y = _f(coords[0]), _f(coords[1])
        if x is None or y is None:
            continue
        if to_wgs:
            lon, lat = to_wgs.transform(x, y)
        else:
            lon, lat = x, y
        temp = _f(props.get("value"))
        if temp is None:
            continue
        raw = props.get("reference_ts") or props.get("date") or d.get("reference_ts")
        dt = _parse_iso(raw)
        if not _fresh(dt, now):
            continue
        out.append(rec(f"ch-{props.get('station_abbr') or props.get('id')}",
                       props.get("station_name") or props.get("name") or "?",
                       lat, lon, _f(props.get("altitude")), dt, temp, "CH"))
    return out


def _parse_iso(v):
    if not v:
        return None
    s = str(v).strip().replace("Z", "+00:00")
    for fmt in (None, "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.fromisoformat(s) if fmt is None else datetime.strptime(s, fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


# ── Rakousko ─────────────────────────────────────────────────────────────────
def geosphere(now):
    base = "https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min"
    # Bez station_ids vrací API 422 (ověřeno sondou). Seznam se vytáhne
    # z metadat, kde jsou i souřadnice.
    meta = SESSION.get(f"{base}/metadata", timeout=TIMEOUT).json()
    stations = meta.get("stations") or []
    info = {}
    for s in stations:
        sid = str(s.get("id") or "")
        lat, lon = _f(s.get("lat")), _f(s.get("lon"))
        if sid and lat is not None and lon is not None:
            info[sid] = (s.get("name") or "?", lat, lon, _f(s.get("altitude")))
    if not info:
        return []
    ids = ",".join(list(info)[:400])
    d = SESSION.get(base, params={"parameters": "TL", "station_ids": ids,
                                  "output_format": "geojson"}, timeout=TIMEOUT).json()
    stamps = [_parse_iso(t) for t in (d.get("timestamps") or [])]
    if not stamps:
        return []
    out = []
    for ft in d.get("features") or []:
        props = ft.get("properties") or {}
        sid = str(props.get("station") or "")
        series = ((props.get("parameters") or {}).get("TL") or {}).get("data") or []
        if sid not in info or not series:
            continue
        # Poslední NEPRÁZDNÁ hodnota, ne poslední prvek řady. Stanice nehlásí
        # všechny ve stejnou minutu — část TAWES jede po hodině — takže na
        # posledním časovém razítku má většina null. Brát natvrdo series[-1]
        # znamenalo, že z 277 rakouských stanic prošla JEDNA.
        temp = dt = None
        for i in range(len(series) - 1, -1, -1):
            v = _f(series[i])
            if v is None:
                continue
            t = stamps[i] if i < len(stamps) else stamps[-1]
            if _fresh(t, now):
                temp, dt = v, t
            break
        if temp is None or dt is None:
            continue
        name, lat, lon, elev = info[sid]
        out.append(rec(f"at-{sid}", name, lat, lon, elev, dt, temp, "AT"))
    return out


# ── Polsko ───────────────────────────────────────────────────────────────────
def imgw(now, coords):
    d = SESSION.get("https://danepubliczne.imgw.pl/api/data/synop",
                    timeout=TIMEOUT).json()
    out = []
    for s in d:
        sid = str(s.get("id_stacji") or "").strip()
        temp = _f(s.get("temperatura"))
        c = coords.get(sid)
        if temp is None or not c:
            continue
        try:
            dt = datetime.strptime(
                f"{s.get('data_pomiaru')} {int(s.get('godzina_pomiaru')):02d}",
                "%Y-%m-%d %H").replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        if not _fresh(dt, now):
            continue
        out.append(rec(f"pl-{sid}", s.get("stacja") or "?",
                       c["lat"], c["lon"], c.get("elev"), dt, temp, "PL",
                       humidity=_f(s.get("wilgotnosc_wzgledna")),
                       wind_kmh=(lambda w: round(w * 3.6, 1) if w is not None else None)(
                           _f(s.get("predkosc_wiatru"))),
                       pressure=_f(s.get("cisnienie"))))
    return out


def imgw_coords():
    """
    IMGW posílá jen id a název stanice, souřadnice ne. Doplní se z číselníku
    Meteostatu podle WMO id (id_stacji IMGW = WMO číslo stanice, ověřeno na
    Białystoku 12295). Číselník je 1 MB, takže se drží v data/ a stahuje
    jednou za měsíc — ne každý běh.
    """
    for path, label in ((COORDS_CACHE, "local"), (None, "pages")):
        try:
            if path is not None:
                if not path.exists():
                    continue
                d = json.loads(path.read_text())
            else:
                r = SESSION.get(f"{PAGES}/imgw_coords.json", timeout=TIMEOUT)
                if not r.ok:
                    continue
                d = r.json()
            built = _parse_iso(d.get("built_utc"))
            if built and datetime.now(timezone.utc) - built < timedelta(days=COORDS_MAX_AGE_DAYS):
                return d.get("stations") or {}
        except Exception:
            continue

    try:
        r = SESSION.get("https://bulk.meteostat.net/v2/stations/full.json.gz",
                        timeout=(15, 120))
        r.raise_for_status()
        data = json.loads(gzip.decompress(r.content))
    except Exception as e:
        print(f"  IMGW: číselník souřadnic se nepodařilo postavit ({str(e)[:100]})",
              file=sys.stderr)
        return {}

    out = {}
    for s in data:
        if s.get("country") != "PL":
            continue
        wmo = ((s.get("identifiers") or {}).get("wmo") or "").strip()
        loc = s.get("location") or {}
        if not wmo or loc.get("latitude") is None:
            continue
        out[wmo] = {"lat": loc["latitude"], "lon": loc["longitude"],
                    "elev": loc.get("elevation")}
    COORDS_CACHE.write_text(json.dumps(
        {"built_utc": datetime.now(timezone.utc).isoformat(), "stations": out},
        ensure_ascii=False, separators=(",", ":")))
    print(f"  IMGW: číselník souřadnic postaven ({len(out)} stanic)", file=sys.stderr)
    return out


SOURCES = [
    ("SMHI (SE)", smhi),
    ("MeteoSwiss (CH)", meteoswiss),
    ("GeoSphere (AT)", geosphere),
]


def main():
    now = datetime.now(timezone.utc)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print("=== Evropské národní sítě (bez klíče) ===", file=sys.stderr)

    stations = []
    for label, fn in SOURCES:
        try:
            got = fn(now)
            stations += got
            print(f"  {label:18s} {len(got):4d} stanic", file=sys.stderr)
        except Exception as e:
            print(f"  {label:18s} SELHALO: {type(e).__name__}: {str(e)[:120]}",
                  file=sys.stderr)

    try:
        got = imgw(now, imgw_coords())
        stations += got
        print(f"  {'IMGW (PL)':18s} {len(got):4d} stanic", file=sys.stderr)
    except Exception as e:
        print(f"  {'IMGW (PL)':18s} SELHALO: {type(e).__name__}: {str(e)[:120]}",
              file=sys.stderr)

    if not stations:
        print("euro.py: žádná stanice — soubor nechávám být (radši starý než prázdný)",
              file=sys.stderr)
        return

    OUT.write_text(json.dumps({
        "generated_at_utc": now.isoformat(),
        "source": "SMHI (SE), MeteoSwiss (CH), GeoSphere (AT), IMGW (PL)",
        "stations": stations,
    }, ensure_ascii=False, separators=(",", ":")))
    kb = OUT.stat().st_size / 1024
    print(f"✓ euro_stations.json — {len(stations)} stanic, {kb:.0f} kB", file=sys.stderr)


if __name__ == "__main__":
    main()
