# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Osobní nástroj. Primárním a v podstatě jediným uživatelem je autor projektu,
případně pár lidí kolem něj. Není to produkt pro cizí návštěvníky.

Z toho plyne konkrétní důsledek pro budoucí práci: **první dojem, onboarding
a vysvětlování pojmů nejsou cíl**. Uživatel ví, co je echotop, CAPE nebo
COTREC, a nepotřebuje k tomu průvodce. Hustota informací smí vyhrát nad
přívětivostí pro nováčka.

Situace použití: konkrétní místo v ČR (vlastní stanice stojí v Brně a
Vendryni, sondy v repu cílí i na Rychvald u polské hranice), potřeba vědět,
co se bude dít v příštích minutách až hodinách, typicky na mobilu.

## Product Purpose

Krátkodobá předpověď počasí (nowcasting) pro libovolný bod, postavená na
vlastním výpočtu z radarových dat ČHMÚ místo na převzatém čísle z cizí API.

Úspěch není "hezká předpověď", ale **meteorologický nástroj pro nadšence**:
hloubka a poctivá data jsou hodnota sama o sobě. Uživatel chce vidět do
stroje — žebříček modelů, verifikaci proti měření, aerologii, rekordy — ne
jen výsledek. Odborné panely proto nejsou balast, který by se měl schovávat;
jsou důvod, proč nástroj existuje.

## Positioning

Vlastní radarová extrapolace na 0–2 h pro konkrétní bod, kterou žádná běžná
appka nedá: Open-Meteo řekne "mezi 17 a 18 spadne 1,2 mm", tenhle nástroj
řekne "začne v 17:42". K tomu vlastní účetnictví přesnosti — nástroj měří,
jak se jednotlivé modely trefují **u tvojí nejbližší stanice**, a změřenou
systematickou odchylku odečítá ze zobrazeného čísla.

## Operating Context

- Data se počítají dávkově v naplánované pipeline, ne na vyžádání. Web je
  statická výloha nad předpočítanými JSON soubory.
- Provoz stojí na bezplatných službách třetích stran (GitHub Actions, GitHub
  Pages, Cloudflare Workers, Open-Meteo, opendata ČHMÚ). Jejich dostupnost a
  limity jsou reálná provozní proměnná, ne teoretické riziko.
- Instaluje se jako PWA a funguje i offline z posledních stažených dat.

## Capabilities and Constraints

Potvrzené schopnosti:

- **0–2 h nowcast** z radaru ČHMÚ (pysteps, Lucas–Kanade advekce, Marshall–Palmer
  Z–R), včetně pravděpodobnosti z ensemble perturbované advekce.
- **Hodinová a týdenní předpověď** z Open-Meteo (`best_match`), plynule
  navázaná na nowcast (váha radaru klesá k nule ve 120. minutě).
- **Hodnocení přesnosti modelů per lokace** proti měření nejbližší stanice
  (ČHMÚ, WU, letištní METAR do 40 km, s přepočtem na nadmořskou výšku), včetně
  sdíleného učení přes Worker.
- **Data ČHMÚ open data**: radar, COTREC nowcast, 436 srážkoměrů, stanice,
  normály 1991–2020, historické řady, aerologie, kvalita ovzduší, hlásné
  profily, výstrahy CAP, ALADIN z GRIBu.
- **Mapové vrstvy**: radarová smyčka, světový radar a satelit (RainViewer),
  blesky (Blitzortung), částice větru, teploty ze stanic celosvětově.
- **Světový režim** — mimo pokrytí českého radaru appka funguje dál nad
  RainViewer a modelem.
- Web Push upozornění a AI verdikt/chat přes Cloudflare Worker.

Omezení a technická fakta:

- Frontend je bez build stepu — ES moduly načítané přímo prohlížečem.
- Chart.js a Leaflet z CDN, striktní CSP v `index.html`.
- Pohyb v UI respektuje `prefers-reduced-motion` (vypíná, nezkracuje).

**Explicitně nerozhodnuto:** "bez runtime serveru" **není** závazek. Současná
architektura server nemá, ale při dotazu na závazné zásady tahle možnost
vybraná nebyla — budoucí práce tedy runtime server vyloučit nemusí a nemá ho
považovat za danou hranici.

## Brand Commitments

- Název **nowcast**, PWA jméno "nowcast — počasí a radar ČR".
- **Čeština je jediný jazyk**, a to včetně odborných termínů. Anglická verze
  ani i18n se neplánují; překlad není odložený úkol, ale rozhodnutí proti.

## Evidence on Hand

Reálná data a artefakty, na kterých nástroj stojí:

- Vlastní stanice Weather Underground `IBRNO445` a `IVENDR18` (skutečná
  měření, ne ukázková data).
- `claude.md` — původní kickoff spec s misí a klíčovým principem.
- Verifikační historie v `pipeline/state/` a `data/accuracy*.json` — skutečné
  naměřené chyby predikcí, ne odhad.
- Testy: Playwright smoke nad vykresleným DOM (`tests/smoke.mjs`) a unit testy
  pipeline (`tests/test_*.py`).

Co k dispozici **není** a nesmí se vymýšlet: žádní uživatelé kromě autora,
žádné reference, testimonialy, čísla návštěvnosti ani ceník. Repozitář nemá
soubor LICENSE, takže licenci nelze tvrdit.

## Product Principles

1. **Fyzika počítá čísla, jazykový model píše příběh.** LLM dostává hotová
   strukturovaná data a dělá z nich větu. Nesmí žádné číslo vymyslet ani
   dopočítat — ani časy, ani úhrny, ani pravděpodobnosti.
2. **Nejistota se přiznává, nedopočítává.** Raději "zatím se učíme" než
   předstíraná přesnost. Chybějící data se nenahrazují odhadem, nezávislý
   druhý názor (COTREC) se ukazuje i když nesouhlasí, a korekce zobrazených
   čísel se popíše, ne provede potichu.
3. **Hloubka je funkce, ne balast.** Žebříček modelů, verifikace, rekordy a
   aerologie jsou důvod existence nástroje. Zjednodušovat je pryč kvůli
   domnělému nováčkovi znamená odstranit produkt.
4. **Jedna věc jednou.** Tatáž hodnota se nemá zobrazovat ve dvou
   granularitách nad sebou; duplicitní pohledy se slučují, ne přidávají.
5. **Měřit vlastní přesnost a jednat podle ní.** Nástroj si vede účetnictví,
   jak se trefuje, a výsledek promítá zpátky do zobrazených čísel — jinak je
   to jen ozdoba vedle předpovědi.
