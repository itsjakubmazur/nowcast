# Rozšíření nowcastu o nevyužitá open data ČHMÚ

**Datum:** 2026‑07‑26 · **Stav ověření:** všechna čísla níže pocházejí z měření na
GitHub runneru, ne z dokumentace. Sondy: běhy `30218798328` (kolo 1),
`30219100244` (kolo 2), `30219188301` (kolo 3), `30219251405` (kolo 4),
workflow `.github/workflows/probe-sources.yml`, skript `pipeline/probe_stations.py`.

Sondy běžely z CI schválně: sandbox, ve kterém píšu kód, má na `opendata.chmi.cz`
proxy s 403, takže „ověřeno“ tady vždycky znamená „stáhnuto na runneru a vypsáno
do logu“.

---

## Nejdřív tři opravy k zadání

Tři věci ze zadaného inventáře měřením neseděly. Píšu je dopředu, protože mění
priority.

1. **Identifikátory stanic nejsou výhradně `0-20000-0-11xxx`.** Vedle 40 mezinárodně
   vyměňovaných stanic je v `climate/now/` dalších **436 stanic s prefixem `0-203-0-`**
   (národní síť). Appka je už používá — 296 teplotních a 436 srážkoměrných.
2. **ČHMÚ nemá celosvětová data.** Všech 476 stanic leží v rozsahu
   48,62–51,02 °N / 12,18–18,83 °E. Nula stanic mimo ČR. Světová data v appce
   proto jedou přes NOAA METAR (5097 stanic), ne přes ČHMÚ.
3. **Blesky v open datech nejsou.** Ověřeno dvakrát, prefix‑agnosticky:
   `meteorology/weather/` obsahuje `alerts, forecast, forecast_maps_bio,
   forecast_monthly, nwp_aladin, radar, radiosounding, satellite, wind_profiles`,
   `meteorology/` obsahuje `climate, floods, phenology, products, weather`.
   Žádná shoda na `blesk|light|celdn|sferic|storm`. Blitzortung zůstává jediný zdroj.

---

## 1. Tabulka využito / nevyužito

### Využito (ověřeno grepem přes `pipeline/` a `workers/`)

| Větev opendata | Modul | K čemu |
|---|---|---|
| `meteorology/weather/radar/composite/maxz/hdf5/` | `ingest.py:22` | pohybové pole pro pysteps |
| `meteorology/weather/radar/composite/merge1h/hdf5/` | `ingest.py:25` | QPE startovní pole (radar+srážkoměry) |
| `meteorology/weather/alerts/cap/` | `fuse.py:21` | SIVS výstrahy + polygony |
| `meteorology/weather/nwp_aladin/CZ_1km/` | `aladin.py:33` | ALADIN 1 km, 48 h, do žebříčku modelů |
| `meteorology/climate/now/` | `chmi.py:24`, `chmi_rain.py:37` | 296 teplotních + 436 srážkoměrných stanic |
| `meteorology/climate/{recent,historical}/data/` | `chmi_stats.py:38` | rekordy/normály — **jen 40 stanic** |
| `hydrology/now/` | `hydro.py:33` | hlásné profily, stavy a průtoky |

### Nevyužito

Kadence a stáří jsou naměřené hodnoty z `Last-Modified` v okamžik sondy.

| Větev | Kadence | Latence | Velikost | Formát | Poznámka |
|---|---|---|---|---|---|
| `radar/composite/fct_maxz/hdf5/` | 5 min | **1 min** | 460 kB tar | 6× ODIM HDF5 | **vlastní nowcast ČHMÚ, ft10–ft60** |
| `radar/composite/fct_pseudocappi2km/hdf5/` | 5 min | 1 min | 350 kB tar | 6× ODIM HDF5 | totéž nad CAPPI 2 km |
| `radar/composite/echotop/hdf5/` | 5 min | **0–3 min** | 59 kB | ODIM `HGHT` | výška horní hranice odrazu |
| `radar/composite/pseudocappi2km/hdf5/` | 5 min | 2 min | 58 kB | ODIM `DBZH` | řez ve 2 km, méně clutteru než MAXZ |
| `weather/forecast/now/` | ~5×/den | 40 min | 16 kB | **GeoJSON** + text | oficiální textová předpověď s polygony |
| `weather/satellite/geo/{24M,airmass,ir108,ir108BT,night-M,vis-ir,wv062}/` | 15 min | 1 min | 49–104 kB | JPG `_cz/_ce/_eu` | hotové obrázky, ne dlaždice |
| `weather/radiosounding/{Praha,Prostejov}/recent/{ascent,descent}/` | 2×/den | ~7 h | 24 kB | PNG + **`_vypis_*.csv`** | skewT, hodograf, výpis |
| `weather/wind_profiles/recent/` | 30 min | 20 min | 455 B | CSV | **jen 1 stanice** (11698 Prostějov) |
| `air_quality/now/data/airquality_1h_avg_CZ.csv` | 1 h | 53 min | 18 kB | CSV | měřená kvalita ovzduší |
| `air_quality/now/metadata/metadata.json` | denně | — | **1,5 MB** | JSON | registr, kořen `data.Localities` |
| `air_quality/now/forecast/` | 1×/den 00:40 | — | 240× ~750 kB | ZIP | boxploty po ORP |
| `air_quality/now/maps/` | ? | — | ZIP | rastrové mapy | neprozkoumáno |
| `products/climate_normal_stations/period_1991_2020/` | statické | — | ~400 B/soubor | CSV | **573 srážkových + 481 teplotních** |
| `products/grids_CZ/climate_normals/period_1991_2020/{air_temperature_mean,precipitation,sunshine_duration}/` | statické | — | ? | ? | gridované normály |
| `products/regional_averages/{temperature,precipitation}/` | ročně/měsíčně | — | 4 kB | CSV | **řady 1961→2026 po krajích** |
| `products/yearbooks/` | ročně | — | ? | ? | ročenky |
| `meteorology/floods/` | 6 h | 5 h | 12 kB | PNG | 24 246 hotových obrázků |
| `meteorology/phenology/{herbs,wood_species}/` | ročně | — | ? | ? | fenologie |
| `weather/nwp_aladin/Lambert_2.3km/{00,06,12,18}/` | 4×/den | **5 h** | **101 MB/proměnná**, 462 souborů | GRIB bz2 | středoevropská doména |
| `weather/forecast_maps_bio/now/` | ? | — | ? | ? | biometeo mapy |
| `weather/forecast_monthly/now/` | — | — | — | — | **adresář je prázdný** |

