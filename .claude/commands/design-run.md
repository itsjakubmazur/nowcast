---
description: Řízený průchod Impeccable design workflow pro nowcast — pokračuje tam, kde skončil
---
Jsi průvodce design workflow pro tuhle appku (počasové nowcasting rozhraní).
Řídíš se stavovým souborem `docs/impeccable-run.md`.
## Jak pracuješ
1. Přečti `docs/impeccable-run.md`. Pokud neexistuje, vytvoř ho podle šablony
   na konci tohohle souboru a zacommituj.
2. Najdi první nesplněný krok a pokračuj od něj.
3. Kroky označené **AUTO** provedeš bez ptaní.
4. U kroků označených **BRÁNA** se zastavíš, položíš otázky a čekáš na odpověď.
5. Po každém dokončeném kroku zaškrtni řádek ve stavovém souboru, dopiš
   jednou větou co jsi udělal, a zacommituj (kód i stavový soubor v jednom commitu).
6. V jednom spuštění projdi tolik AUTO kroků, kolik jich je před nejbližší BRÁNOU.
   U brány skonči odpověď a čekej.
## Jak se ptáš
Tohle je závazné:
- Otázky dávej **naráz, číslované, maximálně 5 v jedné dávce**.
- U **každé** otázky napiš svoje doporučení a zdůvodnění jednou větou.
- Formuluj je tak, aby šly zodpovědět jedním slovem nebo číslem.
- Vždy nabídni možnost odpovědět „vše default" = beru všechna tvoje doporučení.
- Neptej se na věci, které si můžeš zjistit z kódu nebo z `DESIGN.md`.
  Rozhodni sám a zapiš do sekce „Rozhodnutí".
- Neptej se na potvrzení něčeho, co už jednou schválil.
## Bezpečnostní pravidla
- Pracuj na branchi `design/impeccable`. Když neexistuje, založ ji.
  **Na konci každého spuštění merguj do main**, ať se vlastní příkazy a skilly
  načtou v dalším sezení.
- Jeden `/impeccable` příkaz = jeden commit. Nikdy neslučuj víc příkazů do commitu.
- V diagnostické fázi neměň ani jeden soubor s kódem.
- `npx` v tomhle prostředí nefunguje (sandbox blokuje balíčky z internetu),
  takže `npx impeccable detect` nespouštěj. Kontrolu odvede `audit` a `critique`.
- **Nesahej na datovou vrstvu**: zpracování ČHMÚ radarových HDF5 souborů, pysteps
  výpočty, Open-Meteo dotazy, GitHub Actions pipeline. Design workflow se týká
  jen prezentační vrstvy. Když by změna zasáhla data, napiš to jako otázku k bráně.
## Specifika tohohle projektu — čti pozorně
Tři věci, kde generický design postup dělá u počasové appky škodu:
1. **Radarová barevná škála není dekorace.** Při `/impeccable colorize` nesmíš
   měnit barevnou stupnici srážek za „hezčí" paletu. Konvenční škála je součást
   čitelnosti a uživatel ji zná z jiných zdrojů. Co se u ní řešit smí: kontrast
   proti podkladové mapě, bezpečnost pro barvoslepé (deuteranopie), rozlišitelnost
   nejnižších intenzit na mobilu na slunci. Změnu škály předlož jako otázku, nikdy
   ji neudělej sám.
2. **Narativní text generuje Gemini za běhu.** `/impeccable clarify` proto nemá
   editovat hardcoded stringy, ale **prompt**, kterým se text generuje — délku,
   tón, strukturu, co dělat, když se nic neděje. Napiš to explicitně do plánu.
3. **Hlavní metrika je čitelnost na jeden pohled.** Typický uživatel appku otevře
   na mobilu, venku, na pět sekund, s otázkou „bude za hodinu pršet". Každé
   rozhodnutí v `layout` a `typeset` posuzuj proti tomuhle, ne proti tomu,
   jak deska vypadá na desktopu ve tmě.
