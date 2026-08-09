---
name: nowcast
description: Řídicí věž nad českým počasím — sklo nad živou radarovou mapou.
colors:
  nocni-obloha: "#080C14"
  radarova-modr: "#0A84FF"
  teplotni-jantar: "#FFB340"
  teplotni-ohen: "#FF6B2C"
  sucha-zelen: "#30D158"
  vystrazna-cerven: "#FF453A"
  pozorovaci-zlut: "#FFD60A"
  aerologicka-teal: "#40C8E0"
  klimaticka-fialova: "#BF5AF2"
  stanicni-oranz: "#FF9F0A"
  plna-radarova-modr: "#0068D6"
  citelny-text: "#EDF2F9"
  tlumeny-text: "#AAB7C9"
  denni-obloha: "#E9EDF2"
  denni-text: "#0E1A2B"
  denni-tlumeny: "#51607A"
typography:
  display:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "3.2rem"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-.045em"
  headline:
    fontFamily: "Figtree, -apple-system, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.15
  title:
    fontFamily: "Figtree, -apple-system, system-ui, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Figtree, -apple-system, system-ui, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Figtree, -apple-system, system-ui, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 700
    letterSpacing: ".07em"
rounded:
  panel: "22px"
  card: "16px"
  chip: "12px"
  mini: "8px"
  pill: "999px"
components:
  button-glass:
    backgroundColor: "{colors.nocni-obloha}"
    textColor: "{colors.citelny-text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 0.8rem"
    height: "36px"
  button-glass-hover:
    backgroundColor: "color-mix(in srgb, {colors.citelny-text} 8%, {colors.nocni-obloha})"
    textColor: "{colors.citelny-text}"
  segment-active:
    backgroundColor: "{colors.plna-radarova-modr}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "0.38rem 0"
    typography: "{typography.label}"
  segment-idle:
    backgroundColor: "transparent"
    textColor: "{colors.tlumeny-text}"
    rounded: "{rounded.pill}"
  panel-card:
    backgroundColor: "{colors.nocni-obloha}"
    textColor: "{colors.citelny-text}"
    rounded: "{rounded.card}"
    padding: "0.8rem 0.9rem 0.7rem"
  panel-title:
    textColor: "{colors.tlumeny-text}"
    typography: "{typography.label}"
---

# Design System: nowcast

## Overview

**Creative North Star: "Řídicí věž"**

Klidná autorita nad prováz­anými daty. Řídicí věž je prosklená místnost nad
živou krajinou: dovnitř je vidět počasí, které se venku právě děje, a uvnitř
stojí přístroje, které mu dávají čísla. Rozhraní dělá přesně tohle — panely
z rozostřeného skla plovou nad radarovou smyčkou, která se pod nimi hýbe.
Materiál není dekorace, ale sdělení: **data nikdy nezakryjí svět pod sebou**.

Charakter je živý a atmosférický. Podklad je téměř černá modř noční oblohy,
skrz kterou prosvítá mapa; hloubka vzniká průsvitností a rozostřením toho, co
leží pod panelem, ne stohem stínů. Barva se objevuje jen tam, kde nese význam
— teplota, srážky, výstraha — takže poplach je vidět dřív, než ho člověk
stihne přečíst. Hustota je tady kompetence, ne nepořádek: uživatel je nadšenec,
který ví, co je echotop, a hodnota nástroje je právě v tom, že mu ukáže do
stroje.

Jediné potvrzené odmítnutí: **nikdy nesmí vypadat jako enterprise dashboard**
— šedé tabulky s linkami kolem každé buňky, boxy s výraznými bordery, hustota
bez hierarchie.

**Key Characteristics:**
- Sklo nad živou mapou, jedna hladina — ne stupnice elevací
- Barva výhradně nositelem významu, nikdy dekorací
- Osm velikostí písma a pět poloměrů; devátý stupeň je signál chyby v roli prvku
- Tabulární číslice všude, kde se čísla mění v čase
- Tmavý motiv je výchozí, světlý je plnohodnotný, ne dodatek

