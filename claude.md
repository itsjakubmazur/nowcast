# Meteo Nowcast CZ — kickoff spec pro Claude Code

> Vlož celý tento soubor do repozitáře jako `CLAUDE.md` a do prvního promptu napiš:
> *„Přečti si CLAUDE.md. Postupujeme po fázích. Začni Fází 0 a po každé fázi se zastav, ukaž mi, co běží, a počkej na potvrzení."*

---

## 1. Mise

Webová aplikace pro **krátkodobou předpověď počasí (nowcasting) v horizontu jednoho dne** pro libovolnou lokaci v ČR. Cílem je být lepší než běžné appky tím, že místo grafů dá uživateli **lidsky čitelný, lokalizovaný verdikt**: *„Kolem 16:30 dorazí od JZ přeháňka, ~8–15 mm/h, nárazy větru 12–15 m/s, do 18:00 odezní."*

### Klíčový princip — drž ho během celého vývoje

> **Fyzika počítá čísla, Claude píše příběh.**

- **NIKDY** nenech LLM „dívat se na radarový PNG obrázek a hádat" čas příchodu nebo množství srážek. To je nespolehlivé věštění.
- Čas příchodu, intenzita a úhrn srážek se počítají **numericky** z gridových dat (advekce radarových ozvěn + Z–R přepočet + číselné modely).
- LLM (Claude API) se volá **až na konci** a dostane **hotová strukturovaná čísla**. Jeho úkol je jen převést je do přirozené české věty. Nesmí žádné číslo vymyslet ani „dopočítat".

---

## 2. Architektura

```
GitHub Actions (cron ~ každých 10 min)
        │
        ▼
  Python pipeline:
   1. ingest  → stáhne radar (ČHMÚ HDF5), modely (Open-Meteo), výstrahy (ČHMÚ CAP), blesky
   2. nowcast → pysteps: advekce ozvěn, 0–2 h extrapolace, Z–R přepočet
   3. fuse    → spojí nowcast (0–2 h) s NWP modely (2 h–konec dne) do jednoho JSON
   4. narrate → zavolá Claude API, dostane český verdikt
   5. publish → zapíše forecast.json + statický web
        │
        ▼
  GitHub Pages (statická "výloha": mapa, radarová smyčka, verdikt, grafy)
```

Žádný runtime server. Backend = naplánovaný Action, frontend = čistě statický.

---

## 3. Tech stack

**Python (pipeline v Action):**
- `pysteps` — jádro nowcastingu (má importér `import_odim_hdf5`, který čte přímo ODIM HDF5 formát, ve kterém ČHMÚ data publikuje — to je klíčové, nemusíme parsovat ručně)
- `h5py` / `wradlib` — práce s radarovými HDF5
- `numpy`, `scipy`, `pyproj` (reprojekce gridu)
- `requests` — stahování
- `anthropic` — volání Claude API pro syntézu

**Frontend (statický, na Pages):**
- `MapLibre GL JS` nebo `Leaflet` — mapa + radarová smyčka
- `Chart.js` — časová osa srážek / větru
- Vanilla JS, žádný build step pokud to půjde (ať se to snadno deployuje na Pages)

**Orchestrace:** GitHub Actions s `schedule: cron`.

---

## 4. Datové zdroje (ověřený stav k roku 2026)

| Zdroj | Co dává | Pozn. |
|---|---|---|
| **ČHMÚ opendata** (`opendata.chmi.cz/meteorology/weather/radar/`) | Gridová radarová data v **HDF5/ODIM**: `MAX_Z` (max odrazivost), CAPPI 2 km (odhad srážek u země), `MERGE` (hodinový QPE radar+srážkoměry), `Echo_Top` | České, zdarma. **Toto je jádro nowcastingu.** Stahuj posledních ~6 snímků pro odhad pohybu. |
| **Open-Meteo** (`api.open-meteo.com/v1/forecast`) | Číselné modely. Pro **střední Evropu 15minutová data** z DWD ICON-D2 a Météo-France AROME, vč. CAPE a předpovědi bouřek/krup | **Bez API klíče.** Nekomerčně do 10 000 volání/den. Pokrývá horizont 2 h–konec dne. |
| **ČHMÚ výstrahy SIVS** (CAP/XML) | Oficiální meteorologické výstrahy | Pozn.: ČHMÚ od 1. 7. 2026 přechází na nový dopadově orientovaný systém — ověř formát. |
| **Blitzortung** (`blitzortung.org`) | Detekce blesků (real-time) | Pro indikaci aktivní konvekce. |
| **EUMETSAT MSG/MTG** | Satelitní snímky (IR teploty oblačných vrcholů) | **Až Fáze 5** — nejtěžší a nejmenší přínos v horizontu 1 dne. |

**NEPOUŽÍVAT jako zdroj nowcastu: RainViewer** — od přelomu 2025/2026 zrušili ve free tieru budoucí radar (nowcast) i satelit. Vlastní nowcast si počítáme z ČHMÚ dat.

---

## 5. Detail pipeline

### Krok 1 — Ingest
- Stáhni posledních N (≈6) radarových kompozitů `MAX_Z` nebo CAPPI 2 km z ČHMÚ opendata.
- **Ověř živě** přesné názvy souborů, interval a strukturu adresáře — nehádej z hlavy.
- Open-Meteo: jeden request s `latitude`, `longitude`, `minutely_15=precipitation,rain,snowfall,...`, `hourly=...`, `daily=...`, `timezone=Europe/Prague`. Zvaž `models=icon_d2` pro krátký horizont.
- Stáhni aktuální CAP výstrahy a (volitelně) blesky.