**Neexistuje** (ověřeno, ne odhad): blesky · zahraniční stanice v `climate/` ·
denní/měsíční historie pro 436 národních stanic v `climate/historical/`.

---

## 2. Návrhy: přínos × úsilí × riziko

Úsilí je v člověkohodinách pro tenhle konkrétní repozitář, tedy se započtením
toho, co už je hotové.

| # | Návrh | Přínos | Úsilí | Riziko | Poznámka |
|---|---|---|---|---|---|
| A | **COTREC nowcast ČHMÚ** jako druhý člen ensemble + baseline | ★★★★★ | ★★☆☆☆ (4–6 h) | nízké | stejná mřížka jako `maxz` → nulová reprojekce |
| B | **Echotop** jako míra intenzity konvekce | ★★★★☆ | ★☆☆☆☆ (2–3 h) | nízké | 59 kB, stejná mřížka |
| C | **Normály 1991–2020 pro všechny stanice** | ★★★★☆ | ★★☆☆☆ (3–4 h) | nízké | zaplní známou díru (40 → ~570 stanic) |
| D | **Měřená kvalita ovzduší** | ★★★☆☆ | ★★★☆☆ (5–7 h) | **střední** | závisí na neověřené struktuře `Localities` |
| E | **Textová předpověď** do AI narace | ★★★☆☆ | ★★☆☆☆ (3–4 h) | nízké | GeoJSON s polygony → lze vybrat podle lokace |
| F | **Krajské průměry 1961→2026** do klimatického kontextu | ★★☆☆☆ | ★☆☆☆☆ (2 h) | nízké | 4 kB CSV, pozor na kódování |
| G | **pseudocappi2km** jako alternativní vstup nowcastu | ★★☆☆☆ | ★★☆☆☆ (3 h) | střední | přínos je nutné změřit, ne předpokládat |
| H | **Gridované normály** (`grids_CZ`) | ★★★☆☆ | ★★★★☆ (8 h+) | střední | normál kdekoliv, ne jen na stanici; formát neověřen |
| I | **Aerologie** (`_vypis_*.csv`) → CAPE, inverze, nulová izoterma | ★★☆☆☆ | ★★★☆☆ (5 h) | střední | 2 stanice, 2×/den, latence 7 h |
| J | **Vertikální profil větru** (Prostějov) | ★☆☆☆☆ | ★★☆☆☆ (3 h) | nízké | 1 stanice — pro celostátní appku okrajové |
| K | Satelitní snímky ČHMÚ jako statický panel | ★☆☆☆☆ | ★★☆☆☆ (3 h) | nízké | RainViewer IR už vrstvu v mapě pokrývá |

---

## 3. Doporučené pořadí a proč

**A → B → C → E → D → F → zbytek podle chuti.**

**A první, protože odpovídá na strategickou otázku.** Otázka ze zadání zněla:
vyplatí se udržovat vlastní pysteps běh, když ČHMÚ publikuje extrapolaci každých
5 minut? Odpověď zní **ano, ale to teď nemůžeme dokázat** — nikdy jsme obě
předpovědi nezměřili proti sobě. A dělá přesně to, na čem stojí zbytek: dokud
neběží, je každý další nowcastový návrh (G, částečně H) rozhodování poslepu.
Navíc je to jediný přírůstek, který zlepší *jádro* aplikace, ne obal kolem něj.

Věcný důvod, proč to není duplicita: `/how/comment` u fct souborů říká
`"Extrapolation forecast based on COTREC method"`. COTREC je jiný algoritmus než
náš `lucaskanade` z pysteps. Dvě nezávislé metody na stejných datech dávají
použitelný rozptyl — shoda znamená důvěru, rozpor nejistotu. Appka pro tohle už
má UI (shoda modelů z vlny SAFETY).

**B druhé, protože je to nejlevnější skutečný přírůstek schopnosti.** Aplikace
dnes posuzuje bouřku podle dBZ, což neodliší mělkou přeháňku 45 dBZ od
supercely 45 dBZ. Echotop tenhle rozdíl vidí přímo. 59 kB na běh, stejná mřížka,
napojí se na `stormtrack.js` a `safety.js`, které už existují.