## Colors

Paleta je meteorologická legenda, ne dekorativní schéma: každý odstín má
přiřazený jev a mimo něj se nepoužívá.

### Primary
- **Radarová modř** (`#0A84FF`, ve světlém motivu `#007AFF`): jediný interakční
  akcent. Aktivní segment navigace, aktivní záložka, srážkové sloupce, odkazy
  a fokusový prstenec. Nikdy nezdobí — kde svítí, tam se dá klepnout nebo tam
  prší.

### Secondary
- **Teplotní jantár** (`#FFB340`) → **Teplotní oheň** (`#FF6B2C`): gradient
  135°, vyhrazený teplotě. Nese hlavní číslo v hlavičce a teplotní pruhy
  v týdnu. Chladná teplota gradient vymění za modrofialový (`#7DC4F0` →
  `#38bdf8` → `#818cf8`), takže teplo a chlad jsou rozeznatelné bez čtení.

### Tertiary
- **Suchá zeleň** (`#30D158`): bezpečí a sucho — doporučené okno beze srážek,
  dobrý stav hladin, vysoká jistota výhledu.
- **Výstražná červeň** (`#FF453A`): výstraha ČHMÚ, blížící se bouřka, vysoké UV.
- **Pozorovací žluť** (`#FFD60A`), **Aerologická teal** (`#40C8E0`),
  **Klimatická fialová** (`#BF5AF2`): odbornější vrstvy — konvekce, aerologie,
  klimatický kontext a tlak v meteogramu.

- **Stanicní oranž** (`#FF9F0A`, ve světlém `#FF9500`): vlastní a sledovaná
  čidla — proužek WU stanic, jejich značky na mapě, uložené místo. Odlišuje
  „co jsem si přidal já" od „co appka umí sama".

### Neutral
- **Plná radarová modř** (`#0068D6`): plocha, na které leží BÍLÝ text —
  jezdec navigace sekcí, aktivní záložka, aktivní vrstva, tlačítko přehrávání.
  Je to tatáž modř o dva stupně tmavší, protože bílá na `#0A84FF` dává jen
  3,65:1 a na `#007AFF` 4,02:1, tedy pod WCAG AA. Tahle dává 5,31:1.
- **Noční obloha** (`#080C14`): podklad celé appky v tmavém motivu; mapa pod
  ním prosvítá.
- **Čitelný text** (`#EDF2F9`) a **Tlumený text** (`#AAB7C9`): primární a
  sekundární text. Tlumený byl záměrně zesílen z původního `#94A2B5` — na skle
  nesplňoval kontrastní poměr.
- **Denní obloha** (`#E9EDF2`), **Denní text** (`#0E1A2B`), **Denní tlumený**
  (`#51607A`): světlý motiv. Tlumený je zde naopak ztmavený, ze stejného důvodu.

### Named Rules
**Pravidlo významu.** Barva se přiděluje jevu, ne prvku. Zelená vždy znamená
„sucho / v pořádku", červená „výstraha", modrá „interakce nebo srážky".
Použít zelenou proto, že se hodí k layoutu, je porušení systému.

**Pravidlo plochy a textu.** Sytá barva, která je čitelná jako PLOCHA, není
automaticky čitelná jako TEXT. Paleta vznikla dark-first; ve světlém motivu má
oranžová `#FF9500` jako drobný text kontrast 2,09:1 a zelená `#34C759` 2,11:1.
Každá sémantická barva proto má dvojče `--X-text`, které je v tmavém motivu
totožné a ve světlém ztmavené nad 4,5:1. Barva zůstává legendou, jen
v čitelné variantě.

**Pravidlo tří stavů.** Barva znamená STAV, ne potřebu akce — a stavy jsou tři,
ne dva. Vedle „dobré" a „špatné" existuje „netýká se tě to", a ten je tlumený.
Bez něj svítilo v aktivitách zalévání červeně přesně tehdy, když ho déšť udělal
zbytečným: červená u dobré zprávy.

