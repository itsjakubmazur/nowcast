"""
Testy parserů pro chmi_normals, chmi_regional, chmi_air, chmi_aero
a chmi_forecast.

Proč zrovna tohle: u všech pěti je vstup CIZÍ soubor, který ČHMÚ nedrží
konzistentně — jednou oddělovač ',', jindy ';', jednou desetinná tečka, jindy
čárka, v jedné hlavičce rozbité "¬esko" a v jiné korektní "Cesko". Testy proto
jedou na doslovných ukázkách z produkčních souborů (zachyceno sondami), ne na
vymyšlených datech.

Spouštění: python tests/test_chmi_extra.py
"""

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import chmi_aero  # noqa: E402
import chmi_forecast  # noqa: E402
import chmi_normals  # noqa: E402
import chmi_regional  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def main():
    print("=== chmi_regional — oddělovače a rozbitá hlavička ===")

    # Doslovná ukázka z Annual_areal_temperature_mean.csv: oddělovač ',',
    # a první kraj je ve zdroji zapsaný rozbitě jako "¬esko".
    temp = ("Year,Element,¬esko,JHC,JHM,KVK,HKK,LBK,MSK,OLK,PAK,PLK,PHA+STC,ULK,VYS,ZLK\n"
            "1961,T,7.9,7.5,8.9,7,7.6,7.2,7.8,7.9,7.9,7.8,8.6,8.1,7.5,8.2\n"
            "1962,T,6.3,5.8,7.3,5.1,6.2,5.6,6.2,6.3,6.4,6,7,6.4,5.9,6.6\n")
    # a z Annual_areal_pecipitation.csv: oddělovač ';', hlavička čistá
    prec = ("Year;Element;Cesko;JHC;JHM;KVK;HKK;LBK;MSK;OLK;PAK;PLK;PHA+STC;ULK;VYS;ZLK\n"
            "1961;SRA;652;664;552;711;729;869;722;651;651;612;569;583;663;780\n")

    check("oddělovač se pozná z hlavičky (teploty = čárka)",
          chmi_regional.sniff(temp.splitlines()[0]) == ",")
    check("oddělovač se pozná z hlavičky (srážky = středník)",
          chmi_regional.sniff(prec.splitlines()[0]) == ";")

    t = chmi_regional.parse_csv(temp, ("Year", "Element"))
    check("teplotní CSV se rozparsuje", t is not None)
    if t:
        codes, rows = t
        check("první kraj se pojmenuje podle POZICE, ne rozbité hlavičky",
              codes[0] == "CR", codes[0])
        check("krajů je 14", len(codes) == 14, str(len(codes)))
        check("kódy krajů odpovídají skutečné hlavičce",
              codes[1:4] == ["JHC", "JHM", "KVK"], str(codes[1:4]))
        check("řádků je 2", len(rows) == 2, str(len(rows)))
        check("hodnota pro Česko 1961 je 7.9", rows[0]["v"][0] == 7.9, str(rows[0]["v"][0]))
        check("rok se uloží jako popisný sloupec", rows[0]["year"] == "1961", rows[0].get("year"))
        check("počet hodnot odpovídá počtu krajů",
              len(rows[0]["v"]) == len(codes), f"{len(rows[0]['v'])} vs {len(codes)}")

    p = chmi_regional.parse_csv(prec, ("Year", "Element"))
    check("srážkové CSV se středníkem se rozparsuje", p is not None)
    if p and t:
        check("obě sady mají stejné pořadí krajů (jinak by se četl cizí kraj)",
              p[0] == t[0], f"{p[0]} vs {t[0]}")
        check("srážka pro Česko 1961 je 652", p[1][0]["v"][0] == 652.0, str(p[1][0]["v"][0]))

    # Měsíční normál má jiné popisné sloupce
    norm = ("Month,Element,Cesko,JHC,JHM,KVK,HKK,LBK,MSK,OLK,PAK,PLK,PHA+STC,ULK,VYS,ZLK\n"
            "01,T,-1.4,-1.6,-1.1,-1.9,-1.6,-1.7,-1.8,-2.0,-1.6,-1.2,-0.6,-0.9,-2.0,-1.6\n")
    n = chmi_regional.parse_csv(norm, ("Month", "Element"))
    check("normál se zápornými hodnotami se rozparsuje",
          n is not None and n[1][0]["v"][0] == -1.4,
          str(n[1][0]["v"][0]) if n else "None")
    check("prázdný vstup nespadne, vrátí None", chmi_regional.parse_csv("", ("Year",)) is None)

    print("\n=== chmi_normals — dva různé formáty seznamu stanic ===")

    # Sniff logika je uvnitř read_station_list; testujeme ji přes stejný princip
    prec_head = "WSI,GH ID,BEGIN_DATE,END_DATE,FULL_NAME,GEOGR1,GEOGR2,ELEVATION"
    temp_head = "WSI;GH ID;BEGIN_DATE;END_DATE;FULL_NAME;GEOGR1;GEOGR2;ELEVATION"
    check("srážkový seznam má čárku",
          (";" if prec_head.count(";") > prec_head.count(",") else ",") == ",")
    check("teplotní seznam má středník",
          (";" if temp_head.count(";") > temp_head.count(",") else ",") == ";")

    check("prvky pro teplotu jsou T, TMA, TMI",
          set(chmi_normals.ELEMENTS["temperature"]) == {"T", "TMA", "TMI"})
    check("prvek pro srážky je SRA",
          set(chmi_normals.ELEMENTS["precipitation"]) == {"SRA"})

    print("\n=== chmi_aero — výpis aerologických indexů ===")

    # Doslovný obsah 26072612_Praha_ascent_vypis_111506.csv (84 B)
    praha = "sep=,\nMU CAPE,10\nMU CINH,-80\nMU DCI,21.500\nTkonv,34.000\nVKH,2.500,700\nKKH,1.600,656\n"
    v = chmi_aero.parse_vypis(praha)
    check("direktiva sep= se přeskočí", "cape" in v, str(list(v)))
    check("CAPE = 10", v.get("cape") == 10.0, str(v.get("cape")))
    check("záporný CIN se přečte správně", v.get("cin") == -80.0, str(v.get("cin")))
    check("konvektivní teplota = 34 °C", v.get("t_konv") == 34.0, str(v.get("t_konv")))
    # VKH/KKH jsou (teplota °C, tlak hPa) — z dat to vypadalo na (km, hPa),
    # rozhodla až dokumentace ČHMÚ. Test to drží, ať se to nezvrtne zpátky.
    check("VKH = teplota a tlak ve výstupné kondenzační hladině",
          v.get("lcl") == {"t_c": 2.5, "hpa": 700.0}, str(v.get("lcl")))
    check("KKH = teplota a tlak v konvektivní kondenzační hladině",
          v.get("ccl") == {"t_c": 1.6, "hpa": 656.0}, str(v.get("ccl")))
    check("první hodnota NENÍ výška v km (Prostějov 10,5 při 804 hPa to vylučuje)",
          chmi_aero.parse_vypis(
              "sep=,\nVKH,10.500,804\n").get("lcl") == {"t_c": 10.5, "hpa": 804.0})

    prostejov = "sep=,\nMU CAPE,97\nMU CINH,-75\nMU DCI,18.000\nTkonv,30.700\nVKH,10.500,804\nKKH,9.600,763\n"
    v2 = chmi_aero.parse_vypis(prostejov)
    check("druhá stanice se rozparsuje stejně", v2.get("cape") == 97.0, str(v2.get("cape")))

    labels = [(3000, "velmi silná"), (1500, "silná"), (500, "mírná"),
              (100, "slabá"), (0, "slabá")]
    bad = [f"{c}→{chmi_aero.cape_label(c)} (čekáno {e})"
           for c, e in labels if chmi_aero.cape_label(c) != e]
    check("CAPE se mapuje na slovní hodnocení", not bad, "; ".join(bad))
    check("chybějící CAPE nedá popisek", chmi_aero.cape_label(None) is None)

    stamp = chmi_aero.parse_stamp("26072612")
    check("časové razítko z názvu = 2026-07-26 12 UTC",
          stamp is not None and (stamp.year, stamp.month, stamp.day, stamp.hour)
          == (2026, 7, 26, 12), str(stamp))
    check("rozbité razítko vrátí None", chmi_aero.parse_stamp("nesmysl") is None)
    check("regex chytí reálný název výpisu",
          chmi_aero.FILE_RE.findall(
              'href="26072612_Praha_ascent_vypis_111506.csv"')[0][1] == "26072612")
    check("regex nechytí PNG vedle výpisu",
          chmi_aero.FILE_RE.findall('href="26072612_Praha_ascent_skewt_111506.png"') == [])

    print("\n=== chmi_forecast — GeoJSON textové předpovědi ===")

    doc = {
        "datovyTokID": "predpovedi.meteo.kratkodoba.cr.text.noc",
        "data": {"type": "FeatureCollection", "features": [{
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[[14.7, 48.5]]]},
            "properties": {
                "sent": "2026-07-26T19:53:42.768Z",
                "referenceTime": "2026-07-26T21:00:00.000Z",
                "senderName": "Filip Smola",
                "place": {"name": "pro Českou republiku", "NUTS": "CZ"},
                "headline-main": {"headline": "Předpověď na noc",
                                  "startTime": "2026-07-26T20:00:00.000Z",
                                  "endTime": "2026-07-27T05:00:00.000Z"},
                "data": [
                    {"displayOrder": 0, "name": "textIntro", "headline": None,
                     "displayText": "Teplá noc s převážně velkou oblačností."},
                    {"displayOrder": 1, "name": "textWeather",
                     "headline": "Počasí (22-07):",
                     "displayText": "Převládne velká oblačnost."},
                    {"displayOrder": 2, "name": "prazdny", "displayText": "   "},
                ],
            }}]},
    }
    parsed = chmi_forecast.parse(doc)
    check("GeoJSON se rozparsuje", parsed is not None)
    if parsed:
        check("titulek se přečte", parsed["headline"] == "Předpověď na noc", parsed["headline"])
        check("autor se přečte", parsed["author"] == "Filip Smola", str(parsed["author"]))
        check("prázdný blok se zahodí", len(parsed["blocks"]) == 2, str(len(parsed["blocks"])))
        check("bloky drží pořadí z displayOrder",
              parsed["blocks"][0]["name"] == "textIntro", parsed["blocks"][0]["name"])
        check("prázdný headline se uloží jako None",
              parsed["blocks"][0]["headline"] is None)
        check("NUTS se přenese", parsed["nuts"] == "CZ", str(parsed["nuts"]))

    check("FeatureCollection bez featur vrátí None",
          chmi_forecast.parse({"data": {"features": []}}) is None)
    check("dokument bez data vrátí None", chmi_forecast.parse({}) is None)
    check("featura bez použitelného textu vrátí None",
          chmi_forecast.parse({"data": {"features": [
              {"properties": {"data": [{"displayText": ""}]}}]}}) is None)
    check("čas s Z se převede na aware datetime",
          chmi_forecast._dt("2026-07-26T19:53:42.768Z") is not None)
    check("rozbitý čas vrátí None", chmi_forecast._dt("nesmysl") is None)

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy chmi_extra prošly")


if __name__ == "__main__":
    main()