### Krok 2 — Nowcast (pysteps)
1. Načti sekvenci radarových snímků (`import_odim_hdf5`).
2. dBZ → intenzita srážek přes Z–R vztah (`pysteps.utils.transformation` / `to_rainrate`, Marshall–Palmer).
3. Odhad pohybového pole (`pysteps.motion.lucaskanade` nebo `vet`).
4. Extrapolace 0–2 h (`pysteps.nowcasts.extrapolation`); pro nejistotu zvaž STEPS ensemble.
5. Pro cílovou lokaci vytáhni časovou řadu: očekávaná intenzita, **čas příchodu** (kdy odrazivost > práh dorazí na bod), odhad úhrnu.

**Poctivé omezení:** radarová extrapolace je spolehlivá ~0–2 h. Dál se rozpadá (nezachytí vznik nových buněk) → přebírá NWP. Tohle musí být v datovém modelu i v UI explicitní.

### Krok 3 — Fúze
Spoj nowcast (0–2 h, vysoká důvěra) s Open-Meteo NWP (2 h–konec dne) do jednoho `forecast.json`. Každý časový bod nese zdroj a míru nejistoty.

### Krok 4 — Narrace (Claude API)
- Vstup: strukturovaný `forecast.json` + lokace + aktivní výstrahy.
- Systémový prompt MUSÍ obsahovat tvrdý guardrail: *„Popisuj POUZE čísla, která dostaneš. Nevymýšlej, nedopočítávej, neodhaduj. Když data chybí, řekni to. Výstup česky."*
- Výstup: 2–4 věty verdiktu + případně varování. Ulož do JSON.

### Krok 5 — Publish
Zapiš `forecast.json` + vyrenderuj statický web a deployuj na Pages (peaceiris/actions-gh-pages nebo nativní Pages deploy).

---

## 6. Fázový plán (stavíme celou vizi, ale postupně)

- **Fáze 0 — Skeleton.** Repo, struktura složek, prázdný Action s cronem, prázdný statický web na Pages. Cíl: deploy běží naprázdno.
- **Fáze 1 — Ingest.** Stáhnout a uložit radar HDF5 + Open-Meteo JSON. Dry-run, vypsat shape gridu. Cíl: data reálně tečou.
- **Fáze 2 — Nowcast core.** pysteps advekce + Z–R, časová řada pro jednu lokaci. Cíl: čísla čas-příchodu a úhrnu dávají smysl.
- **Fáze 3 — Fúze + Claude verdikt.** Spojit s NWP, zavolat Claude, vygenerovat větu. Cíl: end-to-end `forecast.json` s verdiktem.
- **Fáze 4 — Frontend.** Mapa, radarová smyčka, verdikt, grafy, výběr lokace. Cíl: použitelný web.
- **Fáze 5 — Extra.** Blesky, výstrahy v UI, satelit (IR), víc lokací, sdílení.

Po každé fázi se zastav a ukaž funkční výsledek.

---

## 7. Omezení GitHub Actions (počítej s nimi)

- Použij **public repo** → Actions minuty zdarma a Pages funguje bez Pro.
- Claude API klíč ulož jako **GitHub Secret** (`ANTHROPIC_API_KEY`), nikdy do kódu. Náklady na syntézu jsou při tomto objemu zanedbatelné.
- Cron na free tieru se může **opozdit** při zátěži — neřeš to jako přesný čas, prostě „co nejčastěji".
- GitHub **vypne naplánované workflow po ~60 dnech neaktivity** repa — měj fallback / připomínku.
- Drž běh krátký (radarová advekce na CZ gridu jsou sekundy, takže pohoda).

---

## 8. Co NEDĚLAT (guardraily)

- ❌ LLM nehádá hodnoty z obrázků. Čísla jen z gridových dat.
- ❌ Nikdy neprezentuj extrapolaci > 2 h jako jistotu — přepni na NWP a označ to.
- ❌ Žádný localStorage/build-magie, ať Pages deploy zůstane triviální.
- ❌ Nehardcoduj ČHMÚ názvy souborů „z hlavy" — ověř živě.
- ✅ Vždy zobraz zdroj dat a míru nejistoty.
- ✅ Cituj ČHMÚ a Open-Meteo (licence CC BY) ve footeru.

---

## 9. První úkol pro Claude Code

1. Založ strukturu repa (`pipeline/`, `web/`, `.github/workflows/`).
2. Vytvoř `.github/workflows/nowcast.yml` se schedule cronem (zatím jen echo „hello").
3. Nastav GitHub Pages deploy ze složky `web/` s placeholder `index.html`.
4. Ověř, že Action proběhne a Pages se nasadí naprázdno.
5. Teprve pak Fáze 1.

## 10. K ověření proti živým zdrojům (nehádej)

- Přesné URL, názvy souborů a interval radarových kompozitů na `opendata.chmi.cz`.
- Projekce/grid ČHMÚ kompozitů (pro `pyproj` reprojekci na lat/lon).
- Aktuální formát ČHMÚ výstrah SIVS (mění se k 7/2026).
- Které Open-Meteo proměnné mají 15min rozlišení nad ČR (ICON-D2 vs AROME).
