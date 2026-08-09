# Design backlog — nowcast

Zdroj: `/impeccable critique` (27/40) a `/impeccable audit` (15/20), oba
z 2026-08-09, oba nad `web/index.html`. Snímky leží v `.impeccable/critique/`
a `.impeccable/audit/`.

Sedmnáct položek. Duplicity mezi kritikou a auditem jsou sloučené — kde obojí
ukazuje na totéž místo, je to v poznámce, protože shoda dvou nezávislých metod
je silnější signál než dva samostatné nálezy.

**Riziko** není odhad pracnosti, ale pravděpodobnost, že oprava rozbije něco
jiného. Vysoké riziko = sahá do něčeho, na čem stojí víc míst, než je vidět.

## P0 — blokuje hlavní slib produktu

### 1. Tři odpovědi na „kdy začne pršet" v jedné kartě
**Dopad: kritický · Riziko: střední · `clarify`**

Změřeno: `#rc-title` 14:54, `#minutely-msg` 14:45, `#outlook-msg` 17:35.
Podtitul hlavy sám říká „jen radar, model zatím nic nevidí" — appka ten rozpor
zná a stejně ho vytiskne.

Dvě nezávislé příčiny. `precipTimeline()` v `safety.js` staví 12h řadu výhradně
z `minutely_15` + `fc.hourlyFull`, radar do ní nevstupuje; `renderOutlookWindows()`
sáhne na `assessRain()` jen pro „teď". A `renderRainCountdown()` používá jiný
práh mokrého slotu než sdílená `WET_RATE = 0.15`.

*Předchozí oprava přesunula větu dovnitř každého těla a odvodila ji ze stejných
slotů jako jeho sloupce. Tím zmizel rozpor uvnitř měřítka. Rozpor mezi hlavou
a těly a mezi měřítky zůstal, protože zdroje jsou pořád tři.*

Riziko je střední, ne nízké: pustit radar do 12h řady znamená sáhnout na váhu
blendu, tedy na čísla, ne na vzhled. **Minimální varianta bez rizika:** 12h věta
nesmí říct „Sucho ještě ~3 h", když 2h tělo téže karty kreslí déšť.

## P1 — opravit před dalším kolem

### 2. Kontrast: `--temp1` bez dvojčete, inline zápisy v JS, akcent na vlastním tintu
**Dopad: vysoký · Riziko: nízké · `colorize`** · *shoda kritiky i auditu*

488 textových uzlů, light **47** selhání, dark **11**. Dvě rodiny:

(a) Sytá barva jako drobný text: `.verdict-ai-badge` **1,95:1** (a používá
`--temp1`, barvu vyhrazenou teplotě — porušení Pravidla významu), `span.a-v`
**2,16:1** inline v `extras.js:418`.

(b) Akcent na tintu vlastní barvy: `.ctrl.active` má
`color-mix(in srgb, var(--accent) 14%, var(--glass))` a na tom akcentová modř
padá na 3,84–3,95. Nejhůř `span.rc-timer` — **odpočet, 3,54:1 v tmavém motivu.**

### 3. Regresní hlídka kontrastu měří token, ne render
**Dopad: vysoký · Riziko: nízké · `harden`**

Kontrola ve `smoke.mjs` porovnává tokeny proti sklu. Rodina (b) výš tím prochází,
protože pozadí není sklo. **Tohle je důvod, proč 47 selhání přežilo zelený test** —
a bez opravy testu se stejná díra otevře znovu.

Doplnit pixelové měření: skrýt text a grafiku, per-element screenshot, modální
barva pozadí. Metoda je popsaná v hlavičce auditu.

### 4. Pořadí fokusu odporuje vizuálnímu pořadí
**Dopad: střední · Riziko: střední · `harden`** · WCAG 2.4.3

`#radar-bar` je v `index.html:68`, `#topbar` až na `:117`, takže Tab začíná
dokem u spodní hrany. Riziko je střední: mobilní `order` pravidla na pořadí
v DOMu spoléhají a komentáře v CSS to výslovně popisují.

### 5. Dialog Detail stanice je z klávesnice nedosažitelný
**Dopad: střední · Riziko: nízké · `harden`** · WCAG 2.1.1

