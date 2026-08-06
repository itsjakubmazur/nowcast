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
        return `<i class="maybe" style="height:${h}%" title="${cas}možné srážky${pStr}"></i>`;
      }
      const cls = s.good ? "dry-good" : "dry";
      const t = s.good ? "suché okno" : "beze srážek";
      return `<i class="${cls}" title="${cas}${t}${pStr}"></i>`;
    }
    const h = Math.max(12, Math.round(rate / maxV * 100));
    const op = p != null ? Math.max(0.45, p / 100).toFixed(2) : null;
    return `<i style="height:${h}%${op ? `;opacity:${op}` : ""}" `
      + `title="${cas}${num(rate)} mm/h${pStr}"></i>`;
  }).join("");
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