**C třetí, protože zavírá díru, o které víme.** `chmi_stats.py` zpracuje 287
stanic, ale rekordy a normály má jen 40 — národní stanice v
`climate/historical/` archiv nemají. Zjistilo se, že normály pro ně existují
jinde: `products/climate_normal_stations/`. Navíc jsou **statické**, takže se
stáhnou jednou a pak nikdy — provozní náklad nula.

**E čtvrté** — levné a zlepší narativní část, která je uživatelsky nejviditelnější.

**D páté, ne dřív** — má jedinou neověřenou závislost (viz níže) a dokud ji
neověříme, je odhad úsilí nespolehlivý.

---

## 4. Detailní plán pro top 3

### A. COTREC nowcast ČHMÚ

#### Co bylo ověřeno

```
composite/fct_maxz/hdf5/T_PABV23_C_OKPR_{YYYYMMDD}.{HHMM}.ft60s10.tar   460 kB
  → 20260726.2030/T_PABV23_C_OKPR_{YYYYMMDDHHMMSS}_ft{10,20,30,40,50,60}.hdf
     73–77 kB každý

/where   LL 48.047275/11.266869 · UR 51.458369/19.623974
         projdef "+proj=merc +lat_ts=0 +lon_0=0 +k=1.0 +x_0=-1254222.15
                  +y_0=-6702777.85 +a=6378137.0 +b=6378137.0 ..."
         xscale = yscale = 1555.7 · xsize 598 · ysize 378
/dataset1/data1/data     shape (378, 598) uint8
/dataset1/data1/what     gain 0.5 · offset −32.0 · nodata 255 · undetect 0
                         quantity DBZH
/how                     comment "Extrapolation forecast based on COTREC method"
                         simulated "True"
```

Pro srovnání, `composite/maxz` (ten už čteme) má **identické** `/where` i
`/dataset1/data1/what`. Rozdíl je jen v tom, že `maxz` má navíc `dataset2` (HSP,
27×598) a `dataset3` (VSP, 378×27) — svislé řezy, kterých si `read_odim_dbz`
nevšímá, protože bere první `dataset*` v abecedním pořadí.

Praktický důsledek, na kterém stojí celý nízký odhad úsilí: **`read_odim_dbz()`
i `latlon_to_pixel()` fungují beze změny a `(row, col)`, které `grid.py` už
počítá pro každý bod mřížky, ukazuje na tentýž pixel i v fct polích.** Žádná
reprojekce, žádná interpolace, žádná nová závislost.

#### Nový soubor `pipeline/chmi_fct.py`

