"""
Testy pro pipeline/metar.py — hlavně dlaždicová geometrie světových stanic.

Proč zrovna tohle: dlaždice počítá NEZÁVISLE Python (kdo do které zapíše) a
JavaScript (kterou si klient stáhne). Když se ty dva výpočty rozejdou třeba
jen o jednu dlaždici na datové hranici, appka bude tiše stahovat soubor bez
stanic a "světové stanice nefungují" — bez jediné chyby v konzoli. Proto se
tu shoda ověřuje na konkrétních místech, ne jen odhadem.

Spouštění: python tests/test_metar.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import metar  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def js_tile_id(lat, lon):
    """Doslovný přepis metarTileId() z web/js/worldstations.js."""
    tx = int((((lon + 180) % 360) + 360) % 360 / 10) % 36
    ty = min(17, max(0, int((lat + 90) // 10)))
    return f"{ty}_{tx}"


def row(**kw):
    base = {
        "station_id": "LKTB", "latitude": "49.15", "longitude": "16.69",
        "temp_c": "21.5", "dewpoint_c": "12.0", "wind_dir_degrees": "230",
        "wind_speed_kt": "10", "altim_in_hg": "29.92", "elevation_m": "241",
        "observation_time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    base.update(kw)
    return base


def main():
    now = datetime.now(timezone.utc)
    print("=== metar — dlaždice a parsování bulk CSV ===")

    # --- shoda Python vs. JS ------------------------------------------------
    places = [
        ("New York", 40.7128, -74.0060), ("Tokio", 35.68, 139.69),
        ("Sydney", -33.87, 151.21), ("Rychvald", 49.86, 18.36),
        ("Reykjavík", 64.13, -21.90), ("Lima", -12.05, -77.04),
        ("datová hranice +", 0.0, 179.9), ("datová hranice -", 0.0, -179.9),
        ("nultý poledník", 51.48, 0.0), ("jižní pól", -89.9, 10.0),
        ("severní pól", 89.9, 10.0),
    ]
    mismatch = []
    for name, lat, lon in places:
        tx, ty = metar.tile_xy(lat, lon)
        py, js = f"{ty}_{tx}", js_tile_id(lat, lon)
        if py != js:
            mismatch.append(f"{name}: py={py} js={js}")
    check("Python a JS počítají stejnou dlaždici pro všechna místa",
          not mismatch, "; ".join(mismatch))
    check("New York padne do 13_10 (shodně se smoke testem)",
          js_tile_id(40.7128, -74.0060) == "13_10", js_tile_id(40.7128, -74.0060))

    # --- rozsahy indexů -----------------------------------------------------
    bad = []
    for lat in (-90, -45, 0, 45, 89.999, 90):
        for lon in (-180, -90, -0.001, 0, 90, 179.999, 180):
            tx, ty = metar.tile_xy(lat, lon)
            if not (0 <= tx <= 35 and 0 <= ty <= 17):
                bad.append(f"({lat},{lon})→{tx},{ty}")
    check("indexy dlaždic zůstávají v rozsahu i v rozích světa",
          not bad, "; ".join(bad))

    # --- přesah -------------------------------------------------------------
    # Stanice uprostřed dlaždice patří jen do své; u kraje i do sousední.
    center = metar.tiles_for_station(45.0, 15.0)
    edge = metar.tiles_for_station(49.9, 19.9)      # roh dlaždice 40–50N/10–20E
    check("stanice uprostřed dlaždice se zapíše jen jednou",
          len(center) == 1, f"{center}")
    check("stanice u rohu se zapíše i do sousedních dlaždic",
          len(edge) >= 4, f"{edge}")
    check("bod hned za hranicí vidí stanici z vedlejší dlaždice",
          metar.tile_xy(50.1, 20.1) in edge,
          f"{metar.tile_xy(50.1, 20.1)} not in {edge}")

    # --- parsování bulk řádku ----------------------------------------------
    ok = metar.parse_bulk_row(row(), now)
    check("platný řádek se přeloží", ok is not None)
    if ok:
        check("uzly se převedou na km/h", abs(ok["wind_kmh"] - 18.5) < 0.1,
              f"{ok['wind_kmh']}")
        check("id má prefix metar-", ok["id"] == "metar-LKTB", ok["id"])
        check("vlhkost se dopočítá z rosného bodu",
              ok["humidity"] is not None and 40 <= ok["humidity"] <= 70,
              f"{ok['humidity']}")
        check("nadmořská výška se převezme", ok["elev"] == 241.0, f"{ok['elev']}")

    check("řádek bez teploty se zahodí",
          metar.parse_bulk_row(row(temp_c=""), now) is None)
    check("řádek bez souřadnic se zahodí",
          metar.parse_bulk_row(row(latitude=""), now) is None)
    old = (now - timedelta(hours=5)).isoformat().replace("+00:00", "Z")
    check("staré hlášení se zahodí",
          metar.parse_bulk_row(row(observation_time=old), now) is None)
    future = (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z")
    check("hlášení z budoucnosti se zahodí",
          metar.parse_bulk_row(row(observation_time=future), now) is None)
    check("rozbité datum se zahodí",
          metar.parse_bulk_row(row(observation_time="nesmysl"), now) is None)
    check("chybějící vítr nevadí (jen bude None)",
          (metar.parse_bulk_row(row(wind_speed_kt=""), now) or {}).get("wind_kmh") is None)

    # --- jména letišť z pole `site` ----------------------------------------
    cases = [
        ("Prague/Havel Arpt", "Prague"),
        ("New York/JF Kennedy Intl", "New York"),
        ("Tokyo/Haneda Intl", "Tokyo"),
        ("Dresden Arpt", "Dresden"),
        ("Munich Intl", "Munich"),
        ("Hof/Plauen Arpt", "Hof"),
        ("Brno/Turany", "Brno"),
        ("", None),
        ("   ", None),
    ]
    bad = [f"{inp!r}→{metar.city_from_site(inp)!r} (čekáno {exp!r})"
           for inp, exp in cases if metar.city_from_site(inp) != exp]
    check("město se vytáhne z pole site (místo ICAO kódu)", not bad, "; ".join(bad))
    check("samotný typ letiště nezůstane jako jméno",
          metar.city_from_site("Intl") in (None, ""),
          repr(metar.city_from_site("Intl")))

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy metar prošly")


if __name__ == "__main__":
    main()
