// Lišta vrstev a panel „Vrstvy" — co se kreslí na mapu, odkud to je a jak
// moc to prosvítá.
//
// Vypínače samotné obsluhují jejich původní moduly (radar.js, hydro.js,
// accum.js, lightning.js…); tenhle modul k nim nic nepřidává. Řeší jen dvě
// věci, které dřív neměl na starosti nikdo:
//
//   1. PANEL ZDROJŮ. Appka měla sedm anonymních pilulek a jediné, co o nich
//      říkala, byl `title` — tedy nic, co by šlo přečíst na dotykovém
//      displeji. Přitom „Družice" jsou cizí dlaždice RainVieweru a „Teploty"
//      jsou naopak měření, ne model. Přiznaný zdroj je zásada projektu, ale
//      pro vrstvy mapy neplatila.
//
//   2. ZRCADLENÍ STAVU. Panel a lišta ukazují tytéž vrstvy ze dvou stran,
//      takže se nesmí rozejít. Stav se nečte z proměnných jednotlivých
//      modulů (těch je šest a každý si ho drží po svém), ale z třídy
//      `.active` na tlačítku — stejný zdroj pravdy, jaký už používá
//      togglestate.js pro ARIA. Jedna pravda, dva odrazy.

import { setSatOpacity } from "./radar.js";

// data-for v panelu → id tlačítka v liště
const PAROVANI = {
  global: "btn-global",
  satellite: "btn-satellite",
  temps: "btn-temps",
  storms: "btn-storms",
  wind: "btn-wind",
  hydro: "btn-hydro",
  accum: "btn-accum",
};

let _mo = null;

/** Přepíše `.on` na kartách vrstev podle `.active` na tlačítkách. */
function zrcadliStav() {
  for (const [key, id] of Object.entries(PAROVANI)) {
    const btn = document.getElementById(id);
    const karta = document.querySelector(`.lsrc[data-for="${key}"]`);
    if (btn && karta) karta.classList.toggle("on", btn.classList.contains("active"));
  }
}

function otevrit(open) {
  const sheet = document.getElementById("layer-sheet");
  const btn = document.getElementById("btn-layer-sheet");
  if (!sheet || !btn) return;
  sheet.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) zrcadliStav();
}

function jeOtevreno() {
  return document.getElementById("layer-sheet")?.hidden === false;
}

export function initLayerRail() {
  const rail = document.getElementById("layer-rail");
  const sheet = document.getElementById("layer-sheet");
  const btn = document.getElementById("btn-layer-sheet");
  if (!rail || !sheet || !btn) return;

  btn.addEventListener("click", () => otevrit(!jeOtevreno()));
  document.getElementById("btn-layer-sheet-close")
    ?.addEventListener("click", () => { otevrit(false); btn.focus(); });

  // Escape zavírá i tenhle panel. Appka má stejnou smlouvu u dialogů
  // nastavení a porovnání — kdyby ji zrovna panel vrstev neměl, byl by to
  // ten jeden prvek, u kterého si uživatel musí pamatovat výjimku.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && jeOtevreno()) { otevrit(false); btn.focus(); }
  });

  // Klik mimo panel ho zavře — ale JEN na desktopu, kde je to plovoucí
  // vrstva nad mapou. Na mobilu leží panel v toku dokumentu jako běžný blok,
  // takže „mimo" znamená kdekoli na stránce a panel by se zavřel při prvním
  // pokusu o rolování.
  document.addEventListener("pointerdown", e => {
    if (!jeOtevreno()) return;
    if (window.matchMedia?.("(max-width: 768px)").matches) return;
    if (sheet.contains(e.target) || rail.contains(e.target)) return;
    otevrit(false);
  });

  const sat = document.getElementById("sat-opacity");
  if (sat) {
    sat.value = "50";
    sat.addEventListener("input", () => setSatOpacity(+sat.value));
  }

  // Stav se mění zvenčí (klik na tlačítko, automatické zapnutí světového
  // režimu, obnova z nastavení), takže se pozoruje, nepřepisuje ručně na
  // každém volajícím místě — to je přesně ta chyba, kterou popisuje
  // togglestate.js.
  zrcadliStav();
  if (typeof MutationObserver === "function") {
    _mo?.disconnect();
    _mo = new MutationObserver(zrcadliStav);
    for (const id of Object.values(PAROVANI)) {
      const el = document.getElementById(id);
      if (el) _mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    }
  }
}

/**
 * Zobrazí lištu vrstev. Volá se ve stejnou chvíli jako odkrytí doku radaru —
 * do té doby je mapa prázdná a řada vypínačů nad ní by neměla co zapínat.
 */
export function showLayerRail() {
  document.getElementById("layer-rail")?.classList.add("show");
}