```python
"""
ČHMÚ COTREC nowcast — nezávislý druhý extrapolační běh vedle našeho pysteps.

Mřížka fct_maxz je bit za bitem stejná jako composite/maxz, který čteme
v ingest.py (ověřeno sondou, běh 30219188301): 598×378, projdef merc,
xscale=yscale=1555.7, gain 0.5 / offset -32 / nodata 255 / quantity DBZH.
Proto tu není ani řádek reprojekce — read_odim_dbz() a latlon_to_pixel()
platí beze změny a (row, col) z grid.py ukazuje na tentýž pixel.

COTREC je jiný algoritmus než náš lucaskanade. Nejde o duplicitu, ale
o nezávislý druhý názor: shoda = důvěra, rozptyl = nejistota.
"""

import io
import json
import os
import re
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, DEFAULT_LAT, DEFAULT_LON, read_odim_dbz
from nowcast import RAIN_THRESHOLD_MM_H, dbz_to_rainrate, latlon_to_pixel

BASE = ("https://opendata.chmi.cz/meteorology/weather/radar/composite/"
        "fct_maxz/hdf5/")
TAR_RE    = re.compile(r'href="(T_PABV23_C_OKPR_\d{8}\.\d{4}\.ft\d+s\d+\.tar)"')
MEMBER_RE = re.compile(r"_(\d{14})_ft(\d+)\.hdf$")
TIMEOUT     = (10, 60)
MAX_AGE_MIN = 25     # starší běh nemá smysl míchat s naší čerstvou extrapolací
STEP_MIN    = 10     # ft10…ft60 → krok 10 min, stejný jako náš TIMESTEP_MIN

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def latest_tar_name() -> str | None:
    r = SESSION.get(BASE, timeout=TIMEOUT)
    r.raise_for_status()
    names = sorted(set(TAR_RE.findall(r.text)))
    return names[-1] if names else None


def parse_base_time(tar_name: str) -> datetime:
    """T_PABV23_C_OKPR_20260726.2030.ft60s10.tar → 2026-07-26 20:30 UTC."""
    m = re.search(r"_(\d{8})\.(\d{4})\.", tar_name)
    return (datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M")
            .replace(tzinfo=timezone.utc))


def load_fields(tar_bytes: bytes) -> list[tuple[int, datetime, np.ndarray]]:
    """Vrátí [(lead_min, valid_utc, rain_rate mm/h)] seřazené podle lead_min."""
    out = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        for m in tf.getmembers():
            hit = MEMBER_RE.search(m.name)
            if not hit:
                continue
            valid = (datetime.strptime(hit.group(1), "%Y%m%d%H%M%S")
                     .replace(tzinfo=timezone.utc))
            buf = tf.extractfile(m).read()
            # h5py umí file-like objekt, takže nic nemusí na disk
            dbz, _ = read_odim_dbz(io.BytesIO(buf))
            out.append((int(hit.group(2)), valid, dbz_to_rainrate(dbz)))
    out.sort(key=lambda t: t[0])
    return out


def load_radar_meta() -> dict:
    meta = json.loads((DATA_DIR / "radar_meta.json").read_text())["meta_latest"]
    meta["shape"] = tuple(int(x) for x in str(meta["shape"]).strip("()").split(","))
    for k in ("xscale", "yscale", "LL_lon", "LL_lat", "UR_lon", "UR_lat"):
        if isinstance(meta.get(k), str):
            meta[k] = float(meta[k])
    return meta


def main():
    lat = float(os.environ.get("NOWCAST_LAT", DEFAULT_LAT))
    lon = float(os.environ.get("NOWCAST_LON", DEFAULT_LON))

    if not (DATA_DIR / "radar_meta.json").exists():
        print("chmi_fct.py: radar_meta.json chybí — spusť ingest.py", file=sys.stderr)
        return

    try:
        name = latest_tar_name()
        if not name:
            raise RuntimeError("v listingu fct_maxz není žádný .tar")
        base_utc = parse_base_time(name)
        age_min = (datetime.now(timezone.utc) - base_utc).total_seconds() / 60
        if age_min > MAX_AGE_MIN:
            raise RuntimeError(f"nejnovější běh je {age_min:.0f} min starý "
                               f"(limit {MAX_AGE_MIN})")
        r = SESSION.get(BASE + name, timeout=TIMEOUT)
        r.raise_for_status()
        fields = load_fields(r.content)
        if not fields:
            raise RuntimeError("tar neobsahuje žádný ft*.hdf")
    except Exception as e:
        print(f"chmi_fct.py: {e} — vynechávám", file=sys.stderr)
        return

    meta = load_radar_meta()

    # Pojistka proti tichému rozjetí: kdyby ČHMÚ někdy změnilo mřížku fct
    # produktu, indexovali bychom do jiného rastru a dostali nesmyslná čísla
    # BEZ jediné chyby. Radši to tady spadne nahlas.
    if fields[0][2].shape != tuple(meta["shape"]):
        print(f"chmi_fct.py: tvar {fields[0][2].shape} ≠ maxz {meta['shape']} — "
              "ČHMÚ změnilo mřížku, vynechávám", file=sys.stderr)
        return

    row, col = latlon_to_pixel(lat, lon, meta)
    series = [{"time_utc": v.isoformat(), "lead_min": lead,
               "mm_h": round(float(np.nan_to_num(rr[row, col])), 3)}
              for lead, v, rr in fields]
    vals = [s["mm_h"] for s in series]

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_utc":     base_utc.isoformat(),
        "age_min":      round(age_min, 1),
        "source":       "ČHMÚ COTREC (composite/fct_maxz)",
        "method":       "COTREC",
        "step_min":     STEP_MIN,
        "horizon_h":    len(fields) * STEP_MIN / 60,
        "pixel":        {"row": row, "col": col},
        "threshold_mm_h": RAIN_THRESHOLD_MM_H,
        "arrival_utc":  next((s["time_utc"] for s in series
                              if s["mm_h"] >= RAIN_THRESHOLD_MM_H), None),
        "peak_mm_h":    round(max(vals), 2) if vals else 0.0,
        "total_mm":     round(sum(vals) * (STEP_MIN / 60), 2),
        "timeseries":   series,
    }

    # Mřížka: napojíme se na body, které už spočítal grid.py — stejný rastr,
    # takže stačí vyčíst pixel. Ukládáme jen body, kde něco prší, jinak by
    # JSON zbytečně narostl.
    grid_path = DATA_DIR / "forecast_grid.json"
    if grid_path.exists():
        grid = json.loads(grid_path.read_text())
        cot = {}
        for i, pt in enumerate(grid.get("pts", [])):
            r_, c_ = int(pt[0]), int(pt[1])
            v = [round(float(np.nan_to_num(rr[r_, c_])), 2) for _, _, rr in fields]
            if max(v) >= RAIN_THRESHOLD_MM_H:
                cot[str(i)] = v
        out["grid"] = {
            "t0_utc": grid.get("t0_utc"),     # klient si ověří, že patří k sobě
            "n_pts":  len(grid.get("pts", [])),
            "series": cot,
        }

    path = DATA_DIR / "chmi_fct.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_fct.py: {len(fields)} kroků, báze {base_utc:%H:%M} UTC "
          f"({age_min:.0f} min), {path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
```

#### Krok 2 — verifikace se zpožděním

COTREC nelze ověřit tak jako naši extrapolaci. Náš nowcast umí `verify.py`
přehrát na zadrženém úseku (holdout), protože ho počítáme sami. COTREC je
**publikovaná** předpověď, takže se musí uložit a porovnat až s pozorováním,
které přijde později.

Vzor už v repozitáři je — `pipeline/state/accuracy_history.json` a jeho
commit‑back krok ve workflow. Přidat:

1. `chmi_fct.py` na konci připíše do `pipeline/state/cotrec_pending.json`
   záznam `{base_utc, valid_utc, lead_min, pred_mm_h}` pro domácí pixel.
2. `verify.py` po načtení `stack, times` projde čekající záznamy, najde
   pozorování, jehož `valid_utc` sedí na některý z `times` (tolerance ±5 min),
   a spočítá stejné metriky jako pro nás — `_metrics()` v tom souboru už existuje,
   stačí zavolat se stejným oknem `SAMPLE_RADIUS`.
3. Výsledek se přidá do `accuracy_history.json` pod klíč `cotrec`, vyhodnocené
   záznamy z `cotrec_pending.json` vypadnou.

