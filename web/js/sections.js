// Sekce appky — Teď / Dnes / Týden / Data.
//
// Proč to vzniklo: panelů je přes dvacet a po sjednocení vzhledu vypadaly
// všechny stejně důležitě. Jeden dlouhý svitek je pak nepřehledný z principu,
// i kdyby byl každý panel sám o sobě dobrý. Sekce nic nemažou — jen říkají,
// co je právě na řadě.
//
// Dělbu práce s CSS je dobré si pamatovat: SKRÝVÁNÍ dělá výhradně CSS přes
// body[data-sec], protože jednotlivé renderery si viditelnost svých panelů
// řídí samy (style.display, třída .show) a kdyby do toho sahal i tenhle
// modul, přepisovali by si to navzájem. JavaScript tady jen přepíná atribut,
// pamatuje si volbu a hlídá tečku u sekce, kde se něco děje.

import { state } from "./state.js";

const KEY = "nowcast_section";
// "all" je plnohodnotná sekce, ne testovací zadní vrátka: na širokém monitoru
// se celý svitek uživí a filtrovat ho je zbytečné. V CSS pro ni schválně
// není žádné pravidlo — nic se neskrývá.
const SECTIONS = ["now", "today", "week", "data", "all"];
const DEFAULT_SECTION = "now";

export function getSection() {
  try {
    const v = localStorage.getItem(KEY);
    return SECTIONS.includes(v) ? v : DEFAULT_SECTION;
  } catch { return DEFAULT_SECTION; }
}

export function setSection(sec, { remember = true } = {}) {
  if (!SECTIONS.includes(sec)) return;
  document.body.dataset.sec = sec;
  if (remember) { try { localStorage.setItem(KEY, sec); } catch { /* private mode */ } }
  document.querySelectorAll("#secnav button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.sec === sec));
  });
  // Přepnutí sekce mění výšku obsahu — Leaflet o tom musí vědět, jinak
  // zůstane mapa nakreslená na starou velikost.
  state.map?.invalidateSize?.();
  window.dispatchEvent(new CustomEvent("nowcast:section-changed", { detail: { sec } }));
}

/**
 * Přejíždění mezi sekcemi prstem.
 *
 * Vertikální stránkování by tady nefungovalo: karty mají různou výšku
 * (meteogram versus jeden řádek), takže by snap buď ořezával obsah, nebo
 * nechával prázdné plochy, a scroll uvnitř stránky by se pral se stránkováním.
 * Vodorovné gesto tenhle spor nemá — svislý směr zůstane scrollu, vodorovný
 * přepíná sekce. Stejný vzorec, jaký už appka používá u měřítka srážek.
 *
 * Gesto se rozpozná až když je vodorovný posun ZŘETELNĚ větší než svislý,
 * jinak by každé šikmé rolování přeskakovalo sekce. Prvky, které samy
 * vodorovně rolují (hodinový pás, dráha srážek), jsou z gesta vyjmuté —
 * jinak by přejetí přes ně dělalo dvě věci najednou.
 */
const SWIPE_MIN_PX = 60;      // kratší tah je nejistota, ne záměr
const SWIPE_RATIO = 1.7;      // vodorovně musí být o tolik víc než svisle

function initSwipe() {
  let x0 = 0, y0 = 0, active = false;
  const scrollable = t => !!t?.closest?.(
    ".pp-track, .fc24-scroll, #layer-selector, .fc7-grid, #fav-row, .leaflet-container, #secnav");

  document.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || scrollable(e.target)) { active = false; return; }
    active = true;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchend", e => {
    if (!active) return;
    active = false;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    // "Vše" ze sekvence vypadává: je to zvláštní režim, ne další stránka.
    const order = SECTIONS.filter(x => x !== "all");
    const i = order.indexOf(document.body.dataset.sec || DEFAULT_SECTION);
    if (i < 0) return;                       // jsme ve "Vše" — gesto nedělá nic
    const next = order[i + (dx < 0 ? 1 : -1)];
    if (next) setSection(next);
  }, { passive: true });
}

export function initSections() {
  const nav = document.getElementById("secnav");
  if (!nav) return;
  setSection(getSection(), { remember: false });
  initSwipe();

  nav.addEventListener("click", e => {
    const btn = e.target.closest("button[data-sec]");
    if (!btn) return;
    setSection(btn.dataset.sec);
    // Po přepnutí chce člověk vidět začátek nové sekce, ne půlku předchozího
    // svitku. Na desktopu roluje karta, na mobilu stránka.
    const card = document.getElementById("left-card");
    if (card && card.scrollHeight > card.clientHeight) card.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });

  nav.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = SECTIONS.indexOf(document.body.dataset.sec || DEFAULT_SECTION);
    const next = SECTIONS[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    setSection(next);
    nav.querySelector(`button[data-sec="${next}"]`)?.focus();
  });
}

/**
 * Tečka u sekce, ve které se právě něco děje.
 *
 * Bez ní má schovávání jednu vadu: když sedíš v "Týdnu", nedozvíš se, že za
 * dvacet minut přijde bouřka. Tečka je proto minimum, které schování musí
 * vyvážit — ne dekorace.
 */
export function markSectionAlerts() {
  const nav = document.getElementById("secnav");
  if (!nav) return;
  const flags = { now: false, today: false, week: false, data: false };

  // Teď: blíží se srážky, nebo je aktivní zásah bouřkou.
  const cd = document.getElementById("rain-countdown");
  const impact = document.getElementById("storm-impact");
  flags.now = !!(impact?.classList.contains("show")
    || (cd?.classList.contains("show") && /min|hod/.test(cd.textContent || "")));

  // Data: upozornění hlásí chybu (aby se to nedozvěděl až po dešti).
  const push = document.getElementById("push-status");
  flags.data = !!(push?.textContent && /nefunguj|chyb|selh/i.test(push.textContent));

  for (const [sec, on] of Object.entries(flags)) {
    const b = nav.querySelector(`button[data-sec="${sec}"]`);
    if (b) b.dataset.alert = on ? "1" : "0";
  }
}