**Pravidlo dvou motivů.** Žádná barva nesmí být zapsaná natvrdo mimo tokeny.
Bílá na 9 % je v tmavém motivu decentní šeď a ve světlém bílá na bílé — přesně
tak už jednou zmizel celý pruh dat. Každá plocha jede přes token, který má obě
varianty. Platí to i pro JavaScript: grafy si dřív psaly tailwindovou paletu
(`#f97316`, `#22c55e`, `#a855f7`, …) a designový systém tím končil na hranici
CSS. Barvy grafů se čtou z `:root` přes `palette.js`; přidat barvu do grafu,
aniž by byla v systému, tím přestává jít.

## Typography

**Display Font:** Figtree (variabilní 300–900, self-hostovaná, SIL OFL)
**Body Font:** Figtree — stejná rodina, celá appka jedním písmem
**Label/Mono Font:** žádné zvlášť; číselnou čitelnost řeší `font-variant-numeric: tabular-nums`

**Character:** Jedno variabilní bezpatkové písmo v širokém rozsahu vah nese
všechno od hero teploty po popisek jednotky. Osobnost tvoří kontrast vah a
velikostí, ne střídání rodin — což je přesně to, co drží hustý přístrojový
displej pohromadě.

### Hierarchy
- **Display** (800, `3.2rem`, line-height 0.95, letter-spacing −0.045em): teplota
  v hlavičce. Jediné číslo, které smí křičet, a jediné místo s gradientovou
  výplní textu.
- **Headline** (800, `1.5rem`): hodnota v dlaždici — velká čísla v kartách.
- **Title** (700, `1.15rem`): nadpis karty, střední číslo.
- **Body** (400–600, `0.82rem`): běžný text vět, verdikt, popisy.
- **Label** (700–800, `0.68rem`, letter-spacing 0.07em, verzálky): hlavička
  panelu a popisky nad hodnotami. Nese ho jedna sdílená deklarace pro všechny
  panely.

Mezistupně `0.6rem` (micro — jednotky, poznámky pod čarou), `0.74rem` (sm —
ovládací prvky, husté řádky) a `0.92rem` (md — zdůrazněná věta) doplňují škálu
na osm stupňů.

### Named Rules
**Pravidlo osmi stupňů.** Velikost písma smí být jen jedna z osmi hodnot škály.
Appka jich kdysi měla 48 mezi `.52rem` a `3.7rem`; rozdíl `.72` proti `.74` oko
nepřečte jako záměr, ale jako nepořádek. **Když se prvek do žádného stupně
nevejde, má špatnou roli — škála devátý stupeň nedostane.**

**Pravidlo tabulárních číslic.** Každé číslo, které se v čase mění nebo stojí
pod sebou ve sloupci, dostane `tabular-nums`. Poskakující šířka číslic dělá
z klidného panelu neklid.

**Pravidlo jedné hlavičky.** Nadpis panelu je vždy tentýž zápis: verzálky,
prostrkání 0.07em, tlumená barva, `0.68rem`. Panel, který se sází jako věta
tučně a bíle, nevypadá důrazněji — vypadá, že do sestavy nepatří.

## Layout

Celoplošná mapa je pozadí; nad ní plovou skleněné vrstvy. Na desktopu jsou dva
nezávisle rolovatelné sloupce — levá karta (nowcast, verdikt, srážky) a pravý
panel (předpověď, odborná data) — s plovoucí lištou sekcí vlevo nahoře. Pod
768 px se sloupce skládají pod sebe a lišta sekcí se mění v plovoucí pilulku
u dolní hrany okna.

Rytmus odsazení je odvozený z rem hodnot přímo v komponentách; **projekt nemá
odsazovací škálu v tokenech** a DESIGN.md ji nevymýšlí. Typické hodnoty:
`0.8rem 0.9rem 0.7rem` uvnitř karty, `0.25rem` kolem segmentů přepínače,
`2px` mezera mezi sloupci grafu.