Tím vznikne přímé srovnání „naše pysteps vs. COTREC ČHMÚ“ na stejné metrice,
stejném pixelu a stejném období. **Teprve tohle je odpověď na otázku, jestli si
vlastní běh udržet.** Můj odhad předem je, že ano — startovní pole bereme
z `merge1h` (radar zkalibrovaný srážkoměry), zatímco COTREC extrapoluje
odrazivost — ale je to odhad, ne měření, a právě proto se to má změřit.

#### Workflow

Do `.github/workflows/nowcast.yml` **za** krok `Run grid (Fáze 4a)`:

```yaml
      - name: Run chmi_fct (COTREC nowcast ČHMÚ — druhý názor k pysteps)
        timeout-minutes: 3
        continue-on-error: true
        run: python pipeline/chmi_fct.py || echo "chmi_fct.py selhalo, pokračuji"
        env:
          NOWCAST_LAT: '50.08'
          NOWCAST_LON: '14.42'
```

Do obou bloků cache (`restore` i `save`) přidat `data/chmi_fct.json`.
V `pipeline/validate.py` **nepovažovat za povinný soubor** — je to doplněk, ne
podmínka deploye.

#### Frontend

- `web/js/app.js` → `loadData()`: `chmi_fct.json` jako další volitelný fetch.
- Nový `web/js/cotrec.js`: vyzvedne řadu pro nejbližší bod mřížky, pokud
  `grid.t0_utc === forecastGrid.t0_utc`; jinak jen bodovou řadu.
- Karta „Druhý názor: ČHMÚ COTREC" — čas příchodu deště podle obou metod
  a odznak shody. Rozdíl do 10 min = „shoda", nad 30 min = „metody se
  neshodují, ber s rezervou".
- Do panelu přesnosti přibude řádek COTREC, jakmile nasbírá dost záznamů.

#### Testy

`tests/test_chmi_fct.py`, v duchu `tests/test_metar.py` — čistě jednotkové,
bez sítě:
- `parse_base_time()` na reálném názvu souboru
- `MEMBER_RE` vytáhne lead a čas platnosti z reálné cesty uvnitř tar
- pořadí kroků po `load_fields()` je 10, 20, …, 60
- kontrola tvaru vyhodí běh při neshodě s `radar_meta.json`
- `arrival_utc` je `None`, když jsou všechny hodnoty pod prahem

---

### B. Echotop

#### Co bylo ověřeno

```
composite/echotop/hdf5/T_PADV23_C_OKPR_{YYYYMMDDHHMMSS}.hdf    59 kB, co 5 min
/dataset1/data1/what   gain 100.0 · offset 0.0 · nodata 255 · undetect 0
                       quantity HGHT
/dataset1/what         product ETOP · prodpar 4.0
/where                 identické s maxz
```

Dvě věci, na které je potřeba dát pozor:

- **`gain` je 100, ne 0,5.** `read_odim_dbz()` čte gain a offset z atributů
  (`what_ds.attrs.get("gain", 0.5)`), takže vrátí správně metry — ale výsledek
  se nesmí jmenovat `dbz` a rozhodně se nesmí poslat do `dbz_to_rainrate()`.
- `prodpar 4.0` znamená, že jde o výšku hladiny **4 dBZ**, ne o skutečný vrchol
  oblaku. Je to spodní odhad, a v tom je i jeho hodnota — je konzistentní.

#### Interpretace, poctivě

Výška horní hranice odrazu je nejlepší radarový ukazatel hloubky konvekce, ale
**absolutní prahy nejsou univerzální** — závisí na výšce tropopauzy a nulové
izotermy, tedy na ročním období. V létě je 11 km hodně, v lednu je 6 km hodně.
Orientačně pro české léto: pod 5 km vrstevnaté srážky, 5–8 km mírná konvekce,
8–11 km bouřka, nad 11 km riziko krup a nárazů.

Doporučuji to podávat **relativně** — „nejvyšší vrcholy v okolí dnes“ a
percentil vůči poslední hodině — a jako absolutní práh používat jen ve dvojici
s dBZ. Samotný echotop nad 11 km bez odpovídající odrazivosti je většinou
artefakt.

#### Nový soubor `pipeline/echotop.py`

