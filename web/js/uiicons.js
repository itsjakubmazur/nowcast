// Jednotná ikonografie ovládacích prvků — čisté stroke SVG (currentColor),
// místo emoji, které vypadala lacině a na každé platformě jinak. Styl:
// 24px viewBox, tenká linka, zaoblené konce. Prvky s data-icon="<name>"
// dostanou ikonu předsazenou před text; volá se jednou po DOMContentLoaded.

const P = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  satellite: '<path d="M6 18a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.6A3.5 3.5 0 0 1 18 18Z"/><path d="M9 21l1.5-2M14 21l-1-2"/>',
  wind: '<path d="M4 9h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M4 13h13a2.5 2.5 0 1 1-2.5 2.5"/>',
  waves: '<path d="M3 8c1.4 0 1.4 1.4 2.8 1.4S7.2 8 8.6 8 10 9.4 11.4 9.4 12.8 8 14.2 8s1.4 1.4 2.8 1.4S18.4 8 19.8 8"/><path d="M3 13c1.4 0 1.4 1.4 2.8 1.4S7.2 13 8.6 13 10 14.4 11.4 14.4 12.8 13 14.2 13s1.4 1.4 2.8 1.4S18.4 13 19.8 13"/>',
  droplet: '<path d="M12 3s6 6.4 6 10a6 6 0 0 1-12 0c0-3.6 6-10 6-10Z"/>',
  droplets: '<path d="M8 4s3.5 4 3.5 6.2A3.5 3.5 0 0 1 8 13.7 3.5 3.5 0 0 1 4.5 10.2C4.5 8 8 4 8 4Z"/><path d="M15.5 10s3.5 4 3.5 6.2A3.5 3.5 0 0 1 15.5 20 3.5 3.5 0 0 1 12 16.2c0-2.2 3.5-6.2 3.5-6.2Z"/>',
  thermometer: '<path d="M14 4a2 2 0 0 0-4 0v9.3a4 4 0 1 0 4 0Z"/><path d="M12 16.5a1.5 1.5 0 1 0 0-.01"/>',
  rain: '<path d="M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9.5-1.6A3.5 3.5 0 0 1 18 15"/><path d="M8 18l-1 2M12 18l-1 2M16 18l-1 2"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9 5l3 2 3-2M9 19l3-2 3 2"/>',
  gauge: '<path d="M4.5 18a8 8 0 1 1 15 0"/><path d="M12 14l3.5-3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  bolt: '<path d="M13 2 5 13h6l-1 9 8-12h-6z"/>',
  // Akce v kartě — dřív emoji (☆ 🔕 🔗 🖼 ⇄), která se na každé platformě
  // kreslila jinak a v barvě, zatímco ovládání mapy hned nad tím mělo tenké
  // jednobarevné glyfy. Dva ikonografické jazyky na jedné obrazovce.
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9Z"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  'bell-off': '<path d="M18 9a6 6 0 0 0-9.3-5"/><path d="M6.2 6.2A6 6 0 0 0 6 9c0 5-2 6-2 6h12"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/><path d="M3 3l18 18"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 5.8"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.5-1.5"/>',
  frame: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 15l4.5-4.5 4 4 3-3L21 17"/>',
  compare: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',

  // ── Aktivity dnes ──────────────────────────────────────────────────────
  // Postavy jsou schválně jednoduché: v mřížce se kreslí 26 px, kde se
  // z detailů stejně stane šmouha. Nese je silueta, ne kresba.
  run: '<circle cx="15" cy="4.5" r="1.8"/><path d="M13.4 8.2 9.5 10l-1.2 3.6"/><path d="m13.4 8.2 3.1 2.4.9 3.9"/><path d="m11.4 13.2-.9 3.4L7 20"/><path d="m17.4 14.5 1.6 2.3M8.3 13.6 4.6 12"/>',
  bike: '<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 10 8h4"/><path d="m10 8 5 8.5M8 16.5h7"/><circle cx="16.5" cy="4" r="1.5"/>',
  // Konev se ve 20 px rozpadla na visací zámek s čárkou. Kapka nad klíčkem
  // je čitelná i v této velikosti a říká totéž: zalévat, nebo nezalévat.
  watering: '<path d="M12 2.2s2.4 2.9 2.4 4.4a2.4 2.4 0 0 1-4.8 0C9.6 5.1 12 2.2 12 2.2Z"/><path d="M12 21v-9.5"/><path d="M12 16c-3.2 0-5-1.8-5.2-5 3.4 0 5 1.7 5.2 5Z"/><path d="M12 19c3.2 0 5-1.8 5.2-5-3.4 0-5 1.7-5.2 5Z"/>',
  laundry: '<path d="M8 3.5 5 5.2V9l2-.7V20h10V8.3l2 .7V5.2L16 3.5"/><path d="M8 3.5a4 4 0 0 0 8 0"/>',
  // Lichoběžník s nožkami se četl jako pohár. Kotlový gril (mísa + rošt +
  // nožky + dvě obláčky kouře) je jednoznačný.
  grill: '<path d="M3.5 10.5h17"/><path d="M5 10.5a7 7 0 0 0 14 0"/><path d="m9 16.2-2 4.8M15 16.2l2 4.8"/><path d="M9 7.5c0-1.2 1.2-1.6 1.2-2.8M13.8 7.5c0-1.2 1.2-1.6 1.2-2.8"/>',
  telescope: '<path d="m3.5 14.5 12-8 2.5 3.8-12 8z"/><path d="m18 10.3 2.2-1.4-2.5-3.8L15.5 6.5"/><path d="M8.5 15.5 11 21M8.5 15.5 6 21"/><path d="M4 18h5"/>',

  // ── Drobnosti v textu ──────────────────────────────────────────────────
  sparkle: '<path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z"/><path d="M18.5 15.5 19.2 18l2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-4M12 16V7M16 16v-6M20 16v-9"/>',
  flame: '<path d="M12 21a5.5 5.5 0 0 0 5.5-5.5c0-4-3.5-5.5-3-9.5-2 1-3.5 3-3.5 5 0 1.5-1 2-1.5 1.2C9 11 8.8 10 9 9c-1.5 1.4-2.5 3.6-2.5 6.5A5.5 5.5 0 0 0 12 21Z"/>',
  ice: '<path d="M12 2.5v19M4 7l16 10M20 7 4 17"/><path d="m9 4.2 3 2 3-2M9 19.8l3-2 3 2"/><path d="m4.6 11.4-.4 3.4M19.4 11.4l.4 3.4"/>',
  warning: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 9.5v4.5M12 17h.01"/>',
  mist: '<path d="M4 8h12M8 12h12M4 16h11"/>',
  gust: '<path d="M3 8h10a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h14a2.5 2.5 0 1 1-2.5 2.5"/><path d="M3 16h8"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  // Trojúhelník se sází výplní, ne tahem: tahová varianta má u špičky
  // spoj tří čar a v 16 px z toho je klika, ne šipka.
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke-linejoin="round"/>',
};

export function uiIcon(name, cls = "uicon") {
  const p = P[name];
  if (!p) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// Předsadí ikonu všem prvkům s data-icon (zachová textový popisek za ní).
export function initUiIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(el => {
    if (el.dataset.iconDone) return;
    const svg = uiIcon(el.dataset.icon);
    if (svg) { el.insertAdjacentHTML("afterbegin", svg); el.dataset.iconDone = "1"; }
  });
}
