"""
Doplní do data/ soubory, které tenhle běh nevyrobil, z posledního nasazení.

PROČ TO EXISTUJE — konkrétní chyba, kterou to řeší:

Pipeline se střídá mezi režimy full a fast (podle minuty). Fast běh záměrně
přeskakuje stanice, ALADIN a další pomalé kroky, aby radar mohl jet po pěti
minutách. Pro tyhle soubory se spoléhalo na cache GitHub Actions.

Jenže deploy publikuje CELÝ adresář data/ jako nový obsah webu. Když cache
neobnovila (a to se dělo), fast běh vyrobil jen radar a mřížku — a nasadil je
jako kompletní sadu. Výsledek: web každých druhých pět minut ztratil stanice,
ALADIN i METAR. V aplikaci se to projevilo jako "v okruhu 40 km není čerstvě
hlásící meteostanice" a chybějící ALADIN v žebříčku modelů, což vypadalo jako
chyba ve frontendu, ale bylo to prázdné místo v datech.

Cache tu není spolehlivý základ: může vypršet, minout se klíčem nebo se
nenaplnit. Poslední NASAZENÁ verze webu je naopak vždycky po ruce a je z
definice tím posledním, co uživatelé viděli. Bereme ji tedy jako zdroj
"posledního známého dobrého stavu" — stejný postup, jaký už používá
windgrid.py na lepení děr.

Pouští se těsně před validací a uploadem artefaktu.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
PAGES = "https://itsjakubmazur.github.io/nowcast/data"
TIMEOUT = (10, 30)

# Soubory, které fast běh nevyrábí. Ke každému maximální stáří, po kterém už
# nemá smysl je přenášet — radši ať panel v appce zmizí, než aby ukazoval
# včerejší teploty jako aktuální.
CARRY = {
    "chmi_stations.json": 6,
    "chmi_rain.json": 6,
    "metar_stations.json": 6,
    "metar_names.json": 24 * 30,
    "metar_history.json": 24,
    "wu_stations.json": 6,
    "aladin.json": 24,
    "hydro.json": 12,
    "accuracy.json": 24 * 7,
    "accuracy_precip.json": 24 * 7,
    "chmi_stats.json": 24 * 14,
    "chmi_normals.json": 24 * 365,     # statické normály 1991–2020
    "chmi_air.json": 6,
    "chmi_aero.json": 24,
    "chmi_forecast.json": 24,
    "chmi_regional.json": 24 * 30,
}

# Pole, ve kterých bývá čas vzniku. Různé moduly to pojmenovaly různě.
TIME_KEYS = ("generated_at_utc", "run_utc", "updated_at_utc", "obs_utc", "built_utc")

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def age_hours(doc, now):
    """Stáří dokumentu v hodinách, nebo None když se nedá zjistit."""
    for k in TIME_KEYS:
        v = doc.get(k) if isinstance(doc, dict) else None
        if not v:
            continue
        try:
            t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            continue
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (now - t).total_seconds() / 3600
    return None


def carry_tiles(now):
    """
    Světové dlaždice METAR jsou adresář, ne jeden soubor. Přenáší se jen
    index — jednotlivé dlaždice si klient dotáhne líně a 404 na dlaždici
    umí (gate přes index.json), takže nemá cenu tahat stovky souborů.
    """
    tiles_dir = DATA_DIR / "metar"
    if (tiles_dir / "index.json").exists():
        return 0
    try:
        r = SESSION.get(f"{PAGES}/metar/index.json", timeout=TIMEOUT)
        if not r.ok:
            return 0
        idx = r.json()
        ids = idx.get("tiles") or []
        tiles_dir.mkdir(parents=True, exist_ok=True)
        (tiles_dir / "index.json").write_text(json.dumps(idx, ensure_ascii=False,
                                                         separators=(",", ":")))
        got = 0
        for tid in ids:
            try:
                rt = SESSION.get(f"{PAGES}/metar/{tid}.json", timeout=TIMEOUT)
                if rt.ok:
                    (tiles_dir / f"{tid}.json").write_bytes(rt.content)
                    got += 1
            except Exception:
                continue
        print(f"  metar/: přeneseno {got}/{len(ids)} dlaždic")
        return got
    except Exception as e:
        print(f"  metar/: {str(e)[:120]}", file=sys.stderr)
        return 0


def main():
    now = datetime.now(timezone.utc)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    carried = kept = missing = stale = 0
    for name, max_age_h in CARRY.items():
        path = DATA_DIR / name
        if path.exists():
            kept += 1
            continue
        try:
            r = SESSION.get(f"{PAGES}/{name}", timeout=TIMEOUT)
            if not r.ok:
                missing += 1
                continue
            doc = r.json()
        except Exception as e:
            print(f"  {name}: {str(e)[:100]}", file=sys.stderr)
            missing += 1
            continue

        age = age_hours(doc, now)
        if age is not None and age > max_age_h:
            # Zastaralé se NEPŘENÁŠÍ. Chybějící panel je poctivější než
            # panel, který tváří včerejší měření jako aktuální.
            print(f"  {name}: z minula, ale starý {age:.1f} h (limit {max_age_h}) — nechávám chybět")
            stale += 1
            continue

        path.write_bytes(r.content)
        carried += 1
        print(f"  {name}: přeneseno z minula"
              + (f" (stáří {age:.1f} h)" if age is not None else ""))

    tiles = carry_tiles(now)
    print(f"carry_over.py: {kept} z tohoto běhu, {carried} přeneseno, "
          f"{stale} zastaralých vynecháno, {missing} nedostupných, {tiles} dlaždic")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Tenhle krok nesmí zastavit deploy — bez něj je web jen chudší.
        print(f"carry_over.py selhalo: {e}", file=sys.stderr)