```python
"""
Výška horní hranice radarového odrazu (ODIM ETOP) — míra hloubky konvekce.

Ověřeno sondou: composite/echotop/hdf5/, 59 kB co 5 min, quantity HGHT,
gain 100 / offset 0 → hodnota × 100 = metry. Mřížka identická s maxz.

Pozor: gain je 100, ne 0.5 jako u DBZH. read_odim_dbz() gain z atributů čte,
takže vrátí rovnou metry — ale výsledek NENÍ dBZ a nesmí projít
dbz_to_rainrate(). prodpar=4.0 = výška hladiny 4 dBZ, tedy spodní odhad
vrcholu, ne vrchol oblaku.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, read_odim_dbz

BASE = ("https://opendata.chmi.cz/meteorology/weather/radar/composite/"
        "echotop/hdf5/")
FILE_RE = re.compile(r'href="(T_PADV23_C_OKPR_\d{14}\.hdf)"')
TIMEOUT = (10, 60)
MAX_AGE_MIN = 20
BOX = 2          # ± pixelů (1555,7 m) → okno ~7,8 km kolem bodu

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def main():
    grid_path = DATA_DIR / "forecast_grid.json"
    if not grid_path.exists():
        print("echotop.py: forecast_grid.json chybí — spusť grid.py", file=sys.stderr)
        return

    try:
        r = SESSION.get(BASE, timeout=TIMEOUT)
        r.raise_for_status()
        names = sorted(set(FILE_RE.findall(r.text)))
        if not names:
            raise RuntimeError("prázdný listing")
        newest = names[-1]
        stamp = datetime.strptime(re.search(r"_(\d{14})\.hdf", newest).group(1),
                                  "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - stamp).total_seconds() / 60
        if age > MAX_AGE_MIN:
            raise RuntimeError(f"nejnovější snímek je {age:.0f} min starý")
        import io
        blob = SESSION.get(BASE + newest, timeout=TIMEOUT)
        blob.raise_for_status()
        hght_m, meta = read_odim_dbz(io.BytesIO(blob.content))
    except Exception as e:
        print(f"echotop.py: {e} — vynechávám", file=sys.stderr)
        return

    grid = json.loads(grid_path.read_text())
    pts = grid.get("pts", [])
    nrows, ncols = hght_m.shape

    tops = {}
    for i, pt in enumerate(pts):
        r_, c_ = int(pt[0]), int(pt[1])
        win = hght_m[max(0, r_ - BOX): min(nrows, r_ + BOX + 1),
                     max(0, c_ - BOX): min(ncols, c_ + BOX + 1)]
        if win.size and np.isfinite(win).any():
            top = float(np.nanmax(win))
            if top > 0:
                tops[str(i)] = round(top)      # metry

    finite = hght_m[np.isfinite(hght_m)]
    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "obs_utc":   stamp.isoformat(),
        "age_min":   round(age, 1),
        "source":    "ČHMÚ ETOP (composite/echotop, práh 4 dBZ)",
        "box_px":    BOX,
        "grid_t0_utc": grid.get("t0_utc"),
        "n_pts":     len(pts),
        "max_m":     round(float(finite.max())) if finite.size else 0,
        # percentil dává smysl jen z bodů, kde vůbec něco je
        "p95_m":     round(float(np.percentile(finite, 95))) if finite.size else 0,
        "tops_m":    tops,
    }
    path = DATA_DIR / "echotop.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"echotop.py: {len(tops)} bodů, max {out['max_m']} m, "
          f"{path.stat().st_size / 1024:.0f} kB")


if __name__ == "__main__":
    main()
```

#### Napojení

- Workflow: krok hned za `chmi_fct`, `timeout-minutes: 2`, `continue-on-error`.
  Do cache přidat `data/echotop.json`.
- `web/js/stormtrack.js`: k buňce doplnit výšku vrcholu — bouřka s vrcholem
  11 km si zaslouží jiný text než přeháňka se 4 km.
- `web/js/safety.js`: echotop jako druhé kritérium vedle dBZ. Zpřísní se tím
  varování „zásah bouřkou“ — dnes ho spustí i silná, ale mělká přeháňka.

---

### C. Normály 1991–2020 pro všechny stanice

#### Co bylo ověřeno

```
products/climate_normal_stations/period_1991_2020/
  precipitation_1991_2020_list_of_stations.csv   55 kB
  temperature_1991_2020_list_of_stations.csv     15 kB
  precipitation/{WSI}_SRA_1991_2020_normal.csv          573 souborů, ~415 B
  temperature/{WSI}_{T|TMA|TMI}_1991_2020_normal.csv    481 souborů, ~409 B
```

Obsah normálového souboru — 12 řádků, jeden na měsíc:

```
Eg.Gh.Id,Eg.El.Abbreviation,Month,Normal.SUM      ← srážky
0-20000-0-11406,SRA,1,41.9

Eg.Gh.Id,Eg.El.Abbreviation,Month,Normal.AVG      ← teploty
0-20000-0-11406,TMA,1,1.6
```

**Klíčové zjištění:** mezi názvy souborů jsou i identifikátory `0-203-0-*`
(např. `0-203-0-41701105001_SRA_1991_2020_normal.csv`), tedy **národní stanice**
— přesně ty, kterým `chmi_stats.py` dnes normály dát neumí, protože v
`climate/historical/` archiv nemají.

**Past, na kterou je nutné myslet:** ty dva seznamy stanic **nejsou ve stejném
formátu**. Ověřeno na obsahu, ne odhad:

```
precipitation_...csv:  WSI,GH ID,...,GEOGR1,GEOGR2,ELEVATION
                       0-20000-0-11406,T6L3CHEB,...,12.3914,50.0683,483
                       → oddělovač ',' , desetinná TEČKA

temperature_...csv:    ﻿WSI;GH ID;...;GEOGR1;GEOGR2;ELEVATION
                       0-20000-0-11406;T6L3CHEB;...;12,3914;50,0683;483
                       → oddělovač ';' , desetinná ČÁRKA, navíc BOM
```

`GEOGR1` je zeměpisná délka, `GEOGR2` šířka (Cheb 12,39 E / 50,07 N) — stejně
jako v `climate/now/metadata/`, kde to appka už takhle čte.

#### Nový soubor `pipeline/chmi_normals.py` — jádro

