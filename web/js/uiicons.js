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
