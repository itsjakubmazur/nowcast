# Impeccable run — stav

Branch: design/impeccable
Poslední aktualizace: 2026-08-09

> **Poznámka k předvyplnění.** Tenhle soubor nevznikl na začátku běhu, ale až
> potom, co část práce proběhla mimo `/design-run` — přímo v konverzaci. Kroky
> 1, 2, 4 a 5 se skutečně staly a jejich výstupy jsou v repu; zaškrtnuté jsou
> proto zpětně, ne slepě. Krok 3 (BRÁNA A) zaškrtnutý NENÍ, protože se nikdy
> neodehrál jako brána a `DESIGN.md` se mezitím změnil — je to první, kde se
> runner musí zastavit.
>
> Nasazené opravy z kroků 4 a 5 už v kódu jsou (21 nálezů, šest commitů, viz
> „Co je hotové" níž). Backlog v kroku 6 proto nezačíná od nuly: skládá se
> ze zbytků, které opravy nepokryly.

## Kontext pro /impeccable init

- Surface: product (utilita, ne marketingová stránka)
- Co to je: nowcasting počasí pro nejbližší 1–2 hodiny — radarová extrapolace
  z ČHMÚ dat přes pysteps, doplněná Open-Meteo predikcí a narativním
  shrnutím generovaným Gemini 2.5 Flash
- Publikum: já a pár lidí, kteří chtějí vědět, jestli teď vyjít z domu.
  Mobil, venku, pár sekund pozornosti, opakované návraty během dne
- Obrazovky: appka je **jednostránková**. „Obrazovky" jsou čtyři sekce jedné
  stránky, mezi kterými navigace skáče (nic neskrývá): **Teď** (nowcast,
  odpočet do deště, srážkové sloupce 2 h / 12 h, druhý názor ČHMÚ), **Dnes**
  (rozbalený detail dneška — hodiny, fáze, meteogram), **Týden** (7 dní
  s rozklikem dne), **Data** (konsenzus modelů, žebříček přesnosti, verifikace,
  ovzduší, astro, klima, historie). Nad tím vším živá radarová mapa
  s časovou osou a vrstvami. Samostatná obrazovka „metodika a zdroje dat"
  **neexistuje** — metodika žije v poznámkách pod panely a v patičce.
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

- [x] 1. init — `PRODUCT.md` v kořeni (schema 1). Platforma web, 5 produktových
      principů, explicitně nerozhodnuto „bez runtime serveru".
- [x] 2. document — `DESIGN.md` + sidecar `.impeccable/design.json`
      (schemaVersion 2, 11 komponent, 8stupňové tonální rampy).
- [x] 3. BRÁNA A — kontrola kontextu. Doložený původ všech 16 barev, 5 typo
      rolí a 5 poloměrů proti `web/css/app.css`; našly se dvě nepřesnosti
      v komponentách `DESIGN.md`. Odpověď „vše default" → 5 rozhodnutí níž.
- [x] 4. critique — druhý běh nad `web/index.html`, dvouagentní (A design
      review bez detektoru, B detektor + pixelová měření). **27/40**, 1× P0,
      3× P1. Trend 25 → 27. Snímek:
      `.impeccable/critique/2026-08-09T12-39-06Z__web-index-html.md`.
      **Vyvrací moje dřívější tvrzení**, že „jedna pravda o dešti" je hotová:
      změřeno 14:54 (hlava) / 14:45 (2h tělo) / 17:35 (12h tělo) v jedné kartě.
      První běh: `.impeccable/critique/2026-08-08T11-47-07Z__web-index-html.md`.
- [x] 5. audit — druhý běh, **15/20** (z 13/20). A11y 3, Performance 3,
      Theming 3, Responsive 3, Implementation Integrity 3 — Accessibility
      a Theming se zvedly z 2, obojí drží na trojce jen kvůli světlému motivu.
      0× P0, 3× P1, 5× P2, 4× P3. Report zapsaný do repu podle rozhodnutí 3:
      `.impeccable/audit/2026-08-09T12-45-00Z__web-index-html.md`.
- [x] 6. backlog — `docs/design-backlog.md`. 17 položek sloučených z kritiky
      a auditu (duplicity označené jako shoda dvou metod), každá s dopadem,
      rizikem a příkazem. Návrh vyhodit tři: pevné šířky na `clamp()`,
      přerozdělení typografických rolí, předělání dialogu Nastavení.
- [ ] 7. BRÁNA B — schválení backlogu **← ZDE POKRAČUJ**
- [ ] 8. shape hlavního přehledu
- [ ] 9. BRÁNA C — schválení plánu
- [ ] 10.–11. implementace po obrazovkách (doplň seznam po BRÁNĚ B)
- [ ] 12. harden — chybové a zastaralé stavy dat
- [ ] 13. onboard — prázdné stavy a metodika
- [ ] 14. animate — radarová animace
- [ ] 15. extract + polish
- [ ] 16. finální audit
- [ ] 17. BRÁNA E — souhrn a merge

## Co je hotové (opravy z kroků 4 a 5)

Všech 21 nálezů z kritiky i auditu je opravených a pushnutých. Šest commitů:

| Oblast | Co se změnilo | Ověřeno |
|---|---|---|
| Pásmo 769–1080 px | `#right-panel { display: none }` dělalo z `TÝDEN` a `DATA` mrtvá tlačítka; `rail.js` panel přestěhuje do levé lišty | na 900 px `parent=left-card`, `position:static`, viditelný |
| Jedna pravda o dešti | `#outlook-msg` stál nad `#pp-track` a jeho 12h věta byla vidět i na 2h záložce; věta je teď uvnitř každého těla (`precipSummary`) | 2 věty, každá ve svém `.pp-body` |
| Modální dialogy | tři překryvy neměly `role`, fokus ani Escape; nový `modal.js` | 20 Tabů, 0 úniků; Escape zavírá; fokus zpět na spouštěč |
| Fokus | `#timeline`, `#opacity-slider`, `#ai-ask` měly `outline:none` bez náhrady | prstenec kolem jezdce / `focus-within` na řádku |
| Struktura dokumentu | 0 nadpisů, 0 landmarků, 0 `aria-live` | h1 1, h2 15, main 1, aria-live 4 |
| Kontrast | bílá na akcentu 3,65:1; oranžová jako text 2,09:1 | `--accent-solid` 5,31:1; nejnižší `--X-text` 4,71:1 (light), 4,85:1 (dark) |
| Paleta grafů | tailwindové hexy v JS; `palette.js` je čte z `:root` | 0 tailwindových barev v datasetech |
| Dotykové cíle | `.pp-tab` 31×19, `.mtab` 37×20, `#ai-ask-send` 17×18 | všechny 44 px svisle (překryv, vzhled beze změny) |
| Ořez týdne | řádek potřeboval 331,6 px do panelu 267 px, `overflow-x:hidden` uřízl 59 px | 277 vs 277, žádný přesah |
| Bouřkový banner | na mobilu 5. blok, pod 16 přepínači mapy | order 1, hned za úchytem sheetu |
| Prázdné stavy | 4 cesty selhání sítě panel tiše skryly; `emptystate.js` | hlavička + věta + „Zkusit znovu" |
| Výkon | `transition: width` × 2 → `transform: scaleX()`; 37/37 ikon lazy | 0 přechodů na šířku |
| Motiv | tlačítko umělo jen 2 stavy, k „podle systému" nešlo zpět | 3 volby v Nastavení, obě cesty v synchronu |

Smoke test dostal regresní hlídky na kontrast (oba motivy), paletu grafů,
dotykové cíle, strukturu dokumentu, modálnost dialogu, ořez řádků a tři stavy
motivu. `npm run test:smoke` prochází.

## Rozhodnutí

### Z BRÁNY A (2026-08-09, odpověď „vše default")

1. **`DESIGN.md` se opraví ručně, ne přes `document`.** Zaostal za kódem ve dvou
   místech: `segment-active` hlásí `{colors.radarova-modr}` (`#0A84FF`), ale kód
   po opravě kontrastu používá `--accent-solid` (`#0068D6`); `button-glass-hover`
   má `backgroundColor: {colors.citelny-text}`, zatímco v kódu je
   `color-mix(in srgb, var(--text) 8%, var(--glass2))` — zápis ztratil těch 8 %
   a dokument tvrdí bílou na bílé. Chybí taky čtyři moduly (`modal.js`,
   `emptystate.js`, `rail.js`, `palette.js`). Znovupuštění `document` by přepsalo
   ručně psané pasáže a pojmenovaná pravidla, která nesou důvody, ne popis.
2. **`critique` se pouští znovu v kroku 4.** Uložený snímek (25/40, 2× P0, 4× P1)
   popisuje stav před opravnou vlnou; bez nového běhu čte `polish` v kroku 15
   backlog, který neexistuje.
3. **Audit report se ukládá do repu**, do `.impeccable/audit/` vedle kritiky.
   Dosud žil jen v konverzaci a s ní by zmizel.
4. **Seznam obrazovek srovnán s kódem** (viz sekce Kontext). Appka je
   jednostránková se čtyřmi sekcemi; obrazovka „metodika a zdroje dat"
   neexistuje a krok 10 by ji jinak hledal.
5. **Kritika má jeden cíl, `web/index.html`, ne pět.** `critique-storage` sleduje
   trend podle slugu; pět slugů by rozbilo porovnatelnost s dosavadními 25/40.

### Provozní

- Branch `design/impeccable` založená z `claude/web-improvements-brainstorm-4osku9`
  (2026-08-09). Na konci každého spuštění se merguje do `main`.
- `npx` v tomhle prostředí nefunguje, kroky s `impeccable detect` vynechány.
  **Bundlovaný detektor ale funguje** a spouštět se má:
  `node .claude/skills/impeccable/scripts/detect.mjs --json web/index.html web/js`.
  Poslední běh: **14 nálezů** (dolů z 39 před opravami).
- Barevná stupnice úhrnů srážek v `web/js/accum.js` je **doménová škála**, ne
  UI paleta — stejná kategorie jako dBZ stupnice radaru. Detektor ji hlásí jako
  7 nedokumentovaných barev; platí pro ni pravidlo „radarová škála není
  dekorace" z `/design-run`. Řešit se u ní smí kontrast, deuteranopie a
  rozlišitelnost nejnižších intenzit, ne estetika. Do `DESIGN.md` patří jako
  pojmenovaná škála, ne jako drift k opravě.
- Legenda radaru se odvozuje z manifestu dat, ne z pevného seznamu v kódu —
  změna škály v pipeline se propíše do UI sama.
- Narativ generuje **Gemini 2.5 Flash** v Cloudflare Workeru. `claude.md`
  tvrdí, že Claude API — je to zastaralé, ne aktuální stav. Pro krok
  `/impeccable clarify` platí, že se edituje prompt ve workeru, ne stringy
  ve frontendu.
- Frontend je bez build stepu (ES moduly přímo v prohlížeči), Chart.js
  a Leaflet z CDN, striktní CSP v `index.html`. Žádná animační knihovna
  se nepřidává.
- Pohyb respektuje `prefers-reduced-motion` vypnutím, ne zkrácením na `0.01ms`.
  Audit to potvrdil jako správně řešené — v kroku 14 (`animate`) to nesmí
  zmizet.

## Otevřené otázky

Pro **BRÁNU A** (nejbližší zastávka):

1. **`DESIGN.md` se dnes změnil a sekce Components zaostala.** Přibyly čtyři
   moduly, o kterých dokument neví: `modal.js` (dialogy), `emptystate.js`
   (prázdný a chybový stav), `rail.js` (stěhování panelů podle šířky),
   `palette.js` (barvy grafů ze systému). Barvy a dvě nová pojmenovaná pravidla
   („plochy a textu", „tří stavů") doplněné jsou. Doporučení: doplnit komponenty
   v kroku 6, ne otevírat `document` znovu — přepsal by ručně psané pasáže.

2. **Uložený snímek kritiky je neaktuální.** Hlásí 25/40 se 2× P0 a 4× P1;
   všechny jsou opravené. Doporučení: `/impeccable critique web/index.html`
   znovu, aby existovalo porovnatelné číslo — jinak `polish` v kroku 15 čte
   backlog, který neexistuje.

3. **Audit report se nikdy nezapsal do repu**, žije jen v konverzaci.
   Doporučení: při dalším běhu ho uložit vedle kritiky do `.impeccable/`.

Mimo design workflow, **týká se datové vrstvy → jen k rozhodnutí, neřešit sám**:

4. **Neověřený backfill `chmi_stats`.** Při bumpu `PARSER_V` na 4 mělo pokrytí
   115 z 292 stanic. `data/` je v `.gitignore`, takže ověření vyžaduje probe
   workflow v GitHub Actions. Není to prezentační vrstva.

5. **`claude.md` je zčásti nepravdivý** a konkuruje `PRODUCT.md` jako autorita
   (tvrdí Claude API pro naraci, popisuje odstraněný `fc24` proužek). Buď ho
   označit jako historický dokument, nebo srovnat se skutečností.

Pro **BRÁNU B** (backlog):

6. Zbylých 13 barevných nálezů detektoru mimo doménovou škálu:
   `web/js/storms.js:29,32` (`#FF375F`, `#64D2FF`), `web/js/stations.js`
   ×3 (`#f87171`), `web/js/hydro.js:10` (`#a16207`). Doporučení: do tokenů,
   je to stejný druh driftu jako tailwindová paleta, jen zbytek.

7. Nález „Em-dash overuse, 13 em-dashes in body text" je **falešně pozitivní** —
   většina těch pomlček jsou `—` placeholdery prázdné hodnoty, ne typografie.
   Pravidlo se spouští proto, že statická slupka má málo textu.
   Doporučení: přidat do `.impeccable/critique/ignore.md`.