```python
"""
Klimatické normály 1991–2020 po stanicích.

Řeší známou díru: chmi_stats.py zpracuje 287 stanic, ale rekordy/normály má
jen 40 — národní stanice (0-203-0-*) v climate/historical/ archiv nemají.
Normály pro ně ale existují jinde, v products/climate_normal_stations/,
a to včetně 0-203-0 identifikátorů.

Data jsou STATICKÁ (období 1991–2020). Stahují se tedy jednou; další běhy
skončí hned na kontrole období. Provozní náklad po prvním naplnění: nula.
"""

import csv
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = ("https://opendata.chmi.cz/meteorology/products/"
        "climate_normal_stations/period_1991_2020")
PERIOD = "1991_2020"
TIMEOUT = (5, 20)
BUDGET_S = 120           # stejný vzor jako chmi_stats.py — doběhne v dalším běhu
MAX_WORKERS = 12
ELEMENTS = {"temperature": ("T", "TMA", "TMI"), "precipitation": ("SRA",)}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "nowcast-pipeline/1.0 (+github actions)"})


def read_station_list(kind: str) -> dict:
    """
    Vrátí {WSI: {name, lat, lon, elev}}.

    Ty dva soubory NEJSOU ve stejném formátu (ověřeno sondou):
      precipitation → oddělovač ',', desetinná tečka
      temperature   → oddělovač ';', desetinná čárka, navíc BOM
    Formát se proto zjišťuje z hlavičky, ne podle názvu souboru — kdyby to
    ČHMÚ někdy sjednotilo, ať to nepřestane fungovat.
    """
    url = f"{BASE}/{kind}_{PERIOD}_list_of_stations.csv"
    txt = SESSION.get(url, timeout=TIMEOUT).content.decode("utf-8-sig")
    head = txt.splitlines()[0]
    delim = ";" if head.count(";") > head.count(",") else ","
    dec_comma = delim == ";"

    def num(s):
        s = (s or "").strip()
        if not s:
            return None
        return float(s.replace(",", ".") if dec_comma else s)

    out = {}
    for row in csv.DictReader(io.StringIO(txt), delimiter=delim):
        wsi = (row.get("WSI") or "").strip()
        if not wsi:
            continue
        # GEOGR1 = délka, GEOGR2 = šířka (Cheb 12,39 E / 50,07 N)
        out[wsi] = {
            "name": (row.get("FULL_NAME") or "").strip(),
            "lon":  num(row.get("GEOGR1")),
            "lat":  num(row.get("GEOGR2")),
            "elev": num(row.get("ELEVATION")),
        }
    return out


def fetch_normal(kind: str, wsi: str, element: str) -> list | None:
    """12 měsíčních hodnot, nebo None. Chybějící měsíc = None, ne nula."""
    url = f"{BASE}/{kind}/{wsi}_{element}_{PERIOD}_normal.csv"
    try:
        r = SESSION.get(url, timeout=TIMEOUT)
        if not r.ok:
            return None
        vals = [None] * 12
        for row in csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))):
            # poslední sloupec je Normal.AVG nebo Normal.SUM podle prvku
            key = next((k for k in row if k.startswith("Normal.")), None)
            m = int(row["Month"])
            if key and 1 <= m <= 12 and (row[key] or "").strip():
                vals[m - 1] = float(row[key])
        return vals if any(v is not None for v in vals) else None
    except Exception:
        return None


def main():
    out_path = DATA_DIR / "chmi_normals.json"
    existing = {}
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text())
            if prev.get("period") == PERIOD:
                existing = prev.get("stations", {})
        except Exception:
            pass

    stations, jobs = dict(existing), []
    for kind, elements in ELEMENTS.items():
        try:
            meta = read_station_list(kind)
        except Exception as e:
            print(f"chmi_normals.py: seznam {kind} selhal: {e}", file=sys.stderr)
            continue
        for wsi, info in meta.items():
            st = stations.setdefault(wsi, {**info, "normals": {}})
            st.update({k: v for k, v in info.items() if v is not None})
            for el in elements:
                if el not in st["normals"]:
                    jobs.append((kind, wsi, el))

    if not jobs:
        print(f"chmi_normals.py: hotovo, {len(stations)} stanic — nic ke stažení")
        return

    t0, done = time.time(), 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_normal, k, w, e): (w, e) for k, w, e in jobs}
        for fut in futures:
            if time.time() - t0 > BUDGET_S:
                # Rozpočet došel — zbytek doběhne v dalším běhu (resume).
                for f in futures:
                    f.cancel()
                break
            wsi, el = futures[fut]
            try:
                vals = fut.result()
            except Exception:
                vals = None
            if vals:
                stations[wsi]["normals"][el] = vals
                done += 1

    stations = {w: s for w, s in stations.items()
                if s.get("normals") and s.get("lat") and s.get("lon")}
    out_path.write_text(json.dumps(
        {"period": PERIOD,
         "generated_at_utc": datetime.now(timezone.utc).isoformat(),
         "count": len(stations),
         "stations": stations},
        ensure_ascii=False, separators=(",", ":")))
    print(f"chmi_normals.py: +{done} řad, celkem {len(stations)} stanic, "
          f"zbývá {max(0, len(jobs) - done)}")


if __name__ == "__main__":
    main()
```

#### Napojení

- Workflow: krok jen ve `full` režimu, `timeout-minutes: 4`, `continue-on-error`.
  Do cache `data/chmi_normals.json` — díky tomu se po naplnění už nikdy nestahuje.
- `web/js/climate.js`: najít nejbližší stanici s normály (stejný vzor jako
  `nearestFreshStation()` v `models.js`, včetně penalizace za rozdíl nadmořské
  výšky) a ukazovat „dnešní maximum 27 °C · normál pro červenec 24,1 °C (+2,9)".