Breakpointy: `768px` (mobil), `769px` (desktop), `1080px` (užší desktop).
Vodorovné dráhy dat (hodiny, modely) se nezalamují — rolují se s `scroll-snap`
a skrytým scrollbarem, protože přeteklý sloupec je čitelnější než zalomená
tabulka.

### Named Rules
**Pravidlo dvou svitků.** Na desktopu roluje levá karta a pravý panel odděleně;
nic nesmí předpokládat jeden společný svitek okna. Skok na sekci proto hledá
kontejner, ve kterém cíl doopravdy roluje.

**Pravidlo neschovávání.** Navigace sekcí skáče, neskrývá. Filtrující verze
kdysi po klepnutí palcem odstranila většinu obsahu a nikde nebylo vidět, že se
něco skrylo. Všechno zůstává v jednom svitku.

## Elevation & Depth

Systém nemá stupnici elevací. Má **jednu skleněnou hladinu nad živou mapou**:
panel je průsvitný, rozostřuje to, co je pod ním (`blur(26px) saturate(1.7)`),
a od mapy ho odděluje jediný měkký vržený stín. Uvnitř panelu se hloubka už
nestupňuje — vnitřní karty se odlišují tónem podkladu, ne dalším stínem.

Hrana panelu není `border`, ale **1px vnitřní prstenec** plus světlá spekulární
linka na horní hraně. Díky tomu okraj reaguje na to, co pod sklem leží, a panel
vypadá jako materiál, ne jako obdélník s obrysem.

### Shadow Vocabulary
- **Skleněný odstup** (`box-shadow: 0 18px 44px -14px rgba(0,0,0,.6)` v tmavém,
  `0 18px 44px -18px rgba(14,26,43,.32)` ve světlém): jediný vržený stín
  v systému. Odděluje plovoucí vrstvu od mapy.
- **Spekulární hrana** (`inset 0 1.2px 0 rgba(255,255,255,.16)`): horní světlo
  na skle.
- **Prstenec místo borderu** (`inset 0 0 0 1px rgba(255,255,255,.14)`): obrys
  všech skleněných ploch.
- **Záře jezdce** (`0 2px 10px` v barvě akcentu na 45 %): jediné místo, kde
  stín nese barvu — pod jezdcem segmentového přepínače.

### Named Rules
**Pravidlo jedné hladiny.** Sklo je jednou. Panel uvnitř panelu nedostane
další `backdrop-filter` ani další vržený stín — dvě skla přes sebe rozmažou
hranici a vrstva přestane být čitelná.

**Pravidlo obsaženého filtru.** `backdrop-filter` zakládá containing block pro
`position: fixed` uvnitř. Cokoli, co se má lepit k oknu, musí ležet mimo
skleněný panel — jinak se přilepí k panelu a rozmaže se proti jeho vlastnímu
sklu.

## Shapes

Poloměr roste s plochou, ne s náladou. Pět stupňů: **panel** (22px) pro velké
plovoucí vrstvy, **karta** (16px) pro karty, popupy a našeptávač, **čip** (12px)
pro vnitřní boxy a řádky, **mini** (8px) pro drobnosti jako štítky na mapě, a
**pilulka** (999px) pro všechno, co má být pilulka — tlačítka, segmentové
přepínače, lišta sekcí, sloupcové stopky.

Proužky a osy pod 4 px do škály nepatří; tam je poloměr prostě polovina výšky.
Formální jazyk je měkký a plný: obdélník s ostrým rohem se v systému
nevyskytuje.

### Named Rules
**Pravidlo pěti poloměrů.** Devět, deset, jedenáct a dvanáct pixelů vedle sebe
nikdo nepřečte jako záměr. Nová hodnota mimo škálu znamená, že prvek patří do
jiné velikostní třídy.

