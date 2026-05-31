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

# ČHMÚ SIVS CAP — zkusíme více URL, bereme první funkční
CAP_URLS = [
    "https://www.chmi.cz/files/portal/docs/meteo/om/sivs/last_cap.xml",
    "https://www.chmi.cz/files/portal/docs/meteo/om/sivs/last.xml",
    "https://www.chmi.cz/files/portal/docs/meteo/om/sivs/index.xml",
]

# CAP XML namespace
CAP_NS = {
    "cap": "urn:oasis:names:tc:emergency:cap:1.2",
    "": "urn:oasis:names:tc:emergency:cap:1.2",
}


# ── CAP výstrahy ───────────────────────────────────────────────────────────────

def fetch_cap_warnings(lat: float, lon: float) -> list[dict]:
    """
    Stáhne a parsuje ČHMÚ SIVS CAP XML.
    Vrátí seznam výstrah platných nyní, seřazených podle závažnosti.
    """
    xml_text = None
    for url in CAP_URLS:
        try:
            r = requests.get(url, timeout=15)
            if r.status_code == 200 and "<alert" in r.text:
                xml_text = r.text
                print(f"  CAP: staženo z {url}")
                break
            print(f"  CAP: {url} → HTTP {r.status_code}")
        except Exception as e:
            print(f"  CAP: {url} → {e}")

    if not xml_text:
        print("  CAP: žádné výstrahy nedostupné (všechny URL selhaly)")
        return []

    return parse_cap(xml_text, lat, lon)


def _decode(el, tag: str, ns: str = "") -> str:
    """Najde text elementu s nebo bez namespace prefixu."""
    full = f"{{{CAP_NS.get(ns, ns)}}}{tag}" if ns else tag
    node = el.find(full)
    if node is None:
        # zkus bez namespace
        node = el.find(tag)
    return (node.text or "").strip() if node is not None else ""


def parse_cap(xml_text: str, lat: float, lon: float) -> list[dict]:
    """Parsuje CAP XML (jeden feed nebo kolekce alertů)."""
    now_utc = datetime.now(timezone.utc)
    warnings = []

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        print(f"  CAP parse chyba: {e}")
        return []

    # CAP feed může být Atom feed obsahující <entry> s embedded <alert>
    # nebo přímo <alert> element, nebo kolekce <alerts>
    # Najdeme všechny <alert> elementy kdekoliv ve stromu
    ns_uri = "urn:oasis:names:tc:emergency:cap:1.2"
    alert_tag = f"{{{ns_uri}}}alert"
    info_tag  = f"{{{ns_uri}}}info"

    alerts = root.findall(f".//{alert_tag}")
    if not alerts and root.tag == alert_tag:
        alerts = [root]
    if not alerts:
        # bez namespace
        alerts = root.findall(".//alert")

    for alert in alerts:
        # Každý alert může mít více <info> (jazykové verze — bereme cs nebo první)
        infos = alert.findall(f"{{{ns_uri}}}info") or alert.findall("info")
        info = None
        for i in infos:
            lang_node = i.find(f"{{{ns_uri}}}language") or i.find("language")
            if lang_node is not None and lang_node.text and "cs" in lang_node.text.lower():
                info = i
                break
        if info is None and infos:
            info = infos[0]
        if info is None:
            continue

        def get(tag):
            node = info.find(f"{{{ns_uri}}}{tag}") or info.find(tag)
            return (node.text or "").strip() if node is not None else ""

        # Platnost
        onset_s  = get("onset")
        expires_s = get("expires")
        try:
            onset   = datetime.fromisoformat(onset_s.replace("Z", "+00:00")) if onset_s else now_utc
            expires = datetime.fromisoformat(expires_s.replace("Z", "+00:00")) if expires_s else \
                      now_utc + timedelta(hours=24)
        except ValueError:
            continue

        # Platí teď?
        if not (onset <= now_utc <= expires):
            continue

        # Závažnost / typ
        severity = get("severity")   # Extreme/Severe/Moderate/Minor
        urgency  = get("urgency")
        event    = get("event")
        headline = get("headline")
        description = get("description")

        # Barva/stupeň: hledáme v parametrech nebo v názvu
        color = "unknown"
        for param in info.findall(f"{{{ns_uri}}}parameter") or info.findall("parameter"):
            pname = (param.find(f"{{{ns_uri}}}valueName") or param.find("valueName"))
            pval  = (param.find(f"{{{ns_uri}}}value")     or param.find("value"))
            if pname is not None and pval is not None:
                if "color" in (pname.text or "").lower() or "stupen" in (pname.text or "").lower():
                    color = pval.text or color

        # Fallback barva ze severity
        if color == "unknown":
            color = {"Extreme": "red", "Severe": "orange",
                     "Moderate": "yellow", "Minor": "green"}.get(severity, "unknown")

        # Oblast — bereme všechny; pro filtraci lokace použijeme heuristiku
        # (plná polygonová analýza by vyžadovala shapely — není v deps)
        areas = []
        for area in info.findall(f"{{{ns_uri}}}area") or info.findall("area"):
            aname = area.find(f"{{{ns_uri}}}areaDesc") or area.find("areaDesc")
            areas.append((aname.text or "").strip() if aname is not None else "")

        warnings.append({
            "event":       event,
            "headline":    headline,
            "severity":    severity,
            "color":       color,
            "onset_utc":   onset.isoformat(),
            "expires_utc": expires.isoformat(),
            "areas":       areas,
            "description": description[:300] if description else "",
        })

    # Seřaď: nejzávažnější první
    sev_order = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}
    warnings.sort(key=lambda w: sev_order.get(w["severity"], 9))
    print(f"  CAP: {len(warnings)} platných výstrah")
    return warnings


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

    # ── Open-Meteo minutely_15 pro NWP část ───────────────────────────────────
    m15 = om.get("minutely_15", {})
    times_m15 = m15.get("time", [])
    precip_m15 = m15.get("precipitation", [None] * len(times_m15))
    wind_m15   = m15.get("windspeed_10m",  [None] * len(times_m15))
    wdir_m15   = m15.get("winddirection_10m", [None] * len(times_m15))
    cape_m15   = m15.get("cape", [None] * len(times_m15))

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

        timeseries.append({
            "time_utc":    t.isoformat(),
            "source":      "nwp",
            "confidence":  "medium",
            "precip_mm_h": round(float(precip_m15[i]), 3) if precip_m15[i] is not None else None,
            "wind_ms":     round(float(wind_m15[i]) / 3.6, 1) if wind_m15[i] is not None else None,
            "wind_dir":    wind_m15[i] if wdir_m15 and i < len(wdir_m15) else None,
            "cape":        cape_m15[i] if cape_m15 and i < len(cape_m15) else None,
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
    forecast["warnings"] = fetch_cap_warnings(lat, lon)
    for w in forecast["warnings"]:
        print(f"  [{w['color'].upper():7s}] {w['event']} — platí do {w['expires_utc']}")

    out_path = DATA_DIR / "forecast.json"
    with open(out_path, "w") as f:
        json.dump(forecast, f, indent=2, ensure_ascii=False)
    print(f"\n✓ Fáze 3a — Fúze OK → {out_path}")
    print(f"  (verdikt bude doplněn pomocí narrate.py)")


if __name__ == "__main__":
    main()