## Fáze a brány
| # | Krok | Režim |
|---|------|-------|
| 1 | `/impeccable init` — vyplň z odpovědí v sekci „Kontext" stavového souboru | AUTO |
| 2 | `/impeccable document` — zdokumentuj, co je fakticky v kódu | AUTO |
| 3 | Ukaž `PRODUCT.md` + `DESIGN.md`, u každého tokenu napiš odkud je | **BRÁNA A** |
| 4 | `/impeccable critique` po obrazovkách, jen reporty | AUTO |
| 5 | `/impeccable audit` — a11y (hlavně barvy!), responsivita, výkon, jen report | AUTO |
| 6 | Slož `docs/design-backlog.md` — prioritizovaně, s dopadem a rizikem | AUTO |
| 7 | Předlož backlog ke schválení a navrhni, co vyhodit | **BRÁNA B** |
| 8 | `/impeccable shape` na hlavní přehled → plán do `docs/` | AUTO |
| 9 | Předlož plán | **BRÁNA C** |
| 10 | Implementace obrazovky: layout → typeset → colorize → adapt → clarify | AUTO |
| 11 | Shrň diff obrazovky, zeptej se na další | **BRÁNA D** (opakuje se) |
| 12 | `/impeccable harden` — chybové stavy datové vrstvy (viz níž) | AUTO |
| 13 | `/impeccable onboard` — prázdné stavy, první návštěva, vysvětlení metodiky | AUTO |
| 14 | `/impeccable animate` — hlavně radarová animace, střídmě jinde | AUTO |
| 15 | `/impeccable extract` + `/impeccable polish` | AUTO |
| 16 | Finální `/impeccable audit`, souhrn rozdílů proti výchozímu stavu | AUTO |
| 17 | Předlož souhrn celého běhu a návrh na merge | **BRÁNA E** |
Kroky 10 a 11 se opakují pro každou obrazovku ze schváleného backlogu.
Pro krok 12 (`harden`) pokryj konkrétně: radarová data starší než 15 minut,
nedostupný ČHMÚ zdroj, selhání Gemini generování narativu, nulové srážky
v celém výhledu, pomalé nebo žádné připojení, čitelnost za plného slunce
i v noci.
## Šablona stavového souboru
```markdown
# Impeccable run — stav
Branch: design/impeccable
Poslední aktualizace: <datum>
## Kontext pro /impeccable init
- Surface: product (utilita, ne marketingová stránka)
- Co to je: nowcasting počasí pro nejbližší 1–2 hodiny — radarová extrapolace
  z ČHMÚ dat přes pysteps, doplněná Open-Meteo predikcí a narativním
  shrnutím generovaným Gemini 2.5 Flash
- Publikum: já a pár lidí, kteří chtějí vědět, jestli teď vyjít z domu.
  Mobil, venku, pár sekund pozornosti, opakované návraty během dne
- Obrazovky: hlavní přehled (aktuální situace + narativ), radarová
  mapa/animace, timeline srážek na příští hodiny, detail/graf,
  metodika a zdroje dat
- Osobnost: meteorologický nástroj — data first, vysoká informační hustota
  bez chaosu, střízlivé, dark mode výchozí, důvěryhodné.
  NE roztomilé, NE velké ikonové sluníčko, NE gradienty přes celou obrazovku
- Voice: věcná čeština, konkrétní čísla a časy, žádné „nádherný slunečný den".
  U narativu z Gemini: krátce, konkrétně, s časem a intenzitou
- Anti-reference: generické weather appky s obřím počasovým ikonem a
  purple→blue gradientem, karty v kartách, dekorativní glassmorphism,
  animované pozadí
- Mantinely: statická stránka na GitHub Pages, build přes GitHub Actions,
  mobile-first, funguje na slabém připojení, žádná těžká animační knihovna.
  Radarová barevná stupnice zůstává meteorologicky konvenční.
## Postup
- [ ] 1. init
- [ ] 2. document
- [ ] 3. BRÁNA A — kontrola kontextu
- [ ] 4. critique po obrazovkách
- [ ] 5. audit
- [ ] 6. backlog
- [ ] 7. BRÁNA B — schválení backlogu
- [ ] 8. shape hlavního přehledu
- [ ] 9. BRÁNA C — schválení plánu
- [ ] 10.–11. implementace po obrazovkách (doplň seznam po BRÁNĚ B)
- [ ] 12. harden — chybové a zastaralé stavy dat
- [ ] 13. onboard — prázdné stavy a metodika
- [ ] 14. animate — radarová animace
- [ ] 15. extract + polish
- [ ] 16. finální audit
- [ ] 17. BRÁNA E — souhrn a merge
## Rozhodnutí
- npx v tomhle prostředí nefunguje, kroky s `impeccable detect` vynechány
## Otevřené otázky
<věci, na které se zeptáš u nejbližší brány>
```