**Pravidlo zaobleného vnitřku.** Zaoblený obal s hranatým obsahem uvnitř je
horší než hranaté obojí — zaoblí se jen jeden konec a druhý vypadá useknutý.
Co má zaoblený obal, má zaoblený i obsah.

## Components

### Buttons
- **Shape:** pilulka (`999px`), výška 36 px, min. šířka 36 px
- **Glass (primární varianta):** sklo s prstencem, text v barvě `Čitelný text`,
  odsazení `0 0.8rem`, ikonová varianta je čtvercová 36×36 bez odsazení
- **Hover / Focus:** podklad se mísí s 10 % barvy textu; stisk zmenší prvek na
  94 % (`transform: scale(.94)`, 120 ms) — ovládání má být fyzické
- **Ikony:** 17×17 px, tahové SVG glyfy, nikdy emoji

### Chips
- **Style:** segmentový přepínač — obal je pilulka ze skla s prstencem,
  odsazení 2 px, mezera 2 px mezi segmenty
- **State:** aktivní segment má plnou `Radarovou modř` a bílý text; neaktivní
  je průhledný s tlumeným textem. Váha 700 v obou stavech, aby přepnutí
  neposouvalo šířku.

### Cards / Containers
- **Corner Style:** `16px` (karta)
- **Background:** poloprůhledné sklo; vnitřní karty odlišuje tón podkladu
- **Shadow Strategy:** viz Elevation — vnitřní karta žádný stín nedostane
- **Border:** žádný; 1px vnitřní prstenec
- **Internal Padding:** `0.8rem 0.9rem 0.7rem`

### Inputs / Fields
- **Style:** pilulka ze skla, odsazení `0.45rem 1rem`, max. šířka 320 px
- **Focus:** 2px obrys v barvě akcentu s odstupem 3 px (`outline-offset`)

### Navigation
Plovoucí segmentová lišta se čtyřmi sekcemi (Teď / Dnes / Týden / Data).
Popisky verzálkami, `0.68rem`, váha 800, prostrkání 0.05em. Aktivní stav nese
**jezdec** — absolutně poziciovaný obdélník o šířce přesně jednoho segmentu,
který se posouvá násobkem vlastní šířky přes `transform`. Na desktopu je lišta
vlevo nahoře, pod 768 px se mění v pilulku přilepenou k dolní hraně okna.

### Bublina stanice
Jediné místo, kde je karta zároveň mapovým prvkem. Sklo má **slabší rozostření
(20px místo 26px)**, aby pod bublinou zůstala čitelná mapa — je to jediná
odchylka od jednotné skleněné hladiny a má důvod.

- **Hlavička:** název (`0.92rem`), štítek sítě jako pilulka verzálkami
  (`ČHMÚ` v suché zeleni, vlastní stanice v oranžové) a stáří údaje zarovnané
  doprava
- **Řádek údaje:** pevná mřížka `1.05em / 1fr / auto` — ikona, název veličiny,
  hodnota. Díky pevné mřížce stojí hodnoty ve sloupci i při různě dlouhých
  názvech, a to napříč všemi sítěmi (ČHMÚ, WU, METAR)
- **Akce:** tlačítko přes celou šířku v suché zeleni, výška ≥ 32 px

### Legenda radaru
Vodorovný pruh (160×7 px, poloměr 4 px) s popiskem „slabé / intenzivní".
**Gradient není zapsaný v CSS** — skládá se za běhu ze zarážek v manifestu,
tedy z týchž hodnot, kterými pipeline vykreslila radarové dlaždice. Legenda
proto nemůže tvrdit něco jiného, než co je na mapě. Pod 768 px se pruh
roztáhne do řádku a popisek „slabé" zmizí, protože je z barvy zřejmý.

