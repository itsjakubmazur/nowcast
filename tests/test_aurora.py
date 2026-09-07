"""
Testy pro pipeline/aurora.py — parser Kp řady NOAA SWPC.

Proč zrovna tohle: modul čte tabulku, kde jsou data v poli polí a význam
sloupců nese jen hlavička. Když se sloupce prohodí nebo přibude nový, indexy
se posunou a do panelu poteče jiné číslo — bez jediné výjimky v logu. Tichá
záměna Kp za `station_count` je přesně ten druh chyby, který se pozná až
podle toho, že appka slibuje polární záři nad Brnem.

Testy proto tlačí hlavně na to, co je na zdroji křehké:
  - sloupce se hledají podle JMÉNA, ne podle pořadí,
  - přípony "2P"/"2M" a nečíselné buňky nesmí projít jako číslo,
  - hodnoty mimo definiční obor 0–9 se zahazují,
  - předpovědní a pozorovaná řada se slévají tak, že autoritativní typ
    (observed/estimated/predicted) vyhrává nad doplňkem.

Spouštění: python tests/test_aurora.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import aurora  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def test_kp_value():
    print("=== kp_value — buňka na číslo ===")
    check("celé číslo", aurora.kp_value("2") == 2.0)
    check("třetina", aurora.kp_value("2.33") == 2.33)
    check("přípona P (předběžné) se ignoruje", aurora.kp_value("2P") == 2.0)
    check("přípona M (dopočtené) se ignoruje", aurora.kp_value("5M") == 5.0)
    check("číslo v čísle", aurora.kp_value(4) == 4.0)
    check("prázdno je None", aurora.kp_value("") is None)
    check("None je None", aurora.kp_value(None) is None)
    check("text je None", aurora.kp_value("null") is None)
    # Definiční obor Kp je 0–9. Vyšší číslo znamená, že čteme jiný sloupec
    # (např. station_count nebo a_running), ne rekordní bouři.
    check("nad 9 se zahodí", aurora.kp_value("27") is None,
          f"dostal {aurora.kp_value('27')}")
    check("záporné se zahodí", aurora.kp_value("-1") is None)


def test_columns():
    print("=== columns — sloupce podle jména, ne podle pořadí ===")
    wanted = {"t": ["time_tag"], "kp": ["kp", "kp_index"], "kind": ["observed"]}

    idx = aurora.columns(["time_tag", "kp", "observed", "noaa_scale"], wanted)
    check("běžná hlavička", idx == {"t": 0, "kp": 1, "kind": 2}, str(idx))

    # Tohle je ta chyba, kvůli které test existuje: kdyby NOAA vložila sloupec
    # dopředu, pevné indexy by četly čas jako Kp.
    idx = aurora.columns(["source", "time_tag", "kp", "observed"], wanted)
    check("vložený sloupec neposune význam", idx == {"t": 1, "kp": 2, "kind": 3}, str(idx))

    idx = aurora.columns(["Time_Tag", "Kp_Index"], wanted)
    check("velikost písmen nerozhoduje", idx == {"t": 0, "kp": 1}, str(idx))

    idx = aurora.columns(["time_tag", "a_running", "station_count"], wanted)
    check("chybějící Kp se nepředstírá", "kp" not in idx, str(idx))


def test_parse_time():
    print("=== parse_time — NOAA posílá UTC bez značky zóny ===")
    t = aurora.parse_time("2026-09-05 12:00:00")
    check("tvar NOAA", t == datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc), str(t))
    check("čas je aware v UTC", t is not None and t.tzinfo is timezone.utc)
    check("ISO se taky vezme",
          aurora.parse_time("2026-09-05T12:00:00Z")
          == datetime(2026, 9, 5, 12, 0, tzinfo=timezone.utc))
    check("nesmysl je None", aurora.parse_time("včera") is None)


def test_series_from(monkeyed):
    print("=== series_from — tabulka na řadu bodů ===")
    rows = [
        ["time_tag", "kp", "observed", "noaa_scale"],
        ["2026-09-05 00:00:00", "2", "observed", None],
        ["2026-09-05 03:00:00", "3.33", "estimated", None],
        ["2026-09-05 06:00:00", "5", "predicted", "G1"],
        ["2026-09-05 09:00:00", "", "predicted", None],      # prázdná buňka
        ["2026-09-05 12:00:00", "null", "predicted", None],  # nečíselná buňka
        ["nesmysl", "4", "predicted", None],                 # rozbitý čas
    ]
    monkeyed(rows)
    got = aurora.series_from(
        "http://test/forecast",
        {"t": ["time_tag"], "kp": ["kp"], "kind": ["observed"]},
        "predicted",
    )
    check("prošly jen použitelné řádky", len(got) == 3, f"{len(got)} bodů")
    check("Kp se převedlo", [p["kp"] for p in got] == [2.0, 3.33, 5.0],
          str([p["kp"] for p in got]))
    check("typ se přečetl ze sloupce",
          [p["kind"] for p in got] == ["observed", "estimated", "predicted"],
          str([p["kind"] for p in got]))
    check("body jsou seřazené", [p["dt"] for p in got] == sorted(p["dt"] for p in got))

    # Pozorovaná řada nemá sloupec `observed` — typ se musí vzít z výchozí
    # hodnoty, ne zůstat prázdný.
    monkeyed([
        ["time_tag", "Kp", "a_running", "station_count"],
        ["2026-09-05 00:00:00", "2", "7", "8"],
    ])
    got = aurora.series_from(
        "http://test/observed", {"t": ["time_tag"], "kp": ["kp"]}, "observed",
    )
    check("bez sloupce typu se vezme výchozí",
          len(got) == 1 and got[0]["kind"] == "observed", str(got))
    # station_count = 8 je v mezích 0–9. Kdyby se sloupce četly podle pořadí,
    # prošlo by to jako Kp 7 nebo 8 a nikdo by si nevšiml.
    check("Kp je z Kp sloupce, ne ze sousedního", got[0]["kp"] == 2.0, str(got))


def test_normalize_obou_tvaru(monkeyed):
    print("=== normalize — oba tvary odpovědi ===")
    # Tvar A: pole polí s hlavičkou (jak to popisuje dokumentace NOAA).
    a = aurora.normalize([
        ["time_tag", "kp", "observed"],
        ["2026-09-05 00:00:00", "2", "observed"],
    ])
    check("pole polí se spáruje s hlavičkou",
          a == [{"time_tag": "2026-09-05 00:00:00", "kp": "2", "observed": "observed"}], str(a))

    # Tvar B: pole slovníků. Tohle sonda našla na živém zdroji (běh
    # 34157627666) — parser na něm padal, protože čekal jen tvar A.
    b = aurora.normalize([
        {"time_tag": "2026-09-05 00:00:00", "kp_index": 2, "observed": "observed"},
    ])
    check("pole slovníků projde beze změny významu",
          b == [{"time_tag": "2026-09-05 00:00:00", "kp_index": 2, "observed": "observed"}], str(b))

    c = aurora.normalize([{"Time_Tag": "2026-09-05 00:00:00", "Kp_Index": 2}])
    check("klíče se snižují na malá písmena", "time_tag" in c[0] and "kp_index" in c[0], str(c))

    # Kratší řádek než hlavička nesmí shodit celý převod.
    d = aurora.normalize([["time_tag", "kp", "observed"], ["2026-09-05 00:00:00", "2"]])
    check("kratší řádek se převezme, co jde", d == [{"time_tag": "2026-09-05 00:00:00", "kp": "2"}], str(d))


def test_series_from_slovniky(monkeyed):
    print("=== series_from — nad polem slovníků ===")
    monkeyed([
        {"time_tag": "2026-09-05 00:00:00", "kp_index": 2, "observed": "observed"},
        {"time_tag": "2026-09-05 03:00:00", "kp_index": 5.33, "observed": "predicted"},
        {"time_tag": "2026-09-05 06:00:00", "kp_index": None, "observed": "predicted"},
    ])
    got = aurora.series_from(
        "http://test/x",
        {"t": ["time_tag"], "kp": ["kp", "kp_index"], "kind": ["observed"]},
        "predicted",
    )
    check("prošly použitelné řádky", len(got) == 2, f"{len(got)}")
    check("Kp se vzalo z kp_index", [p["kp"] for p in got] == [2.0, 5.33],
          str([p["kp"] for p in got]))
    check("typ se přečetl", [p["kind"] for p in got] == ["observed", "predicted"],
          str([p["kind"] for p in got]))


def test_parse_time_je_vzdy_aware():
    print("=== parse_time — časová zóna se nesmí ztratit ===")
    # Živý zdroj posílá ISO BEZ zóny. Naivní datum by v main() spadlo na
    # porovnání s datetime.now(timezone.utc) — a protože je krok v pipeline
    # fail-soft, projevilo by se to jen tím, že panel nikdy nenaskočí.
    for raw in ("2026-08-31T00:00:00", "2026-08-31 00:00:00", "2026-08-31T00:00:00Z",
                "2026-08-31T00:00:00+00:00"):
        t = aurora.parse_time(raw)
        check(f"{raw} je aware", t is not None and t.utcoffset() is not None, str(t))
        check(f"{raw} má správnou hodnotu",
              t == datetime(2026, 8, 31, 0, 0, tzinfo=timezone.utc), str(t))


def test_main_end_to_end(monkeyed, tmpdir):
    print("=== main — celý průchod na skutečném tvaru zdroje ===")
    # Tvar je doslovná kopie toho, co vrací živý zdroj (ověřeno sondou,
    # běh 34157851723). Tenhle test tu je proto, že unit testy zkoušely jen
    # jednotlivé funkce — a chyba s naivním datem seděla přesně mezi nimi,
    # v main(). Testovat kusy a nikdy celek znamená minout právě ty chyby,
    # které vzniknou na jejich rozhraní.
    ted = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    zaklad = ted - timedelta(hours=24)
    rada = []
    for i in range(16):
        t = zaklad + timedelta(hours=3 * i)
        rada.append({
            "time_tag": t.strftime("%Y-%m-%dT%H:%M:%S"),   # BEZ zóny, jako NOAA
            "kp": 3.0 if t <= ted else 5.0,
            "observed": "observed" if t <= ted else "predicted",
            "noaa_scale": None,
        })
    monkeyed(rada)

    puvodni = aurora.DATA_DIR
    aurora.DATA_DIR = tmpdir
    try:
        rc = aurora.main()
    finally:
        aurora.DATA_DIR = puvodni

    check("main proběhl bez chyby", rc == 0, f"návratový kód {rc}")
    soubor = tmpdir / "aurora.json"
    check("zapsal se aurora.json", soubor.exists())
    if not soubor.exists():
        return

    out = json.loads(soubor.read_text())
    check("řada není prázdná", len(out.get("series") or []) > 0, str(len(out.get("series") or [])))
    check('„teď“ je měřený bod, ne předpověď',
          out.get("now") and out["now"]["kind"] != "predicted", str(out.get("now")))
    check("špička dopředu se našla",
          out.get("peak_next") and out["peak_next"]["kp"] == 5.0, str(out.get("peak_next")))
    check("časy jsou v UTC s Z",
          all(p["t"].endswith("Z") for p in out["series"]), out["series"][0]["t"])
    check("krok je hlášený jako 3 h", out.get("cadence_h") == 3, str(out.get("cadence_h")))
    check("zdroj je uvedený", bool(out.get("source")), str(out.get("source")))


def test_broken_shapes(monkeyed):
    print("=== series_from — rozbité odpovědi shoří nahlas ===")
    for name, payload in [
        ("prázdné pole", []),
        ("jen hlavička", [["time_tag", "kp"]]),
        ("slovník místo tabulky", {"kp": 3}),
        ("řádky nejsou pole", ["a", "b"]),
    ]:
        monkeyed(payload)
        try:
            aurora.series_from("http://test/x", {"t": ["time_tag"], "kp": ["kp"]}, "observed")
            check(name, False, "nevyhodilo výjimku")
        except (ValueError, TypeError, AttributeError):
            check(name, True)

    # Hlavička bez Kp je horší než chybějící soubor: vypadá jako platná data.
    monkeyed([["time_tag", "a_running"], ["2026-09-05 00:00:00", "7"]])
    try:
        aurora.series_from("http://test/x", {"t": ["time_tag"], "kp": ["kp"]}, "observed")
        check("hlavička bez Kp", False, "nevyhodilo výjimku")
    except ValueError:
        check("hlavička bez Kp", True)


def main():
    # Odstínění sítě: fetch_rows je jediné místo, kudy modul chodí ven.
    payload = {"rows": []}

    def monkeyed(rows):
        payload["rows"] = rows

    def fake_fetch(url):
        return payload["rows"]

    aurora.fetch_rows = fake_fetch

    test_kp_value()
    test_columns()
    test_parse_time()
    test_parse_time_je_vzdy_aware()
    test_series_from(monkeyed)
    test_normalize_obou_tvaru(monkeyed)
    test_series_from_slovniky(monkeyed)
    test_broken_shapes(monkeyed)
    with tempfile.TemporaryDirectory() as d:
        test_main_end_to_end(monkeyed, Path(d))

    print()
    if FAILS:
        print(f"❌ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        return 1
    print("✅ aurora — všechny testy prošly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
