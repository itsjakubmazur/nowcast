// Navigace sekcí — Teď / Dnes / Týden / Data.
//
// DŮLEŽITÉ: navigace nic neskrývá, jen skáče.
//
// První verze sekce FILTROVALA: přepnutí na "Data" schovalo nowcast, předpověď
// i týden. Vypadalo to elegantně a v testech to procházelo, ale při prvním
// skutečném použití se ukázalo, proč je to špatně — stačí palcem trefit spodní
// lištu a z appky zmizí většina obsahu. Nikde není vidět, že se něco skrývá,
// takže to nevypadá jako filtr, ale jako že appka přišla o funkce. Cena za
// "míň scrollování" byla nepřijatelná: kdo si toho nevšimne, přijde přesně
// o data, kvůli kterým appku otevřel.
//
// Skok na sekci má stejný užitek — nemusíš rolovat přes všechno — ale nemůže
// nic ztratit. Všechno zůstává v jednom svitku a navigace jen ukazuje, kde
// právě jsi, a dovede tě jinam.

const SECTIONS = ["now", "today", "week", "data"];

// První panel každé sekce = cíl skoku. Pořadí uvnitř pole je pořadí
// preference: když první panel zrovna nemá data a je schovaný, skáče se na
// další v řadě.
const ANCHORS = {
  now: ["precip-panel", "forecast-panel", "storm-impact"],
  today: ["fc24", "meteo-block", "aq-panel"],
  week: ["fc7", "history-panel", "normal-panel"],
  data: ["blend-card", "models-panel", "push-status"],
};

function visible(el) {
  return !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 4;
}

function anchorFor(sec) {
  for (const id of ANCHORS[sec] || []) {
    const el = document.getElementById(id);
    if (visible(el)) return el;
  }
  return null;
}

function markActive(sec) {
  document.querySelectorAll("#secnav button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.sec === sec));
  });
}

/**
 * Najdi kontejner, ve kterém cíl skutečně roluje.
 *
 * Na desktopu má appka DVA nezávislé svitky — levou kartu a pravý panel — a
 * na mobilu roluje celá stránka. Skákat natvrdo do levé karty proto nešlo:
 * sedmidenní výhled leží v pravém panelu, takže se nic nepohnulo.
 */
function scrollerOf(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return null;
}

function jumpTo(sec) {
  const el = anchorFor(sec);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const behavior = reduce ? "auto" : "smooth";
  const scroller = scrollerOf(el);
  if (scroller) {
    const top = scroller.scrollTop + el.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top - 8;
    scroller.scrollTo({ top: Math.max(0, top), behavior });
  } else {
    // Odsazení o výšku topbaru, ať cíl neskončí schovaný pod ním.
    const y = el.getBoundingClientRect().top + window.scrollY - 64;
    window.scrollTo({ top: Math.max(0, y), behavior });
  }
}

/**
 * Zvýraznění podle toho, co je právě na obrazovce.
 *
 * Počítá se z pozice kotev, ne přes IntersectionObserver: kotvy se objevují
 * a mizí podle toho, jestli mají data, a observer by se musel při každém
 * překreslení přepojovat. Prosté porovnání souřadnic je tady levnější
 * i spolehlivější.
 */
function spy() {
  // JEN na mobilu. Na desktopu jsou dva nezávislé svitky vedle sebe, takže
  // "kde právě jsem" nemá jednu odpověď — čtecí linka přes celé okno by
  // porovnávala souřadnice z různých kontejnerů a skákala by náhodně.
  // Ve dvou sloupcích je stejně vidět obojí naráz, takže se ptát nemusíme.
  if (!window.matchMedia?.("(max-width: 768px)")?.matches) return;
  const line = window.innerHeight * 0.35;   // "čtecí linka" v horní třetině
  let current = SECTIONS[0];
  for (const sec of SECTIONS) {
    const el = anchorFor(sec);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= line) current = sec;
  }
  markActive(current);
}

export function initSections() {
  const nav = document.getElementById("secnav");
  if (!nav) return;
  markActive(SECTIONS[0]);

  nav.addEventListener("click", e => {
    const btn = e.target.closest("button[data-sec]");
    if (!btn) return;
    markActive(btn.dataset.sec);
    jumpTo(btn.dataset.sec);
  });

  nav.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const cur = [...nav.querySelectorAll("button")]
      .find(b => b.getAttribute("aria-pressed") === "true")?.dataset.sec;
    const i = SECTIONS.indexOf(cur || SECTIONS[0]);
    const next = SECTIONS[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    markActive(next);
    jumpTo(next);
    nav.querySelector(`button[data-sec="${next}"]`)?.focus();
  });

  // Scroll je hlučný — stačí přepočítat jednou za snímek.
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; spy(); });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  document.getElementById("left-card")?.addEventListener("scroll", onScroll, { passive: true });
  document.getElementById("right-panel")?.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  spy();
}

/**
 * Tečka u sekce, ve které se právě něco děje.
 *
 * Po přechodu na skákání není životně důležitá (nic není schované), ale pořád
 * říká, kam se vyplatí skočit — třeba že dole v Datech hlásí upozornění chybu.
 */
export function markSectionAlerts() {
  const nav = document.getElementById("secnav");
  if (!nav) return;
  const flags = { now: false, today: false, week: false, data: false };

  const cd = document.getElementById("rain-countdown");
  const impact = document.getElementById("storm-impact");
  flags.now = !!(impact?.classList.contains("show")
    || (cd?.classList.contains("show") && /min|hod/.test(cd.textContent || "")));

  const push = document.getElementById("push-status");
  flags.data = !!(push?.textContent && /nefunguj|chyb|selh/i.test(push.textContent));

  for (const [sec, on] of Object.entries(flags)) {
    const b = nav.querySelector(`button[data-sec="${sec}"]`);
    if (b) b.dataset.alert = on ? "1" : "0";
  }
}