- Přepočet na nadmořskou výšku tady **nepoužívat**. U okamžité teploty dává
  smysl, u měsíčního normálu se rozdíl výšek promítá i do jiných veličin
  (oblačnost, inverze) a lineární gradient by lhal víc, než pomohl. Lepší je
  ukázat výšku stanice a nechat rozdíl vidět.

---

## 5. Co nedělat a proč

**ALADIN Lambert 2,3 km.** 462 souborů na běh, **101 MB na proměnnou**, běhy
4×/den a nejnovější byl při sondě starý 5 hodin. `CZ_1km`, který už používáme,
má nad územím, které nás zajímá, **vyšší** rozlišení a menší soubory. Za větší
doménu bychom platili dvěma řády objemu dat a pěti hodinami stáří — na pipeline
běžící co 10 minut je to nesmysl. Kdyby někdy byla potřeba středoevropská
doména, levnější cesta je Open‑Meteo ICON‑D2/AROME, které už v žebříčku modelů
jsou.

**`meteorology/floods/` PNG.** 24 246 hotových obrázků `floods_prec24h_*.png`.
Jsou to rastry bez čísel a bez spolehlivé georeference. Nedá se z nich číst
hodnota pro bod, nedá se to porovnat s ničím a nedá se to verifikovat. Srážkové
úhrny už máme z ALADIN a Open‑Meteo v číselné podobě.

**`air_quality/now/forecast/` boxploty.** 240 ZIPů po ~750 kB, jednou denně,
boxploty po ORP. Špatný tvar dat i špatná granularita pro bodovou aplikaci
a rozbalování 180 MB v každém běhu je neúnosné. Předpověď kvality ovzduší už
appka má z Open‑Meteo CAMS.

**Satelitní snímky ČHMÚ jako vrstva v mapě.** `satellite/geo/*` jsou hotové
JPG ve třech pevných výřezech (`_cz`, `_ce`, `_eu`), ne dlaždice. Do slippy mapy
by se musely natahovat odhadem přes rohové souřadnice, které nikde nejsou —
při zoomu a posunu by to viditelně ujíždělo. RainViewer IR, který appka používá
(`radar.js:208`), je dlaždicový a globální. Jako **statický obrázek v panelu**
(airmass nebo wv062 pro synoptický kontext) to smysl dává; jako mapová vrstva ne.

**`forecast_monthly/`.** Adresář `now/` je prázdný — 0 souborů, 0 podadresářů.
Není co použít.

**Fenologie a ročenky.** Roční kadence, obsahově mimo nowcast. Do aplikace,
která odpovídá na otázku „bude za hodinu pršet“, nepatří.

**Blesky z ČHMÚ.** Neexistují. Zjištěno dvakrát nezávisle. Nestavět na tom nic
a nedělat „fallback z ČHMÚ“ pro Blitzortung — nebylo by z čeho.

**Historická denní/měsíční data pro 436 národních stanic.** Změřeno: v
`climate/historical/` nejsou. Nedopisovat proto do `chmi_stats.py` fallback,
který by tiše sbíral 404 v každém běhu. Normály pro tyhle stanice existují, ale
jinde — návrh C.

**Vertikální profil větru z Prostějova jako zdroj pro větrnou vrstvu.** Jedna
stanice, 30minutová kadence, 20 min zpoždění. Pro celostátní pole je to bod;
`windgrid.py` má 238 bodů z Open‑Meteo. Jako ověřovací bod nebo pro zobrazení
střihu větru nad Moravou to použitelné je, jako zdroj pole ne.

---

## Co je potřeba ověřit před implementací

Poctivě — tyhle věci **nejsou** změřené a odhady úsilí u nich stojí na vodě:

1. **`air_quality/now/metadata/metadata.json` → `data.Localities`.** Hodinové CSV
   má sloupce `idRegistration, startTime, idValueType, value` — a **žádný sloupec
   s polutantem**. Znamená to, že `idRegistration` je dvojice (stanice, látka)
   a rozklíčovat ji jde jedině přes `Localities`. Dokud není ověřeno, že tam
   ta vazba opravdu je, je návrh D nezaplánovatelný. (`idValueType = 8` je
   „Operativní data“, 5–7 jsou chybové kódy — ty se musí odfiltrovat.)
2. **`products/grids_CZ/climate_normals/period_1991_2020/*`** — existují tři
   podadresáře (`air_temperature_mean`, `precipitation`, `sunshine_duration`),
   ale formát ani velikost souborů uvnitř jsem neprobíral.
3. **`radiosounding/.../ascent/*_vypis_*.csv`** — CSV existuje vedle PNG, jeho
   sloupce neznám.
4. **Kódování krajských průměrů.** V `Annual_areal_temperature_mean.csv` se
   „Česko“ v logu zobrazilo jako `¬esko`, tedy windows‑1250 čtené jako UTF‑8.
   Teplotní soubor má oddělovač `,`, srážkový `;` — stejná nekonzistence jako
   u seznamů stanic. Před nasazením otestovat na skutečném obsahu.

Struktury a časy aktualizace se u ČHMÚ mění — sonda v
`pipeline/probe_stations.py` je proto napsaná tak, aby se dala pustit znovu
(`workflow_dispatch` na `probe-sources.yml`) a čísla v téhle analýze se dala
přeměřit.
