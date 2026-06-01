"""
Fáze 3a — Fúze
- Načte nowcast.json (0–2 h, radarová extrapolace)
- Načte openmeteo.json (celý den, NWP ICON-D2)
- Stáhne ČHMÚ SIVS CAP výstrahy a vyfiltruje platné
- Uloží data/forecast.json s každým bodem označeným zdrojem + nejistotou
"""

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"

# ČHMÚ opendata CAP — primární: directory listing, fallback: Atom feed
CAP_DIR_URL   = "https://opendata.chmi.cz/meteorology/weather/alerts/cap/"
CAP_ATOM_URL  = "https://vystrahy-cr.chmi.cz/data/XOCZ50_OKPR.xml"
CAP_NS_URI    = "urn:oasis:names:tc:emergency:cap:1.2"
ATOM_NS_URI   = "http://www.w3.org/2005/Atom"

# CISORP kódy pro filtraci lokace
# Praha = 1100 (celé hlavní město jako jeden ORP)
CISORP_PRAGUE = {"1100"}


# ── CAP výstrahy ───────────────────────────────────────────────────────────────

def _cap(el, tag: str) -> str:
    """Vrátí text elementu s CAP namespace, nebo prázdný řetězec."""
    node = el.find(f"{{{CAP_NS_URI}}}{tag}")
    if node is None:
        node = el.find(tag)
    return (node.text or "").strip() if node is not None else ""


def _parse_dt(s: str, fallback: datetime) -> datetime:
    if not s:
        return fallback
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return fallback


def fetch_cap_file_list(n: int = 15) -> list[str]:
    """
    Vrátí seřazený seznam URL posledních n alert_cap_*.xml souborů.
    Starší soubory jsou expirované; n=15 pokryje různé typy výstrah (sucho, bouřky...).
    """
    url = CAP_DIR_URL
    print(f"  CAP listing: GET {url}")
    resp = requests.get(url, timeout=(5, 10))
    print(f"  CAP listing: HTTP {resp.status_code}")
    resp.raise_for_status()
    names = re.findall(r'href="(alert_cap[^"]+\.xml)"', resp.text)
    recent = sorted(set(names))[-n:]
    return [CAP_DIR_URL + n_file for n_file in recent]


def _extract_alerts_from_xml(root: ET.Element) -> list[ET.Element]:
    """Vrátí seznam <alert> elementů — zvládá přímý alert i Atom feed wrapper."""
    NS = CAP_NS_URI
    ATOM = ATOM_NS_URI
    # Přímo <alert>
    if root.tag == f"{{{NS}}}alert":
        return [root]
    # Atom feed: <feed><entry><content><alert> nebo <entry><alert>
    if root.tag in (f"{{{ATOM}}}feed", "feed"):
        alerts = []
        for entry in root.findall(f".//{{{ATOM}}}entry") or root.findall(".//entry"):
            found = entry.findall(f".//{{{NS}}}alert") or entry.findall(".//alert")
            alerts.extend(found)
        return alerts
    # Kolekce nebo jiný obal
    return root.findall(f".//{{{NS}}}alert") or root.findall(".//alert")