`.wu-mini-row` (`stations.js:63`) je `div` bez `tabindex` a `role`. `modal.js`
udělal ze tří překryvů korektní dialogy, ale k jednomu se klávesnicí nedostaneš.
Totéž `#notif-close` — `<span role="button">` s pouhým `click`.

### 6. Světový režim se spočítá a zahodí
**Dopad: vysoký · Riziko: nízké · `clarify`**

`app.js:280–282` píše „Světový režim — radar RainViewer + model" do `#dist`;
`app.css:644` má `.dist { display: none }` bez podmínky. Nic jiného v UI neříká,
jestli koukáš na vlastní pysteps extrapolaci z ČHMÚ, nebo na cizí RainViewer.
Přímý rozpor s produktovým principem „nejistota se přiznává".

## P2 — do dalšího průchodu

### 7. 16 přepínačů mapy bez `aria-pressed`
**Dopad: střední · Riziko: nízké · `harden`** · WCAG 1.4.1 + 4.1.2

Stav nese výhradně barva. Popisky obou skupin jsou `aria-hidden`, takže odečítač
dostane 16 nezařazených tlačítek bez informace, že u devíti se vybírá jedno
a u sedmi se zapíná libovolně.

### 8. Prázdné a chybové stavy zapojené ze čtvrtiny
**Dopad: střední · Riziko: nízké · `harden`** · *shoda kritiky i auditu*

