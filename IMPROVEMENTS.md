# Návrhy na vylepšení webu — funkce, UI, UX, technika

Výstup důkladné revize codebase (frontend `web/index.html`, pipeline, worker, workflow).
Seřazeno podle dopadu; u každého bodu je i odhad pracnosti.

---

## Stav implementace

**Vše implementované a nasazené.** Worker `nowcast-narrate` běží na
`https://nowcast-narrate.kubajzek.workers.dev` (ne `itsjakubmazur.workers.dev`,
jak jsem původně odhadl — `web/index.html`/`web/js/state.js` teď mají
správnou hodnotu). KV namespace pro Web Push i VAPID klíč jsou nastavené,
`wrangler deploy` prochází, cron trigger (`*/10 * * * *`) je zaregistrovaný.

Historie ladění (pro budoucí referenci): `CF_API_TOKEN` v GitHub Secrets
původně obsahoval Account ID místo skutečného tokenu — opraveno.

**Vědomý kompromis:** blesky (bod 1.2) jsem **nepřipojil na Blitzortung**.
Jejich WebSocket protokol je neoficiální/reverse-engineered a nemám způsob,
jak ho v tomto sandboxu (bez odchozího přístupu na jejich servery) ověřit —
nasadit neotestovaný binární decoder by bylo horší než bug, který opravuje.
Místo toho jsem opravil poctivost UI: vrstva se přejmenovala na „aktivní
srážkové/konvekční jádro“ a počítá se z vlastního nowcastu (`GRID.act`),
místo aby tvářila cizí radarová data jako blesky. Napojení na Blitzortung
zůstává validní budoucí vylepšení, jen vyžaduje živé testování mimo tento
sandbox.

---

## TL;DR — top 10

1. **AI verdikt se na webu vůbec nezobrazuje** — hlavní USP projektu je odpojené (viz 1.1). Zapojit worker per-location.
2. **„Blesky" nejsou blesky** — vrstva ⚡ kreslí radarové dlaždice RainVieweru (viz 1.2). Nahradit Blitzortungem, nebo přejmenovat.
3. **Prodat nowcast na první pohled**: hero countdown „🌧 Déšť za 23 min, potrvá ~40 min" — data už v `GRID.act` jsou, jen se schovávají v mini-sparkline (viz 2.1).
4. **Automatické načtení posledního místa** při návratu — dnes uživatel vždy začíná prázdnou obrazovkou (viz 3.1).
5. **15minutová data Open-Meteo (`minutely_15`)** pro prvních pár hodin místo hodinových (viz 2.2).
6. **Legenda radaru** — uživatel neví, co barvy znamenají (viz 3.3).
7. **Meteogram** (teplotní křivka + srážkové sloupce + vítr v jednom grafu) místo pouhých sloupečků (viz 3.2).
8. **SVG ikony místo emoji** — konzistence napříč OS, profesionální vzhled (viz 4.1).
9. **Verifikace přesnosti nowcastu** — „za posledních 30 dní jsme čas příchodu deště trefili na ±8 min" — nikdo z konkurence nemá (viz 2.5).
10. **Race condition + technická hygiena**: abort starých requestů, SRI/CSP, relativní cesty v SW, mockupy pryč z deploye (viz 1.3, 6).

---

## 1. Opravy, které podkopávají důvěru

### 1.1 AI verdikt existuje, ale nikdy se nezobrazí ⚠️ (nejvyšší priorita)
- `pipeline/narrate.py` volá Gemini každých 10 min a ukládá verdikt do `forecast.json` — **pro fixní bod Praha**.
- `workers/narrate/index.js` je nasazený Cloudflare Worker, který umí verdikt **pro libovolné místo** — ale `index.html` ho nikde nevolá (grep na `workers.dev`/`narrate` nenajde nic).
- Frontend: `templateVerdict()` sice umí vrátit `FORECAST.verdict.text` (Gemini), ale obě volací místa (`showForecast`, `renderLocationVerdict`) si z návratu berou jen `chips` — text zahodí a zobrazí JS šablonu.
- **Důsledek:** placené Gemini volání běží 144× denně naprázdno a uživatel vidí jen šablonové věty.
- **Fix:** ve `showFc24()` po načtení Open-Meteo zavolat worker (POST lat/lon/label), výsledek cachovat v `localStorage` s TTL ~15 min na zaokrouhlené souřadnice; JS šablona zůstává jako okamžitý fallback (progressive enhancement: šablona hned, AI text ji nahradí). Zvážit zrušení Gemini kroku v pipeline (duplicitní).