def parse_cap_file(xml_bytes: bytes, now_utc: datetime) -> list[dict]:
    """
    Parsuje CAP XML (bytes — čte deklaraci kódování, správně zpracuje UTF-8).
    Deduplikuje přes CAP <identifier>.
    Vrátí seznam výstrah — každá je jeden <info> blok (jedna oblast, jeden jev).
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"    parse chyba: {e}")
        return []

    NS = CAP_NS_URI
    alerts = _extract_alerts_from_xml(root)

    seen_ids: set[str] = set()
    results = []
    for alert in alerts:
        # Přeskoč testovací alerty
        status = _cap(alert, "status")
        if status and status.lower() != "actual":
            continue

        # Deduplikace: <identifier> je unikátní pro každý alert
        identifier = _cap(alert, "identifier")
        if identifier and identifier in seen_ids:
            continue
        if identifier:
            seen_ids.add(identifier)

        infos = alert.findall(f"{{{NS}}}info") or alert.findall("info")
        cs_infos = [i for i in infos if "cs" in _cap(i, "language").lower()]
        work_infos = cs_infos if cs_infos else infos

        for info in work_infos:
            onset   = _parse_dt(_cap(info, "onset"),   now_utc)
            expires = _parse_dt(_cap(info, "expires"),  now_utc + timedelta(hours=24))

            if not (onset <= now_utc <= expires):
                continue

            severity = _cap(info, "severity")
            event    = _cap(info, "event")
            headline = _cap(info, "headline")
            desc     = _cap(info, "description")

            color = {"Extreme": "red", "Severe": "orange",
                     "Moderate": "yellow", "Minor": "green"}.get(severity, "unknown")
            for param in info.findall(f"{{{NS}}}parameter") or info.findall("parameter"):
                pname = _cap(param, "valueName").lower()
                pval  = _cap(param, "value")
                if pname == "awareness_level":
                    parts = [p.strip() for p in pval.split(";")]
                    if len(parts) >= 2:
                        color = parts[1].lower()
                    break
                if "color" in pname or "stupen" in pname or "barva" in pname:
                    color = pval.lower() or color

            areas_desc, cisorp_codes = [], set()
            polygons: list[list[list[float]]] = []
            for area in info.findall(f"{{{NS}}}area") or info.findall("area"):
                aname = _cap(area, "areaDesc")
                if aname:
                    areas_desc.append(aname)
                for gc in area.findall(f"{{{NS}}}geocode") or area.findall("geocode"):
                    vname = _cap(gc, "valueName")
                    vval  = _cap(gc, "value")
                    if vname.upper() == "CISORP":
                        cisorp_codes.add(vval)
                # Polygon: "lat,lon lat,lon ..." — pro point-in-polygon match na libovolný bod
                for poly in area.findall(f"{{{NS}}}polygon") or area.findall("polygon"):
                    ptxt = (poly.text or "").strip()
                    if not ptxt:
                        continue
                    coords = []
                    for pair in ptxt.split():
                        try:
                            la, lo = pair.split(",")
                            coords.append([float(la), float(lo)])
                        except ValueError:
                            continue
                    if len(coords) >= 3:
                        polygons.append(coords)

            # Deduplikace info: jev+onset+firstArea jako fallback key
            dedup_key = f"{event}|{onset.isoformat()}|{areas_desc[0] if areas_desc else ''}"
            if dedup_key in seen_ids:
                continue
            seen_ids.add(dedup_key)

            results.append({
                "identifier":   identifier,
                "event":        event,
                "headline":     headline,
                "severity":     severity,
                "color":        color,
                "onset_utc":    onset.isoformat(),
                "expires_utc":  expires.isoformat(),
                "areas":        areas_desc,
                "cisorp_codes": sorted(cisorp_codes),
                "polygons":     polygons,
                "description":  desc[:300] if desc else "",
            })

    return results


def fetch_all_active_warnings() -> list[dict]:
    """
    Stáhne VŠECHNY aktuálně platné CAP výstrahy z ČHMÚ (celá ČR, bez filtru lokace).
    Vyfiltruje jen reálné výstrahy (Moderate/Severe/Extreme, ne green placeholdery).
    Nikdy nevyhodí výjimku ani nezamrzne — při selhání vrátí prázdný seznam.
    """
    now_utc = datetime.now(timezone.utc)
    all_warnings: list[dict] = []

    # Zdroje v pořadí priority.
    # vystrahy-cr = AGREGOVANÝ soubor všech aktuálně platných výstrah (jeden HTTP request) — funkční primární zdroj.
    # directory listing = tichý fallback (každý soubor = jeden alert), použije se jen když primární selže.
    # (Dřívější www.chmi.cz/.../XOCZ50_OKPR.xml vracelo 404 — vyřazeno, jen špinilo log.)
    sources = [
        ("bulletin_vystr",  "https://vystrahy-cr.chmi.cz/data/XOCZ50_OKPR.xml"),
        ("directory",       CAP_DIR_URL),
    ]

    for source_name, source_url in sources:
        try:
            if source_name == "directory":
                # Fallback: directory listing — každý soubor je samostatný alert.
                # Bereme posledních 15 souborů aby pokryly různé typy výstrah.
                file_urls = fetch_cap_file_list(n=15)
                print(f"  CAP [{source_name}]: {len(file_urls)} souborů")
                for furl in file_urls:
                    try:
                        print(f"    GET {furl}")
                        r = requests.get(furl, timeout=(5, 10))
                        print(f"    HTTP {r.status_code}")
                        r.raise_for_status()
                        all_warnings.extend(parse_cap_file(r.content, now_utc))
                    except Exception as fe:
                        print(f"    Varování: {furl.split('/')[-1]}: {fe}")
            else:
                # Primární/sekundární: jeden soubor s VŠEMI aktuálními výstrahami
                print(f"  CAP [{source_name}]: GET {source_url}")
                r = requests.get(source_url, timeout=(5, 10))
                print(f"  CAP [{source_name}]: HTTP {r.status_code}")
                r.raise_for_status()
                all_warnings.extend(parse_cap_file(r.content, now_utc))

            if all_warnings:
                break   # máme výstrahy, nepotřebujeme další zdroj

        except Exception as e:
            print(f"  CAP [{source_name}]: Varování — nedostupné: {e}")
            continue

    if not all_warnings:
        print("  CAP: Výstrahy nedostupné ze všech zdrojů — pokračuji s prázdným seznamem")

    # ── Log VŠECH aktivních výstrah (bez filtru) ───────────────────────────────
    print(f"  CAP: celkem {len(all_warnings)} aktivních výstrah (všechny kraje):")
    sev_order = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}
    all_warnings.sort(key=lambda w: sev_order.get(w["severity"], 9))
    for w in all_warnings:
        areas_s = ", ".join(w["areas"][:3]) + ("…" if len(w["areas"]) > 3 else "")
        codes_s = ",".join(w["cisorp_codes"][:5])
        print(f"    [{w['color'].upper():7s}] {w['event'][:40]:40s} "
              f"CISORP=[{codes_s}] oblast=[{areas_s}]")

    # ── Filtr: jen reálné výstrahy (zahoď green/Minor placeholdery) ────────────
    # "Žádná výstraha před…" / "Žádný výhled" jsou stupně Minor (barva green).
    ACTIVE_SEVERITY = {"Moderate", "Severe", "Extreme"}
    active = [
        w for w in all_warnings
        if w["severity"] in ACTIVE_SEVERITY and w["color"].lower() != "green"
    ]
    dropped = len(all_warnings) - len(active)
    print(f"  CAP: {len(active)} aktivních výstrah celkem "
          f"(odfiltrováno {dropped} placeholderů green/Minor)")
    for w in active:
        npoly = sum(len(p) for p in w.get("polygons", []))
        print(f"    → [{w['color'].upper():7s}] {w['event']} "
              f"(do {w['expires_utc']}, polygon body={npoly})")
    return active


def fetch_cap_warnings(lat: float, lon: float,
                       prague_cisorp: set[str] = CISORP_PRAGUE) -> list[dict]:
    """
    Vrátí platné výstrahy pro jednu lokaci (zpětná kompatibilita pro Prahu).
    Použije fetch_all_active_warnings() a vyfiltruje podle CISORP / názvu oblasti.
    """
    active_all = fetch_all_active_warnings()
    prague_warnings = [
        w for w in active_all
        if bool(set(w["cisorp_codes"]) & prague_cisorp)
        or any("praha" in a.lower() for a in w["areas"])
    ]
    print(f"  CAP: {len(prague_warnings)} výstrah pro Prahu (CISORP {prague_cisorp})")
    for w in prague_warnings:
        print(f"    → [{w['color'].upper():7s}] {w['event']} (do {w['expires_utc']})")
    return prague_warnings


# ── Fúze nowcast + Open-Meteo ──────────────────────────────────────────────────

def fuse(nowcast_path: Path, om_path: Path, lat: float, lon: float) -> dict:
    """
    Spojí nowcast (0–2 h) s Open-Meteo NWP (2 h → konec dne).
    Zarovnává výhradně podle UTC timestampů.
    Vrátí strukturu vhodnou pro forecast.json.
    """
    with open(nowcast_path) as f:
        nc = json.load(f)
    with open(om_path) as f:
        om = json.load(f)

    t0_str = nc["nowcast"]["t0_utc"]
    t0     = datetime.fromisoformat(t0_str)
    horizon_h = nc["nowcast"]["horizon_h"]
    cutoff    = t0 + timedelta(hours=horizon_h)   # konec nowcastu = začátek NWP

    # ── Nowcast kroky ──────────────────────────────────────────────────────────
    timeseries = []
    for step in nc["nowcast"]["timeseries"]:
        t = datetime.fromisoformat(step["time_utc"])
        timeseries.append({
            "time_utc":    t.isoformat(),
            "source":      "nowcast",
            "confidence":  "high",
            "precip_mm_h": round(step["mm_h"], 3),
            "wind_ms":     None,
            "wind_dir":    None,
            "cape":        None,
        })

    # ── CAPE z hourly (primární — dostupné vždy) ──────────────────────────────
    # minutely_15 cape může být None u ICON-D2; hourly cape je spolehlivější.
    # Vytvoříme lookup UTC_hour → cape pro interpolaci do 15min bodů.
    hourly     = om.get("hourly", {})
    h_times    = hourly.get("time", [])
    h_cape     = hourly.get("cape", [])
    h_precip   = hourly.get("precipitation", [])
    print("\n  CAPE + srážky po hodinách (z hourly NWP):")
    cape_by_hour: dict[str, float] = {}
    for ht, hc, hp in zip(h_times, h_cape, h_precip):
        ht_z = ht if "+" in ht or ht.endswith("Z") else ht + "+00:00"
        cape_by_hour[ht_z] = float(hc) if hc is not None else 0.0
        hc_s = f"{hc:5.0f} J/kg" if hc is not None else "  N/A     "
        hp_s = f"{hp:.2f} mm/h" if hp is not None else "N/A    "
        print(f"    {ht}  CAPE={hc_s}  precip={hp_s}")

    # ── Open-Meteo minutely_15 pro NWP část ───────────────────────────────────
    m15 = om.get("minutely_15", {})
    times_m15  = m15.get("time", [])
    precip_m15 = m15.get("precipitation",      [None] * len(times_m15))
    wind_m15   = m15.get("windspeed_10m",       [None] * len(times_m15))
    gusts_m15  = m15.get("windgusts_10m",       [None] * len(times_m15))
    wdir_m15   = m15.get("winddirection_10m",   [None] * len(times_m15))
    cape_m15   = m15.get("cape",                [None] * len(times_m15))

    nwp_added = 0
    for i, t_str in enumerate(times_m15):
        # OM vrací "2026-05-31T18:00" (bez tz, ale timezone=UTC bylo požadováno)
        t_str_z = t_str if "+" in t_str or t_str.endswith("Z") else t_str + "+00:00"
        t = datetime.fromisoformat(t_str_z)

        # Použi jen bod AFTER cutoff (nowcast 0–2 h má přednost)
        if t <= cutoff:
            continue

        # Ořízni na konec dnešního dne UTC
        end_of_day = t0.replace(hour=23, minute=59, second=59)
        if t > end_of_day:
            break

        def _ms(kmh):
            return round(float(kmh) / 3.6, 1) if kmh is not None else None

        # CAPE: minutely_15 preferovaný, fallback na hourly pro stejnou hodinu
        cape_val = cape_m15[i] if (cape_m15 and i < len(cape_m15) and
                                    cape_m15[i] is not None) else None
        if cape_val is None:
            # zaokrouhli čas na celou hodinu UTC → lookup v hourly
            t_hour = t.replace(minute=0, second=0, microsecond=0).isoformat()
            cape_val = cape_by_hour.get(t_hour)

        timeseries.append({
            "time_utc":        t.isoformat(),
            "source":          "nwp",
            "confidence":      "medium",
            "precip_mm_h":     round(float(precip_m15[i]), 3) if precip_m15[i] is not None else None,
            "wind_ms":         _ms(wind_m15[i]),
            "wind_gusts_ms":   _ms(gusts_m15[i]),
            "wind_dir":        wdir_m15[i] if i < len(wdir_m15) else None,
            "cape":            float(cape_val) if cape_val is not None else None,
        })
        nwp_added += 1

    timeseries.sort(key=lambda x: x["time_utc"])

    nowcast_points = sum(1 for p in timeseries if p["source"] == "nowcast")
    print(f"  Fúze: {nowcast_points} nowcast bodů + {nwp_added} NWP bodů = {len(timeseries)} celkem")
    print(f"  Nowcast pokrytí: {t0.isoformat()} → {cutoff.isoformat()}")
    if timeseries:
        print(f"  NWP pokrytí:    {cutoff.isoformat()} → {timeseries[-1]['time_utc']}")

    return {
        "location":        nc.get("location", {"lat": lat, "lon": lon}),
        "t0_utc":          t0_str,
        "cutoff_utc":      cutoff.isoformat(),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "nowcast_source":  nc.get("source", {}),
        "timeseries":      timeseries,
        "warnings":        [],   # doplní fetch_cap_warnings
        "verdict":         None, # doplní narrate.py
    }


# ── Hlavní tok ─────────────────────────────────────────────────────────────────

def main():
    import os
    lat = float(os.environ.get("NOWCAST_LAT", 50.08))
    lon = float(os.environ.get("NOWCAST_LON", 14.42))

    nowcast_path = DATA_DIR / "nowcast.json"
    om_path      = DATA_DIR / "openmeteo.json"

    for p in (nowcast_path, om_path):
        if not p.exists():
            print(f"ERROR: {p} nenalezen — spusť nejdřív ingest.py + nowcast.py")
            raise SystemExit(1)

    print("\n=== Fúze nowcast + NWP ===")
    forecast = fuse(nowcast_path, om_path, lat, lon)

    print("\n=== CAP výstrahy (ČHMÚ SIVS) ===")
    try:
        forecast["warnings"] = fetch_cap_warnings(lat, lon)
    except Exception as e:
        print(f"  Varování: fetch_cap_warnings neočekávaně selhalo: {e}")
        forecast["warnings"] = []
    for w in forecast["warnings"]:
        print(f"  [{w['color'].upper():7s}] {w['event']} — platí do {w['expires_utc']}")

    out_path = DATA_DIR / "forecast.json"
    with open(out_path, "w") as f:
        json.dump(forecast, f, indent=2, ensure_ascii=False)
    print(f"\n✓ Fáze 3a — Fúze OK → {out_path}")
    print(f"  (verdikt bude doplněn pomocí narrate.py)")


if __name__ == "__main__":
    main()