`panelError()` **4 volání**, `panelEmpty()` **0**, `classList.remove("show")` na
**32 místech**, z toho 0 uvnitř `catch`. Šest z těch 32 je legitimních („není co
říct"); zbytek jsou resety, kde panel při chybějících datech zůstane neviditelný.
Když ČHMÚ open data nedojedou, zmizí bez slova pět panelů (`chmidata.js`).

`panelEmpty()` buď zapojit, nebo smazat — mrtvý kód se zdůvodněním předstírá
vyřešený problém.

### 9. Jezdce posuvníků mají 4–5 px svislého zásahu
**Dopad: střední · Riziko: nízké · `adapt`** · WCAG 2.5.8

`#timeline` 248,4 × **5** px, `#opacity-slider` 72 × **4** px. Scrubber radarové
smyčky je nejpřirozenější jednoruční gesto v appce. Vzorec `::after {
height: max(44px, 100%) }` v repu už je (`.pp-tab`, `.mtab`), jen se nepoužil tam,
kde je nejvíc potřeba.

### 10. Ovladače a čipy mimo obrazovku bez náznaku
**Dopad: střední · Riziko: nízké · `adapt`**

Na 390 px leží `#btn-wind`, `#btn-hydro`, `#btn-accum` za pravou hranou v dráze
**bez** sticky popisku — na rozdíl od sousední, identicky vypadající dráhy, kde
sticky je. Čip „+3" u výstrah taky: během bouřky vidíš tři výstrahy ze šesti.

### 11. Pruh výstrah je pro odečítač němý
**Dopad: střední · Riziko: nízké · `harden`**

Statický `aria-label="Aktivní výstrahy"` **přebije obsah**, takže odečítač
přečte „Aktivní výstrahy, tlačítko" a nic o tom, které ani kolik. Chybí
`aria-expanded`, přestože se prvek rozbaluje.

### 12. Ořezy: `span.mdl-name`, `div.fc7-ens`, dvojí deklarace
**Dopad: střední · Riziko: nízké · `layout`**

`span.mdl-name` má 120 px obsahu v 85px boxu — žebříček modelů má useknutá jména
modelů. `div.fc7-ens` ořízne konstantně 23 px, a je navíc deklarovaná **dvakrát**
s protichůdnými hodnotami (`app.css:1175` a `:2155`); pozdější vyhraje velikostí,
ale zdědí `nowrap`.

## P3 — když zbude čas

### 13. Čtyři tailwindové barvy zbylé uprostřed konstant
**Dopad: nízký · Riziko: nízké · `colorize`**
`hydro.js:10` `#a16207`, `stations.js:175`, `:562`, `:598` `#f87171`. Sousední
hodnoty už jdou přes `gc()`, role „teplota" v systému existuje.

### 14. Barva popisků na škále úhrnu a natvrdo zapsané rgba
**Dopad: nízký · Riziko: nízké · `colorize`**
`#accum-legend .accum-scale span { color: #fff }` dává na `#9fd0ff` **1,6:1**.
Škála sama je meteorologická konvence — barva popisků na ní ne. `#storm-impact`
zapisuje `rgba(...)` natvrdo a je **jediný prvek v appce s `border`em**.

### 15. Mrtvé selektory a zastaralý test
**Dopad: nízký · Riziko: nízké · `polish`**
`#more-toggle` (`app.css:232`) po zrušené sekci, i s komentářem popisujícím bug
prvku, který neexistuje. `tests/smoke.mjs:383` nastavuje `nowcast_more_open`.

### 16. Dvě různé „jistoty" 150 px od sebe
**Dopad: nízký · Riziko: nízké · `clarify`**
`verdict.js:510` „jistota ~100 %" (pravděpodobnost z ensemblu nowcastu) proti
`models.js:568` „Jistota výhledu: střední" (shoda modelů). Jedno slovo, dvě
veličiny.

### 17. `DESIGN.md` zaostal za kódem
**Dopad: nízký · Riziko: nízké · ruční oprava** · *z BRÁNY A, rozhodnutí 1*
`segment-active` drží `#0A84FF` místo `--accent-solid`; `button-glass-hover`
ztratil 8% mix a tvrdí bílou na bílé; chybí `modal.js`, `emptystate.js`,
`rail.js`, `palette.js`.

## Návrh, co vyhodit

Tři položky doporučuju **neimplementovat** — ne proto, že nálezy neplatí, ale
protože cena převyšuje užitek u tohohle produktu.

**A. Pevné šířky 292/312 px na `clamp()`.** Kritika i audit to hlásí (na 1440 px
zeje 836 px prázdné mapy vedle ořezané tabulky). Sahá to ale do rozvržení, na
kterém stojí `rail.js`, mobilní `order` pravidla, tři breakpointy a fixní
pozicování šesti panelů — nejvyšší riziko v celém backlogu. A užitek míří na
desktop, zatímco produkt je definovaný jako „mobil, venku, pět sekund".
*Místo toho:* opravit ořezy (položka 12), což řeší konkrétní škodu bez přestavby.

**B. Přerozdělení typografických rolí.** Nález „58 % textu na 9,6–10,9 px" je
změřený správně, ale interpretace ho míjí: hustota je u tohohle nástroje
**deklarovaná hodnota**, ne nedopatření. `PRODUCT.md` říká „hustota informací
smí vyhrát nad přívětivostí pro nováčka". Zvětšit `micro` znamená zkrátit svitek
o obsah.
*Místo toho:* nechat, ale ohlídat kontrast na těch stupních (položka 2).

**C. Předělání dialogu Nastavení.** Kritika ho označila za jediné kategoricky
zaměnitelné místo — pět nativních `<select>`ů v bílé kartě, mimo skleněný svět.
Platí to. Ale je to obrazovka, kterou uživatel otevře jednou za měsíc, a
`PRODUCT.md` výslovně říká, že první dojem není cíl.
*Místo toho:* nechat jako kandidáta na `delight` v pozdějším běhu, ne teď.

## Pořadí, které navrhuju

| Pořadí | Položky | Příkaz | Proč tady |
|---|---|---|---|
| 1 | 1 (min. varianta), 6, 16 | `clarify` | Všechny tři jsou o tom, že appka říká něco, co není pravda. Nejlevnější a nejvyšší dopad. |
| 2 | 2, 13, 14 | `colorize` | Jedna oblast, jeden průchod, měřitelný výsledek. |
| 3 | 3, 4, 5, 7, 8, 11 | `harden` | Přístupnost a odolnost pohromadě; položka 3 zavře díru v testu dřív, než se otevře znovu. |
| 4 | 9, 10 | `adapt` | Mobil, jedna ruka. |
| 5 | 12, 15, 17 | `polish` | Zbytky a dokumentace na konec. |
| — | 1 (plná varianta) | `clarify` | Až po zbytku, samostatně, s vlastním testem. Sahá na čísla, ne na vzhled. |
