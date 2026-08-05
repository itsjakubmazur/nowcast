// Prořezávání teplotních popisků podle zoomu.
//
// Problém, který to řeší: českých stanic je 296 a při oddálení z nich byla
// souvislá plocha štítků, pod kterou nebyla vidět mapa ani radar. Vykreslovat
// všechny bez ohledu na zoom nedává smysl — na celou republiku se jich čitelně
// vejde pár desítek.
//
// Princip: mapa se rozdělí na buňky, jejichž velikost roste s oddálením, a
// z každé buňky se ukáže JEDNA stanice. Která, to nerozhoduje náhoda ani
// pořadí v poli, ale priorita: při velkém oddálení mají přednost velké
// klimatologické stanice (Praha, Brno, Ostrava…), při přiblížení se postupně
// rozkryjí i ty místní. Díky tomu je pohled na republiku čitelný a přiblížení
// přidává detail, místo aby jen zahustilo kaši.

import { ageMinutes } from "./utils.js";

// Velikost buňky ve stupních podle zoomu. Čísla jsou empirická: při zoomu 7
// (celá ČR) vyjde buňka ~0,55°, tedy zhruba 40 km, což dá po republice
// řádově 30–40 popisků.
export function cellSizeDeg(zoom) {
  const z = Math.max(1, Math.min(14, zoom));
  return 70 / Math.pow(2, z);
}

// Kolik popisků má smysl ukázat najednou.
//
// POZOR na pokušení odvodit to jen ze zoomu — přesně to tady bylo a bylo to
// špatně. Tabulka dávala při zoomu 5 osmnáct popisků, jenže zoom 5 může být
// pohled na Rakousko i na půlku zeměkoule. Na světové mapě tak z šesti tisíc
// stanic zbylo osmnáct kousků a vypadalo to, jako by data chyběla. (Vznikla
// pro ČESKOU síť: 296 stanic na malé ploše, kde je oříznutí opravdu potřeba.)
//
// Rozhoduje proto PLOCHA VÝŘEZU, ne zoom. Mřížka buněk (cellSizeDeg) už sama
// zaručuje, že se popisky nepřekryjí — z každé buňky projde jeden. Přirozený
// strop je tedy počet viditelných buněk a všechno pod ním je zbytečné
// ořezávání. Tvrdý strop zůstává jen jako pojistka proti výkonu.
export function capForBounds(south, west, north, east, zoom, hardCap = 400) {
  const cell = cellSizeDeg(zoom);
  const dLat = Math.max(0, north - south);
  // Přes datovou hranici vyjde záporná šířka — dopočítej ji přes 360°.
  const dLon = east >= west ? east - west : (360 - west + east);
  const cols = Math.ceil(dLon / cell);
  const rows = Math.ceil(dLat / cell);
  return Math.max(24, Math.min(hardCap, cols * rows));
}

// Záloha pro volající, který výřez nezná.
//
// Vrací KONSTANTU, a to schválně. Buňka i výřez se se zoomem zmenšují stejně
// rychle, takže počet buněk na obrazovku je na zoomu prakticky nezávislý —
// funkce "stropu podle zoomu" by jen předstírala, že něco řídí. Skutečné
// řízení hustoty dělá velikost buňky (cellSizeDeg) a skutečný strop
// capForBounds z plochy výřezu.
export const SCREEN_LABEL_BUDGET = 120;

export function maxLabelsFor(_zoom, hardCap = 400) {
  return Math.min(hardCap, SCREEN_LABEL_BUDGET);
}

// Priorita stanice — vyšší číslo vyhrává souboj o buňku.
//
// Vychází z identifikátorů, které už v datech máme:
//   0-20000-0-11xxx  mezinárodně vyměňovaná stanice ČHMÚ (Praha, Brno, …)
//   0-203-0-*        česká národní síť (hustá, ale místní)
//   metar-*          letiště
// Uvnitř téže třídy rozhoduje úplnost měření a pak čerstvost.
export function stationRank(s) {
  const id = String(s.id || s.wsi || "");
  let base = 2;
  if (id.startsWith("0-20000-0-11")) base = 5;        // hlavní síť
  else if (id.startsWith("metar-")) base = 4;         // letiště — známá místa
  else if (id.startsWith("0-203-0")) base = 3;        // národní síť
  else if (s.own) base = 6;                           // vlastní/sledovaná stanice

  // Stanice, která hlásí i vítr a tlak, je "plnohodnotnější" než holý teploměr.
  let extra = 0;
  if (s.wind_kmh != null) extra += 0.3;
  if (s.pressure != null) extra += 0.2;
  if (s.humidity != null) extra += 0.1;
  return base + extra;
}

/**
 * Vybere stanice k vykreslení.
 *
 * @param stations  pole stanic s .lat/.lon (a volitelně .id, .time_utc)
 * @param zoom      aktuální zoom mapy
 * @param opts      { maxLabels, rank, cellDeg }
 * @returns podmnožina `stations`
 */
export function thinByZoom(stations, zoom, opts = {}) {
  const list = (stations || []).filter(s => s && s.lat != null && s.lon != null);
  const cell = opts.cellDeg ?? cellSizeDeg(zoom);
  const cap = opts.maxLabels ?? maxLabelsFor(zoom);
  const rank = opts.rank ?? stationRank;

  // Nejdřív podle priority, při shodě podle čerstvosti — pořadí v poli
  // nesmí rozhodovat, jinak by se výběr měnil od načtení k načtení.
  const sorted = [...list].sort((a, b) => {
    const dr = rank(b) - rank(a);
    if (dr) return dr;
    return (ageMinutes(a.time_utc) ?? 1e9) - (ageMinutes(b.time_utc) ?? 1e9);
  });

  const seen = new Set();
  const out = [];
  for (const s of sorted) {
    if (out.length >= cap) break;
    // Zeměpisná délka se u pólů sbíhá; bez korekce by u vysokých šířek byly
    // buňky nesmyslně úzké a popisky by se přesto překrývaly.
    const lonCell = cell / Math.max(0.2, Math.cos(s.lat * Math.PI / 180));
    const key = `${Math.floor(s.lat / cell)}_${Math.floor(s.lon / lonCell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
