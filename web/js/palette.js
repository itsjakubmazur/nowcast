// ── Barvy pro grafy a mapu — čtené z designového systému ────────────────────
//
// Grafy a značky na mapě si barvy psaly natvrdo, a ne jen tak ledajaké:
// #f97316, #ef4444, #22c55e, #a855f7, #06b6d4, #38bdf8, #3b82f6, #f59e0b —
// to je tailwindová paleta. Zbytek appky stojí na iOS systémových barvách.
// Vedle sebe to nikdo nepojmenuje, ale oko to pozná: dvě modré, které nejsou
// tatáž modrá, a dvě oranžové, které si nejsou příbuzné.
//
// Horší než nesoulad je ale to, co z toho plyne: barva se rozhodovala
// v JavaScriptu, takže designový systém končil na hranici CSS. Každá nová
// vrstva grafu si barvu vymyslela znovu a "Pravidlo významu" z DESIGN.md
// pro polovinu appky neplatilo.
//
// Tady se barvy jen ČTOU z :root. Jediné místo, kde jsou definované, zůstává
// app.css — přidat barvu do grafu bez toho, aby byla v systému, tím přestává
// jít. Fallbacky jsou tmavé varianty tokenů pro případ, že by se volalo
// dřív, než se stihne načíst CSS.

/** Role → token. Role je to, CO barva znamená; token, jak vypadá. */
const ROLE = {
  teplota:   ["--temp2",   "#FF6B2C"],
  teplotaMax:["--red",     "#FF453A"],
  teplotaMin:["--blue",    "#0A84FF"],
  srazky:    ["--blue",    "#0A84FF"],
  vlhkost:   ["--green",   "#30D158"],
  tlak:      ["--purple",  "#BF5AF2"],
  vitr:      ["--teal",    "#40C8E0"],
  narazy:    ["--blue",    "#0A84FF"],
  zareni:    ["--yellow",  "#FFD60A"],
  pyl:       ["--green",   "#30D158"],
  neutral:   ["--muted",   "#AAB7C9"],
  vystraha1: ["--yellow",  "#FFD60A"],
  vystraha2: ["--orange",  "#FF9F0A"],
  vystraha3: ["--red",     "#FF453A"],
  chladno:   ["--teal",    "#40C8E0"],
  teplo:     ["--orange",  "#FF9F0A"],
  horko:     ["--red",     "#FF453A"],
  dobre:     ["--green",   "#30D158"],
};

/**
 * Barva role jako konkrétní hodnota.
 *
 * Čte se při každém volání, ne jednou do konstanty: přepnutí motivu mění
 * všechny tokeny a Chart.js si barvu drží zapsanou v datasetu, takže by
 * se po přepnutí zasekla na staré hodnotě.
 */
export function gc(role) {
  const [token, fallback] = ROLE[role] || ROLE.neutral;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v || fallback;
}

/** Táž barva s průhledností — pro výplně pod čarou grafu. */
export function gcAlpha(role, alpha) {
  return `color-mix(in srgb, ${gc(role)} ${Math.round(alpha * 100)}%, transparent)`;
}
