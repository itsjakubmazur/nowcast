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
from concurrent.futures import ThreadPoolExecutor
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
    "euro_stations.json": 6,
    "imgw_coords.json": 24 * 365,   # číselník souřadnic, mění se výjimečně
    "chmi_air.json": 6,
    "chmi_aero.json": 24,
    "chmi_forecast.json": 24,
    "chmi_regional.json": 24 * 30,

    # Tyhle chyběly, přestože je fast běh taky nevyrábí. Byly jen v cache
    # Actions — a cache je přesně to, čemu tenhle modul nevěří (viz docstring).
    # Při výpadku cache se publikovaly jako chybějící a appka o ně přišla.
    #
    # U wu_history.json to bylo nejhorší: další full běh si historii natahuje
    # z Pages (load_wu_history), takže když tam nebyla, začal od nuly. Historie
    # vlastních stanic se tím pravidelně mazala a nikdy nenarostla.
    "wu_history.json": 24,
    # chmi_series_index.json tady SCHVÁLNĚ NENÍ. Byl a rozbilo to detail
    # stanice: smyčka nad CARRY běží dřív než carry_tiles, stáhla index —
    # a carry_series() se pak podle jeho existence rozhodl, že už je hotovo,
    # takže per-stanicové soubory nepřenesl ani jeden. Web měl rejstřík
    # tvrdící "292 stanic" a k němu 404 na každou z nich.
    # Index i soubory proto vlastní JEDNA funkce.
    "wind_grid.json": 6,
    "chmi_fct.json": 6,
    "echotop.json": 6,
    "chmi_air_map.json": 6,
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


def carry_dir(name, index_name="index.json", ids_from=None, workers=8):
    """
    Přenese CELÝ adresář dlaždic z posledního nasazení.

    Původně to přenášelo jen index a jednotlivé dlaždice nechávalo na kliento-
    vi s tím, že 404 umí. Jenže klient index bere jako závaznou informaci
    o tom, co existuje (právě proto, aby na neexistující dlaždice nesahal),
    takže po fast běhu "věděl" o třech stovkách dlaždic a nedostal ani jednu.
    Vrstva teplot pak byla prázdná — ne chybou frontendu, ale proto, že se
    tam data nedostala.

    Druhá, tišší chyba: rejstřík je pole OBJEKTŮ {"tile": "9_18", "count": 42},
    ne pole řetězců. Smyčka ho procházela jako řetězce, takže se URL skládala
    ze str(dict) a každý požadavek skončil 404. Přeneslo se tedy nula dlaždic
    a v logu stálo poctivé "0/313", čehož si nikdo nevšiml.
    """
    d = DATA_DIR / name
    if (d / index_name).exists():
        return 0
    try:
        r = SESSION.get(f"{PAGES}/{name}/{index_name}", timeout=TIMEOUT)
        if not r.ok:
            return 0
        idx = r.json()
        ids = [(t.get("tile") if isinstance(t, dict) else t)
               for t in ((ids_from(idx) if ids_from else idx.get("tiles")) or [])]
        ids = [i for i in ids if i]
        d.mkdir(parents=True, exist_ok=True)
        (d / index_name).write_text(json.dumps(idx, ensure_ascii=False,
                                               separators=(",", ":")))

        def one(tid):
            try:
                rt = SESSION.get(f"{PAGES}/{name}/{tid}.json", timeout=TIMEOUT)
                if rt.ok:
                    (d / f"{tid}.json").write_bytes(rt.content)
                    return True
            except Exception:
                pass
            return False

        # Sériově by tři stovky souborů trvaly déle než celý fast běh.
        with ThreadPoolExecutor(max_workers=workers) as ex:
            got = sum(1 for ok in ex.map(one, ids) if ok)

        print(f"  {name}/: přeneseno {got}/{len(ids)}")
        if ids and got == 0:
            print(f"  {name}/: NEPŘENESLA SE ANI JEDNA — rejstřík slibuje "
                  f"{len(ids)} položek, web nevrací žádnou", file=sys.stderr)
        return got
    except Exception as e:
        print(f"  {name}/: {str(e)[:120]}", file=sys.stderr)
        return 0


def carry_series():
    """
    Per-stanicové řady ČHMÚ. Index leží mimo adresář (chmi_series_index.json)
    a stanice jsou v něm klíče slovníku, ne pole — proto vlastní funkce
    a ne carry_dir.

    Tohle je historie: když zmizí, nezmizí obrázek, ale měsíce měření.
    """
    idx_path = DATA_DIR / "chmi_series_index.json"
    d = DATA_DIR / "chmi_series"
    # Rozhoduje přítomnost DAT, ne rejstříku. Rejstřík sám o sobě nestačí:
    # appka podle něj nabídne stanice, ale detail každé z nich skončí 404.
    if d.exists() and any(d.glob("*.json")):
        return 0
    try:
        r = SESSION.get(f"{PAGES}/chmi_series_index.json", timeout=TIMEOUT)
        if not r.ok:
            return 0
        idx = r.json()
        ids = list((idx.get("stations") or {}).keys())
        idx_path.write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")))
        d.mkdir(parents=True, exist_ok=True)

        def one(sid):
            safe = sid.replace("/", "_")        # stejná sanitizace jako v chmi.py
            try:
                rt = SESSION.get(f"{PAGES}/chmi_series/{safe}.json", timeout=TIMEOUT)
                if rt.ok:
                    (d / f"{safe}.json").write_bytes(rt.content)
                    return True
            except Exception:
                pass
            return False

        with ThreadPoolExecutor(max_workers=8) as ex:
            got = sum(1 for ok in ex.map(one, ids) if ok)
        print(f"  chmi_series/: přeneseno {got}/{len(ids)}")
        if ids and got == 0:
            print("  chmi_series/: NEPŘENESLA SE ANI JEDNA — historie stanic "
                  "se po tomhle běhu z webu ztratí", file=sys.stderr)
        return got
    except Exception as e:
        print(f"  chmi_series/: {str(e)[:120]}", file=sys.stderr)
        return 0


def carry_tiles(now):
    """Adresáře, které fast běh nevyrábí: dlaždice, řady a dlouhá historie."""
    return (carry_dir("metar")
            + carry_series()
            # Dlouhá měsíční historie stanic. Rejstřík má pole ID pod
            # "stations", ne "tiles".
            + carry_dir("chmi_history", ids_from=lambda i: i.get("stations")))


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
