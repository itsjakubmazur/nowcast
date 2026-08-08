// ── Srážky v čase: JEDNA vizuální gramatika pro obě měřítka ─────────────────
//
// Panel srážek má dvě záložky, 2 h a 12 h. Kreslily se ale úplně jinak:
// 2 h jako sloupce s výškou podle intenzity, 12 h jako plochá stuha, kde
// intenzitu nesl jen tón. Původní důvod stojí v komentáři u .ow-bars —
// "ať se to neplete se sloupcovým grafem nad ním" — jenže to bylo napsané
// ve chvíli, kdy šlo o dvě karty NAD SEBOU. Po sloučení do jednoho panelu
// jsou to dvě záložky téhož a nikdy nejsou vidět naráz, takže rozdíl už nic
// neodlišuje; jen nutí přepnout měřítko a znovu se učit, co je co.
//
// Teď obě záložky kreslí totéž: sloupec = časový slot, výška = intenzita
// srážek, průhlednost = pravděpodobnost (když ji známe). Suchý slot je
// tenký patník u dna, ne prázdno — prázdno se čte jako "chybí data".
// Nejbližší dobré suché okno je zelený patník, takže si 12h pohled nechává
// svoji jedinou informaci navíc, aniž by měnil jazyk.
//
// Osa je taky společná: první popisek "teď", zbytek hodiny. Dřív měla 2h
// záložka relativní popisky (+30/+60) a 12h absolutní časy, takže se dvě
// měřítka téhož nedala porovnat.

import { num, localHM } from "./utils.js";

// Od jaké intenzity je slot "mokrý". Sdílené oběma měřítky — dřív měla
// 2h záložka práh 0,05 a 12h 0,15 mm/h, takže tentýž slabý déšť byl
// v jednom pohledu vidět a ve druhém ne.
export const WET_RATE = 0.15;

// Spodní hranice škály: bez ní by 0,2mm mrholení nakreslilo stejně vysoký
// sloupec jako průtrž, protože maximum by bylo taky 0,2.
const SCALE_FLOOR = 1.5;

/**
 * Sloupce pro jedno měřítko.
 *
 * @param {Array<{rate:number|null, prob?:number|null, ms?:number, good?:boolean}>} slots
 *        rate = mm/h, prob = % (nepovinné), ms = čas slotu, good = leží
 *        v nejbližším doporučeném suchém okně
 */
export function precipBarsHtml(slots) {
  const maxV = Math.max(SCALE_FLOOR, ...slots.map(s => s.rate ?? 0));
  return slots.map(s => {
    const rate = s.rate;
    const p = s.prob ?? null;
    const cas = s.ms != null ? `${localHM(new Date(s.ms).toISOString())} · ` : "";
    const pStr = p != null ? ` · P ${p} %` : "";
    if (rate == null || rate < WET_RATE) {
      // Deterministicky sucho, ale ensemble dává nezanedbatelnou šanci —
      // ukaž nízký "možná" sloupec místo patníku.
      if (p != null && p >= 30) {
        const h = Math.max(10, Math.round(p / 100 * 45));
        return `<i class="maybe" style="height:${h}%" title="${cas}možné srážky${pStr}" aria-hidden="true"></i>`;
      }
      const cls = s.good ? "dry-good" : "dry";
      const t = s.good ? "suché okno" : "beze srážek";
      return `<i class="${cls}" title="${cas}${t}${pStr}" aria-hidden="true"></i>`;
    }
    const h = Math.max(12, Math.round(rate / maxV * 100));
    const op = p != null ? Math.max(0.45, p / 100).toFixed(2) : null;
    return `<i style="height:${h}%${op ? `;opacity:${op}` : ""}" `
      + `title="${cas}${num(rate)} mm/h${pStr}" aria-hidden="true"></i>`;
  }).join("");
}

/**
 * Shrnutí celé dráhy jednou větou — VE STEJNÝCH datech, jaká kreslí sloupce.
 *
 * Dva důvody, proč to existuje:
 *
 * 1) Nad dráhou stála jediná věta, psaná z 12h výhledu, ale vidět byla i na
 *    2h záložce. V jedné kartě tak stály tři odpovědi na "kdy bude pršet"
 *    (odpočet, sloupce, věta) ze tří různých výpočtů a nemusely souhlasit.
 *    Teď má každé měřítko svoji větu a ta se počítá z týchž slotů, ze
 *    kterých vyrostly jeho sloupce — odporovat si nemají čím.
 *
 * 2) Sloupce nesly svá čísla výhradně v `title`. Ten se na dotyku nezobrazí
 *    vůbec a odečítače ho čtou nespolehlivě, takže data, která existují jen
 *    tam, na telefonu fakticky neexistují. Dvacet čtyři jednotlivých popisků
 *    je ale i pro odečítač k ničemu — nikdo neposlouchá dvacet čtyři hodnot
 *    po sobě. Sloupce jsou proto `aria-hidden` a čte se tahle věta.
 *
 * @returns {{html:string, text:string}} html do panelu, text do aria-label
 */
export function precipSummary(slots, okno) {
  const wet = slots.filter(s => (s.rate ?? 0) >= WET_RATE);
  const b = (s) => ({ html: `<b>${s}</b>`, text: s });

  if (!wet.length) {
    const maybe = slots.some(s => (s.prob ?? 0) >= 30);
    const veta = maybe
      ? `Model ${okno} sucho nevidí jistě — je nezanedbatelná šance na přeháňku.`
      : `Beze srážek ${okno}.`;
    return { html: veta, text: `Srážky ${okno}: ${veta}` };
  }

  const first = wet[0];
  const max = wet.reduce((a, c) => (c.rate > a.rate ? c : a));
  const kdyOd = first.ms != null ? localHM(new Date(first.ms).toISOString()) : null;
  const kdyMax = max.ms != null ? localHM(new Date(max.ms).toISOString()) : null;
  const sila = num(max.rate);

  // Když je první mokrý slot rovnou ten první v řadě, "od HH:MM" by znělo
  // jako budoucnost, i když prší právě teď.
  const zacatek = first === slots[0]
    ? "Prší"
    : kdyOd ? `Déšť ${b(`od ${kdyOd}`).html}` : "Déšť";
  const zacatekTxt = first === slots[0]
    ? "prší" : kdyOd ? `déšť od ${kdyOd}` : "déšť";

  const vrchol = kdyMax ? `, nejsilněji ${sila} mm/h kolem ${kdyMax}` : `, až ${sila} mm/h`;
  return {
    html: `${zacatek}${vrchol}.`,
    text: `Srážky ${okno}: ${zacatekTxt}${vrchol}.`,
  };
}

/** Osa pod sloupci: "teď" a pak hodiny, rovnoměrně rozmístěné. */
export function precipAxisHtml(msList, n = 5) {
  if (!msList.length) return "";
  const last = msList.length - 1;
  const idx = [];
  for (let i = 0; i < n; i++) {
    const j = Math.round(i * last / (n - 1));
    if (!idx.includes(j)) idx.push(j);
  }
  return idx.map((j, k) => `<span>${k === 0
    ? "teď" : localHM(new Date(msList[j]).toISOString())}</span>`).join("");
}