### 1.2 „Blesky" jsou ve skutečnosti radar
- `fetchLightning()` čte `data.radar.past` z RainViewer `weather-maps.json` — to jsou **radarové** snímky, ne výboje. Vrstva ⚡ tedy jen zdvojuje radar s jinou paletou.
- `updateStormDist()` počítá „vzdálenost bouřky" z radarové aktivity gridu (`a[2] >= 5 mm/h`), ne z blesků.
- **Fix (volby):**
  a) napojit **Blitzortung** (WebSocket, zdarma, už je v CLAUDE.md jako plánovaný zdroj) — reálné výboje jako tečky s fade-out podle stáří, vzdálenost/směr/trend z nich;
  b) minimálně přejmenovat na „aktivní jádra srážek", ať UI nelže.

### 1.3 Race condition při výběru místa
- `showFc24()` má AbortController jen na timeout; při rychlém klikání (mapa → našeptávač → oblíbené) se předchozí fetch neabortuje a **starší odpověď může přepsat novější místo**.
- **Fix:** modulový `let _fc24Ctrl` — před novým fetchem `_fc24Ctrl?.abort()`.

### 1.4 Service worker / PWA na project pages
- `sw.js` cachuje `"/"` a `"/index.html"`, `manifest.json` má `start_url: "/"`. Pokud web běží na `itsjakubmazur.github.io/nowcast/`, absolutní cesty míří mimo aplikaci → `cache.addAll` selže a **SW se vůbec nenainstaluje**. Použít relativní cesty (`"./"`, `"./index.html"`, `"start_url": "./"`). (Pokud běží na custom doméně v rootu, neplatí — ověřit.)

### 1.5 Mockupy se deployují do produkce
- `mockup-a-dark.html`, `mockup-b-light.html`, `mockup-c-hybrid.html` jdou s `web/` na Pages a jsou veřejně dostupné (i pro roboty). Přesunout do `design/` mimo deploy, nebo vyloučit při uploadu artefaktu.

### 1.6 Drobné
- **XSS povrch:** jména WU/ČHMÚ stanic (externí data) se vkládají přes `innerHTML` do popupů a panelů — escapovat (`textContent` nebo malý `esc()` helper).
- `renderLocationVerdict` referencuje nedefinované `lat`/`lon` (`_currentLat ?? lat`) — dnes to zachraňuje `try/catch`, ale je to nastražená mina.
- Tlačítko 🌍 v `toggleGlobalMode` střídavě přidává/odebírá `active` a přepisuje text ve zmatečném pořadí — zjednodušit.
- `alert()` pro chyby geolokace a limit oblíbených — nahradit nenásilným toastem (notif-bar už existuje, zobecnit).

---

## 2. Největší funkční příležitost: prodat nowcast

Projekt má unikátní data (vlastní advekce ČHMÚ radaru), ale UI je prezentuje stejně jako každá jiná appka prezentuje NWP. Tady se dá nejvíc odlišit:

### 2.1 Hero countdown „Déšť za X minut“
`GRID.act[pt] = [start, end, peak, total]` už obsahuje vše potřebné. Místo malého sparkline dole u radaru dát **nahoru do levé karty velký, živý prvek**:

> 🌧 **Déšť za 23 min** (16:35–17:20) · špička 4 mm/h · úhrn ~3 mm

s odpočtem, který tiká po minutách (klient-side, bez re-fetch). Když nic nehrozí: „☀️ Nejbližší 2 h bez srážek" + kdy případně dle NWP. To je přesně věta z mise v CLAUDE.md — dnes ji web neumí říct na první pohled.