### Karta verifikace
Sloupce shody predikce se skutečností po dnech, výška = procento shody.
Barva je **práh, ne škála**: ≥ 90 % suchá zeleň, ≥ 75 % oranžová, níž výstražná
červeň. Karta je doslovné provedení zásady o přiznané nejistotě — když se
nástroj netrefil, je to vidět stejně jasně jako když ano. Podnadpis se sází
malými písmeny a normálním řezem, aby s hlavičkou nesoupeřil.

### Signature Component: Meteogram v rozbaleném dni
Řádek týdne se klepnutím **odvine** — výška najíždí přes
`grid-template-rows: 0fr → 1fr` (420 ms), vnitřek se skládá po částech
s rozestupem 60 ms. Uvnitř je shrnutí dne, vodorovná dráha hodin seskupená po
fázích dne, a graf s přepínačem (Přehled / Srážky / Vítr / Tlak / Ensemble).
Graf se kreslí až po dojezdu animace — během ní má obal nulovou výšku.

### Signature Component: Sloupce srážek
Jedna gramatika pro obě časová měřítka: sloupec = časový slot, výška =
intenzita, průhlednost = pravděpodobnost. Suchý slot je **tenký patník u dna,
ne prázdno** — prázdno se čte jako chybějící data. Mezera mezi sloupci 2 px,
zaoblení `4px 4px 2px 2px`.

### Dialog

Tři překryvy (Nastavení, Porovnání míst, Detail stanice) sdílí jeden modul
`modal.js` a chovají se identicky. Vlastní karta je `panel-card` na tmavé
cloně; overlay sám nemá roli, protože je to jen plocha.

Chování je součást komponenty, ne doplněk: fokus jde po otevření na **první
ovladač**, ne na zavírací křížek (kdo dialog otevřel, chce v něm něco
nastavit); Tab uvnitř cykluje; Escape zavírá a poslouchá na `document`, ne na
překryvu — po kliknutí na clonu je fokus na `<body>`, tedy přesně ve chvíli,
kdy uživatel chce nejvíc ven. Zbytek stránky dostane `inert` (ne `aria-hidden`
a ne `inert` na `<body>`, to by vypnulo i dialog). Po zavření se fokus vrací
na spouštěč.

Každý spouštěč dialogu musí být dosažitelný klávesnicí. Řádek stanice byl
`div` bez `tabindex`, takže dialog byl korektní, ale nedalo se k němu dojít.

### Prázdný a chybový stav

Skrytí panelu je odpověď jen tehdy, když je **prázdno samo informací** —
bouřkový banner bez bouřky, zimní panel mimo sezónu, panel ČR mimo ČR. Když
panel mluvit MĚL a nemohl, musí to říct: zmizelý panel je nerozlišitelný od
„tuhle funkci nemám", „tady zrovna nic není" a „něco se rozbilo".

Dvě varianty v `emptystate.js`, obě si nechávají hlavičku panelu, aby bylo
poznat, KTERÁ část selhala:
- `panelEmpty(el, titulek, věta)` — data dorazila, jen tu nic není
- `panelError(el, titulek, věta, zopakuj)` — data nedorazila, nabídne se
  zopakování; tlačítko se po klepnutí přepne na „Načítám…", aby při rychlém
  selhání nevypadalo, že nereaguje

Stav **nekřičí**: žádná červená, žádná ikona. Není to výstraha, je to
konstatování.

### Stav přepínače

`.active` je jediný zdroj pravdy o zapnutí; ARIA je jeho odraz a udržuje ho
jeden pozorovatel (`togglestate.js`), ne patnáct volání v šesti modulech.

Rozlišují se dvě situace, protože pro uživatele odečítače jsou různé:
- **nezávislé vypínače** (vrstvy na mapě) → `aria-pressed`
- **výlučná volba** (rychlost animace, veličina stanic) → `role="radiogroup"`
  s `aria-checked`

Skupina musí mít jméno. Vizuální popisky („Na mapě", „Stanice") zůstávají
`aria-hidden` a jméno nese kontejner — jinak by se předčítaly dvakrát.

### Kde co bydlí podle šířky

