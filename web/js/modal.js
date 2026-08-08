// ── Modální dialogy ─────────────────────────────────────────────────────────
//
// Appka měla tři překryvy (nastavení, detail stanice, porovnání míst) a ani
// jeden nebyl doopravdy modální. Měřeno v prohlížeči: fokus po otevření zůstal
// na tlačítku pod překryvem, čtrnáct stisků Tab z dialogu postupně uteklo do
// stránky za ním, chyběl `role` i `aria-modal`, a Escape nedělal nic — jediný
// Escape v celém projektu poslouchal našeptávač hledání.
//
// Prakticky to znamená dvě věci. Kdo ovládá appku klávesnicí, se do dialogu
// vůbec nedostane (fokus je pořád venku) a kdo se do něj dostane myší, z něj
// neuteče konvenční cestou. Odečítač navíc předčítá obsah PODLE překryvu jako
// by byl součástí dialogu.
//
// Tenhle modul dělá to, co dialog dělat má, a dělá to na jednom místě:
//   • fokus dovnitř při otevření (první ovladač, ne zavírací křížek —
//     ten je poslední věc, kterou uživatel chce)
//   • fokus zpátky na spouštěč při zavření; jinak skočí na začátek stránky
//   • Tab cyklí uvnitř, Shift+Tab taky
//   • Escape zavírá
//   • `inert` na zbytek stránky, takže obsah pod překryvem přestane
//     existovat i pro odečítač a pro myš, ne jen opticky
//
// Proč ne nativní <dialog>: překryvy mají vlastní sklo, animaci a zavírání
// klikem na pozadí, a `::backdrop` s backdrop-filter se v našem případě bije
// s mapou pod ním. Chování se dá dodat; vzhled by se přepisoval hůř.

const OPEN = "open";

/** Prvky, na které jde v dialogu stoupnout fokusem. */
function focusables(root) {
  return [...root.querySelectorAll(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled),'
    + ' textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter(el => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Udělá z překryvu skutečný dialog.
 *
 * @param {object} o
 * @param {string} o.overlay  id překryvu (tmavá plocha přes celou obrazovku)
 * @param {string} o.box      id vlastní karty dialogu
 * @param {string} o.label    viditelný nadpis → aria-labelledby
 * @returns {{open: () => void, close: () => void, isOpen: () => boolean}}
 */
export function bindModal({ overlay: overlayId, box: boxId, label }) {
  const overlay = document.getElementById(overlayId);
  const box = document.getElementById(boxId);
  if (!overlay || !box) return { open() {}, close() {}, isOpen: () => false };

  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");

  // Pojmenování se hledá při KAŽDÉM otevření, ne jednou při navázání.
  // Detail stanice si obsah karty pokaždé překreslí, takže při navázání
  // je karta prázdná a nadpis by se nenašel nikdy.
  const pojmenuj = () => {
    const h = box.querySelector("h1, h2, h3, .settings-head > :first-child");
    if (h) {
      if (!h.id) h.id = `${boxId}-title`;
      box.setAttribute("aria-labelledby", h.id);
      box.removeAttribute("aria-label");
    } else if (label) {
      box.setAttribute("aria-label", label);
    }
  };

  let vratitFokus = null;

  const isOpen = () => overlay.classList.contains(OPEN);

  // `inert` sourozencům překryvu, ne <body> — inert na rodiči by vypnul
  // i samotný dialog.
  const stranku = (vypnout) => {
    for (const el of document.body.children) {
      if (el === overlay) continue;
      if (vypnout) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  };

  const open = () => {
    if (isOpen()) return;
    vratitFokus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add(OPEN);
    pojmenuj();
    stranku(true);
    // První ovladač, ne zavírací křížek. Kdo dialog otevřel, chce v něm něco
    // nastavit — nabídnout mu jako první "zavřít" je posměch.
    const f = focusables(box);
    const cil = f.find(el => !/close/i.test(el.id || "")) || f[0] || box;
    if (cil === box) box.setAttribute("tabindex", "-1");
    cil.focus?.({ preventScroll: true });
  };

  const close = () => {
    if (!isOpen()) return;
    overlay.classList.remove(OPEN);
    stranku(false);
    vratitFokus?.focus?.({ preventScroll: true });
    vratitFokus = null;
  };

  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  // Posluchač visí na dokumentu, ne na překryvu. Kdyby byl na překryvu,
  // Escape by fungoval jen s fokusem uvnitř — a po kliknutí na tmavé pozadí
  // je fokus na <body>, takže právě ve chvíli, kdy uživatel chce nejvíc ven,
  // by klávesa nedělala nic. Stráž `isOpen()` zajistí, že se tři dialogy
  // navzájem neruší.
  document.addEventListener("keydown", e => {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables(box);
    if (!f.length) return;
    const prvni = f[0], posledni = f[f.length - 1];
    // Cyklení. Bez toho Tab z posledního prvku vypadne do stránky pod
    // překryvem, což bylo přesně to naměřené chování (14 ze 14 úniků).
    if (e.shiftKey && document.activeElement === prvni) { e.preventDefault(); posledni.focus(); }
    else if (!e.shiftKey && document.activeElement === posledni) { e.preventDefault(); prvni.focus(); }
  });

  return { open, close, isOpen };
}