### 2.2 15minutová data (`minutely_15`)
Frontend v `showFc24` stahuje jen `hourly`. Open-Meteo dává pro střední Evropu **15min rozlišení** (ICON-D2/AROME) — přidat `&minutely_15=precipitation,...` a prvních ~6 h kreslit v 15min krocích. Skokové zlepšení užitečnosti grafu za ~hodinu práce.

### 2.3 Plná časová řada nowcastu pro aktivní body
`act` nese jen obálku (start/end/peak/total), takže srážkový sparkline je obdélník. Pipeline (`grid.py`) může pro aktivní body publikovat celou řadu (12 hodnot à 10 min, kvantovanou na 0.1 mm/h) — JSON naroste minimálně (jen aktivní body) a křivka bude vypadat reálně, včetně náběhu a odeznění.

### 2.4 Explicitní hranice důvěry nowcast × NWP
Zásada z CLAUDE.md „nikdy neprezentuj extrapolaci > 2 h jako jistotu" v UI chybí. V grafech a verdiktu vizuálně oddělit: plná čára = radar-nowcast (0–2 h), čárkovaná/průsvitná = model, s tooltipem „odhad z modelu, nižší jistota". Levné a buduje důvěru.

### 2.5 Verifikace přesnosti (nikdo to nedělá)
Pipeline po každém běhu ví, co předpověděla před hodinou, a z MERGE/aktuálního radaru ví, co se stalo. Logovat do malého JSON (klouzavé okno 30 dní): trefa/minutí příchodu srážek, chyba v minutách, bias úhrnu. Na web dát nenápadné „📊 Přesnost: příchod srážek ±9 min (30 dní)". Obrovský diferenciátor důvěryhodnosti — a zpětná vazba pro ladění prahů.

