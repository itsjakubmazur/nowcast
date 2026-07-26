"""
Oficiální textová předpověď ČHMÚ → data/chmi_forecast.json.

Předpověď psaná meteorologem ČHMÚ. Do appky nejde jako další model — čísla
máme z ALADIN a Open-Meteo — ale jako autoritativní kontext pro AI naraci
a jako "co k tomu říká ČHMÚ" vedle našeho verdiktu.

Ověřeno sondou (běh 30219708883):
  weather/forecast/now/web_pCRntx_{DDHHMM}.json   16 kB, ~5×/den
  GeoJSON FeatureCollection, jedna featura, Polygon = celá ČR
  properties: sent, referenceTime, senderName,
              place {name, NUTS, RÚIAN},
              headline-main {headline, startTime, endTime},
              data[] {displayOrder, name, startTime, endTime, headline, displayText}

Všech osm zkoumaných souborů mělo datovyTokID
"predpovedi.meteo.kratkodoba.cr.text.noc" a place.NUTS "CZ" — je to tedy
JEDNA celostátní předpověď, ne regionální sada. Polygon proto neřešíme
point-in-polygon; ukládáme ho jen informativně.

Výstup je záměrně jen text + časy: žádné parsování vět na čísla. Rozebírat
volný text na hodnoty by přineslo tichou nepřesnost tam, kde už máme
naměřená a modelovaná data.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/meteorology/weather/forecast/now/"
FILE_RE = re.compile(r'href="(web_[A-Za-z]+_\d+\.json)"')
TIMEOUT = (10, 30)
MAX_AGE_H = 18          # starší text už neodpovídá dnešnímu dni
MAX_TEXT_CHARS = 4000   # strop na velikost výstupu

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def _dt(s):
    """ISO 8601 s 'Z' → aware datetime, nebo None."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def newest_files(limit: int = 6) -> list[str]:
    r = SESSION.get(BASE, timeout=TIMEOUT)
    r.raise_for_status()
    names = sorted(set(FILE_RE.findall(r.text)))
    return names[-limit:]


def parse(doc: dict) -> dict | None:
    feats = ((doc.get("data") or {}).get("features")) or []
    if not feats:
        return None
    props = feats[0].get("properties") or {}
    head = props.get("headline-main") or {}
    blocks = []
    for b in (props.get("data") or []):
        text = (b.get("displayText") or "").strip()
        if not text:
            continue
        blocks.append({
            "name": b.get("name"),
            "headline": (b.get("headline") or "").strip() or None,
            "text": text,
            "start_utc": b.get("startTime"),
            "end_utc": b.get("endTime"),
        })
    if not blocks:
        return None
    blocks.sort(key=lambda b: next(
        (x.get("displayOrder", 0) for x in (props.get("data") or [])
         if x.get("name") == b["name"]), 0))
    return {
        "issued_utc": props.get("sent") or doc.get("datumVytvoreni"),
        "reference_utc": props.get("referenceTime"),
        "author": (props.get("senderName") or "").strip() or None,
        "place": (props.get("place") or {}).get("name"),
        "nuts": (props.get("place") or {}).get("NUTS"),
        "headline": (head.get("headline") or "").strip() or None,
        "valid_from_utc": head.get("startTime"),
        "valid_to_utc": head.get("endTime"),
        "flow_id": doc.get("datovyTokID"),
        "blocks": blocks,
    }


def main():
    now = datetime.now(timezone.utc)
    best = None
    try:
        names = newest_files()
    except Exception as e:
        print(f"chmi_forecast.py: listing selhal ({e}) — vynechávám", file=sys.stderr)
        return

    # Od nejnovějšího zpět: bereme první, který se povede načíst a není starý.
    # Názvy nesou jen DDHHMM, takže na stáří se spolehlivěji ptáme obsahu.
    for name in reversed(names):
        try:
            r = SESSION.get(BASE + name, timeout=TIMEOUT)
            if not r.ok:
                continue
            parsed = parse(r.json())
            if not parsed:
                continue
            issued = _dt(parsed.get("issued_utc"))
            if issued and (now - issued).total_seconds() > MAX_AGE_H * 3600:
                continue
            parsed["file"] = name
            parsed["age_h"] = round((now - issued).total_seconds() / 3600, 1) if issued else None
            best = parsed
            break
        except Exception:
            continue

    if not best:
        print("chmi_forecast.py: žádná použitelná předpověď — vynechávám", file=sys.stderr)
        return

    # Strop na velikost — text je od člověka a jeho délka není zaručená.
    total = 0
    kept = []
    for b in best["blocks"]:
        if total + len(b["text"]) > MAX_TEXT_CHARS:
            break
        kept.append(b)
        total += len(b["text"])
    best["blocks"] = kept

    best["generated_at_utc"] = now.isoformat()
    best["source"] = "ČHMÚ — textová předpověď (weather/forecast/now)"
    path = DATA_DIR / "chmi_forecast.json"
    path.write_text(json.dumps(best, ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_forecast.py: {best['file']}, „{best.get('headline')}“, "
          f"{len(kept)} bloků / {total} znaků, stáří {best.get('age_h')} h")


if __name__ == "__main__":
    main()