Dva bloky mění v úzkých oknech rodiče, ne jen vzhled (`rail.js`):
- **769–1080 px:** pravý panel se vsune na konec levé karty. Dvě fixní lišty
  po stranách tam nechají z mapy proužek, ale obsah se nezahazuje — jinak
  zůstanou v navigaci klikatelná tlačítka, která nic nedělají.
- **do 768 px:** bouřkový banner se vytáhne z levé karty na úroveň `<body>`,
  hned za úchyt sheetu. V kartě by byl pátý blok stránky, tedy pod dokem
  radaru se šestnácti přepínači — nejnaléhavější informace pod nejméně
  naléhavými ovladači.

Stěhuje se uzel, ne kopie: canvasy grafů si při přepojení nechají obsah.

### Barvy grafů

Grafy a značky na mapě barvy **čtou** z `:root` přes `palette.js`, nepíšou si
je. Role (`teplota`, `srazky`, `vitr`, `tlak`…) se mapuje na token, takže
`gc("srazky")` nemůže vrátit oranžovou. Čte se při každém volání — Chart.js si
barvu drží zapsanou v datasetu a po přepnutí motivu by se zasekla na staré.

Doménové škály jsou výjimka a zůstávají mimo systém: úhrn srážek a intenzita
bouřek jsou **kvantitativní stupnice**, kde barva JE hodnota, ne význam.
Systém má role sémantické, ne kvantitativní. Řeší se u nich kontrast, ne
estetika — a barva popisku na stupni se volí podle toho, co je na něm
čitelnější.

## Do's and Don'ts

### Do:
- **Do** používej barvu jako legendu: zelená = sucho a bezpečí, červená =
  výstraha, modrá = interakce nebo srážky.
- **Do** sázej každou velikost písma z osmi stupňů škály a každý poloměr z pěti.
- **Do** dej `tabular-nums` každému číslu, které se mění v čase nebo stojí ve
  sloupci.
- **Do** používej pro pohyb jedinou křivku `cubic-bezier(.32, .72, 0, 1)` —
  systém má jeden rukopis zrychlení.
- **Do** vypni pohyb úplně při `prefers-reduced-motion: reduce`. Vypni, ne zkrať.
- **Do** označ každou úpravu zobrazených dat (korekce, dopočet) viditelnou
  poznámkou u čísla.
- **Do** nech vodorovné dráhy dat rolovat; přeteklý sloupec je čitelnější než
  zalomená tabulka — ale dej dráze sticky popisek, jinak není poznat, že
  vpravo něco je.
- **Do** zvětšuj dotykový cíl neviditelným překryvem, ne výplní: vzhled
  segmentovaného přepínače i vlásku časové osy je součást jejich významu.

### Don't:
- **Don't** stavěj šedé tabulky s linkami kolem buněk ani boxy s výraznými
  bordery — jediné potvrzené odmítnutí systému je vzhled enterprise dashboardu.
- **Don't** zapisuj barvu natvrdo mimo tokeny; bílá na 9 % zmizí ve světlém
  motivu a data s ní.
- **Don't** vkládej skleněný panel do skleněného panelu ani nepřidávej druhý
  vržený stín uvnitř karty.
- **Don't** umísťuj `position: fixed` prvek dovnitř panelu s `backdrop-filter`
  — přilepí se k panelu, ne k oknu.
- **Don't** používej emoji jako ikonu; ikonografie je tahové SVG.
- **Don't** zobrazuj tutéž hodnotu ve dvou granularitách nad sebou.
- **Don't** nes stav přepínače jen barvou — `.active` musí mít odraz
  v `aria-pressed` nebo `aria-checked`.
- **Don't** měř kontrast tokenu proti sklu, když text leží na tintu vlastní
  barvy; tam je potřeba dvojče `-on-tint` a v každém motivu na opačnou stranu.
- **Don't** animuj napočítávání čísel — než hodnota „dojede", ukazuje appka
  čísla, která nikdo nenaměřil.