### 2.6 Skutečné push notifikace
Dnes `Notification` API funguje jen s otevřenou stránkou. Worker už existuje → přidat **Web Push**: subscriptions do Cloudflare KV, cron trigger workeru každých 10 min zkontroluje oblíbená místa proti `forecast_grid.json` a pošle push („Za 20 min déšť u Brandýs n. L."). Střední pracnost (VAPID klíče, KV, SW `push` handler), ale změní appku z „výlohy" na službu.

---

## 3. UX

### 3.1 První dojem / návraty
- **Auto-obnova posledního místa**: uložit poslední `lat/lon/label` do localStorage a při startu rovnou zobrazit (priorita: URL params → poslední místo → první oblíbené → nic). Dnes se stav drží jen v URL, kterou si nikdo nezáložkuje.
- Prázdný stav vylepšit: místo věty „Vyhledejte obec…" nabídnout 3–4 kliknutelná velká města + tlačítko poloha.

### 3.2 Meteogram
24h panel jsou dnes sloupečky s čísly. Jeden **kombinovaný graf** (Chart.js už je načtený): teplotní křivka + pocitová (čárkovaně), srážkové sloupce s pravděpodobností (sytost), nárazy větru jako tečky/vlaječky, noc podbarvená. Jedna obrazovka řekne víc než 14 sloupečků; sloupečky mohou zůstat jako kompaktní varianta na mobilu.

### 3.3 Legenda radaru
Na mapě chybí škála intenzity (paleta z `render.py` je pevná 5–65 dBZ). Malá horizontální legenda „slabý → intenzivní" v rohu mapy, klik = vysvětlení dBZ vs mm/h. Bez ní jsou barvy jen dekorace.

### 3.4 Našeptávač
- Šipky ↑↓ + Enter (aria `role="combobox"` / `aria-activedescendant`), Enter bez výběru = první výsledek, Esc = zavřít.
- Historie posledních hledání (localStorage) při fokusu prázdného pole.

### 3.5 Mobil (pravděpodobně hlavní platforma pro počasí)
- Desktop-first layout se na mobilu jen „rozbalí" do dlouhého scrollu. Zvážit **bottom-sheet** pattern: mapa fullscreen, karta s verdiktem jako tažný sheet se snap-pointy (peek / půl / full).
- Touch targety: `.ctrl` tlačítka radaru mají ~28 px — minimum je 44 px.
- Radar ovládání sticky pod mapou (dnes se odscrolluje).
- `100dvh` místo `100%` (adresní řádek na iOS).

### 3.6 Radar — plynulost a čitelnost
- **Crossfade mezi snímky**: dva `imageOverlay`, opacity tween ~200 ms — animace přestane „blikat". Levné, velký pocitový efekt.
- Countdown „další aktualizace za ~X min" (pipeline běží à 10 min, `generated_at_utc` je známé).
- Kolečko myši nad timeline = krokování snímků.

### 3.7 Výstrahy ČHMÚ
CAP polygony se už parsují v pipeline (`wmatch`) — přidat je jako **mapovou vrstvu** (podbarvené polygony dle barvy výstrahy) + kliknutelný panel s textem výstrahy a platností. Dnes jsou výstrahy jen chip bez detailu.

### 3.8 Sdílení
URL stav existuje (`?lat&lon&q`) — přidat tlačítko „Sdílet" (Web Share API, fallback copy-to-clipboard). Plus OG meta tagy (`og:title`, `og:description`, `og:image`), ať odkaz v chatu nevypadá prázdně; `og:image` může pipeline generovat z aktuálního radaru.

---

## 4. UI / vizuál

### 4.1 Ikony
Emoji (☀️🌧⛈) vypadají na Windows/Android/iOS pokaždé jinak a lámou vizuální konzistenci. Nahradit SVG sadou — doporučuji **Meteocons** (MIT, animované i statické, den/noc varianty, mapují se 1:1 na WMO kódy). Platí i pro ikonky vrstev a tlačítek (📍🌙↺ → line ikony).

### 4.2 Kontrast a typografie
- `--muted #5a6480` na `#080c18` ≈ 3.4:1 — pod WCAG AA pro malé texty, a používá se na `.56–.72rem` labely. Zesvětlit muted (~`#8b93ab`) a zvednout minimální velikost na ~0.65rem.
- Samoúčelně malé texty (`.56rem` labely karet) na mobilu neučtou.
- Self-host **Inter** (subset latin-ext, `font-display: swap`) — Google Fonts blokuje render a tahá třetí stranu (GDPR).

### 4.3 Layout bez magických čísel
`#layer-selector { left: 284px; bottom: 88px }`, `#left-card { bottom: 100px }` … na šířkách ~800–1100 px se prvky překrývají s pravým panelem. Přejít na CSS grid pro celkové rozvržení (mapa jako podklad, panely v grid-areas), breakpoint pro „střední" šířky (skrýt pravý panel do záložky).

### 4.4 Konzistence komponent
Tři vizuálně odlišné implementace téže karty (`.fc-stat`, `.sd-card`, `.wu-detail-cell`) — sjednotit do jedné třídy s modifikátory. Stejně tak 3 implementace grafů (Chart.js config se 3× opakuje) → jedna `makeChart(cfg)`.

### 4.5 Témata
- Respektovat `prefers-color-scheme` jako default (dnes je natvrdo dark); ruční přepínač ukládá override.
- `<meta name="theme-color">` měnit s tématem (jinak světlý režim má tmavý status bar).
- Světlé téma doladit: radar na světlé mapě Positron zaniká — mírně ztmavit podklad pod radarem, nebo zvýšit sytost palety ve světlém režimu.

---

## 5. Funkční rozšíření (nová hodnota)

| Nápad | Zdroj dat | Pracnost | Poznámka |
|---|---|---|---|
| **Kvalita ovzduší + pyl** | Open-Meteo air-quality API (zdarma, stejný vzor) | ~1 den | PM2.5/PM10/O₃ + pylový index do levé karty a 7denního výhledu |
| **Sníh/zima** | už v datech (OM `snowfall`, ČHMÚ `snow_cm`) | ~1 den | srážkový typ v meteogramu, zimní paleta radaru |
| **Východ/západ slunce + měsíc** | OM daily (sunrise/sunset už se stahuje) | hodiny | denní světlo jako pás v meteogramu, fáze měsíce |
| **Embed režim** | — | hodiny | `?embed=1` skryje chrome — vložitelná mapa/karta |
| **Porovnání modelů** | OM `&models=icon_d2,arome_france,...` | ~2 dny | „rozptyl modelů" jako pás nejistoty v meteogramu |
| **Delší radarová historie** | vlastní archiv frames | ~1 den | „posledních 6 h" toggle; jen retention v pipeline |

---

## 6. Výkon, technika, udržitelnost

### 6.1 Struktura kódu
`index.html` má 3 000+ řádků a poroste. Bez build stepu (zásada z CLAUDE.md) lze i tak rozdělit: `<script type="module" src="js/app.js">` + moduly (`radar.js`, `stations.js`, `forecast.js`, `verdict.js`), CSS do `css/app.css`. Pages to servíruje beze změny deploye. Výrazně to zlevní každou další úpravu (i pro AI agenty 🙂).

### 6.2 Závislosti a bezpečnost
- **SRI hashe** na unpkg/jsdelivr skripty, nebo rovnou self-host Leaflet + Chart.js (zamčené verze, žádný výpadek CDN).
- `Content-Security-Policy` meta tag (omezit script-src na self + povolené CDN).
- Chart.js načítat lazy až při prvním grafu (ušetří ~200 kB na startu).

### 6.3 Data a cache
- `?v=${Date.now()}` u všeho → radar PNG se každých 5 min stahují znovu celé. Použít `generated_at_utc` z manifestu jako verzi (`?v=<timestamp>`): stejná data = cache hit, nová data = nová URL. Ušetří ~50–200 kB každý auto-refresh.
- `chmi_series.json` se stahuje celý kvůli jedné stanici — rozdělit per-station (`data/chmi_series/<id>.json`), načítat lazy.
- `loadData()` selže celé, když spadne `radar_manifest`/`forecast_grid` (bez `.catch`) — degradovat po částech: mapa + stanice fungují i bez radaru, radar i bez gridu.

### 6.4 Testy a monitoring
- **Playwright smoke test** v CI: stránka se načte, výběr místa vykreslí verdikt, radar play přepíná snímky.
- **JSON schema validace** výstupů pipeline (manifest, grid, forecast) — zachytí regresní změny formátu dřív než frontend.
- **Stale-data alert**: workflow krok, který selže/pošle notifikaci, když jsou publikovaná data starší než 60 min (cron na free tieru umí tiše zdechnout — CLAUDE.md to sám zmiňuje).
- Volitelně privacy-friendly analytika (GoatCounter/Plausible), ať je vidět, co lidé reálně používají.

---

## 7. Doporučené pořadí

**Quick wins (hodiny, okamžitý efekt):**
1. Hero countdown deště z `GRID.act` (2.1)
2. Auto-obnova posledního místa (3.1)
3. Abort starých fetchů (1.3)
4. Legenda radaru (3.3)
5. Klávesová navigace našeptávače (3.4)
6. Mockupy mimo deploy + SRI + relativní cesty SW (1.4, 1.5, 6.2)
7. `prefers-color-scheme` default (4.5)
8. Tlačítko Sdílet + OG meta (3.8)

**Střední (dny):**
9. Zapojit worker → AI verdikt per-location s cache (1.1) ← nejvyšší hodnota
10. Blitzortung blesky, nebo přejmenování vrstvy (1.2)
11. `minutely_15` graf (2.2)
12. Meteogram (3.2)
13. SVG ikony Meteocons (4.1)
14. Výstrahy jako polygony + panel (3.7)
15. Kvalita ovzduší + pyl (5)
16. Modularizace JS/CSS (6.1)
17. Crossfade radaru (3.6)

**Velké sázky (týdny, diferenciace):**
18. Web Push přes Cloudflare KV (2.6)
19. Verifikace přesnosti nowcastu (2.5)
20. Plná časová řada nowcastu v gridu (2.3)
21. Mobile bottom-sheet redesign (3.5)
