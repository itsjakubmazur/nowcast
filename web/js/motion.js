// Pohyb v appce — jedno místo, jedna pravidla.
//
// Tři zásady, protože animace v meteo appce může snadno škodit víc, než
// pomůže:
//
//  1. ANIMUJE SE JEN PRVNÍ OBJEVENÍ A AKCE UŽIVATELE. Data se obnovují každých
//     pět minut; kdyby se u každého obnovení něco hýbalo, stránka by trhala
//     sama od sebe a ještě by tím kradla pozornost od toho, že se něco
//     doopravdy změnilo.
//
//  2. ŽÁDNÉ NAPOČÍTÁVÁNÍ ČÍSEL. U naměřených hodnot je to aktivně špatně:
//     než teplota "dojede" z 0 na 22, appka dvě vteřiny ukazuje hodnoty,
//     které nikdo nenaměřil. Číslo se objeví hotové.
//
//  3. prefers-reduced-motion VYPÍNÁ VŠECHNO. Ne "zkrátí", vypne — kdo si to
//     nastaví, nechce ani decentní pohyb.

export function reducedMotion() {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

// ── Postupné nabíhání panelů ────────────────────────────────────────────────
// Karta má přes dvacet panelů. Když naskočí naráz, je to zeď; když se složí
// po sobě, oko stihne zaregistrovat, co kde je. Rozestup 40 ms je kompromis:
// míň splyne v jeden pohyb, víc už se čeká.
//
// Běží JEDNOU za život stránky. Druhé volání je no-op, takže obnovení dat
// ani přepnutí místa nic nerozhýbe.
const _risen = new WeakSet();

export function riseIn(root = document) {
  if (reducedMotion()) return 0;
  const sel = "#left-card > *, #right-panel > *";
  let i = 0;
  for (const el of root.querySelectorAll(sel)) {
    if (_risen.has(el)) continue;
    _risen.add(el);
    // Skryté panely se nepočítají do prodlevy — jinak by mezi dvěma
    // viditelnými vznikla pauza za všechny neviditelné mezi nimi.
    if (el.offsetParent === null) continue;
    el.style.setProperty("--rise-i", String(i++));
    el.classList.add("rise-in");
  }
  return i;
}

// ── Přechod mezi stavy (View Transitions) ───────────────────────────────────
// Prohlížeč, který to neumí, dostane holé zavolání funkce — žádný polyfill,
// žádná knihovna. Degraduje na "změní se to hned", což je v pořádku.
export function withTransition(fn) {
  if (reducedMotion() || !document.startViewTransition) { fn(); return; }
  try { document.startViewTransition(fn); } catch { fn(); }
}

// ── Překreslení proužku po přepnutí dne ─────────────────────────────────────
// Bez pohybu není poznat, že se něco stalo: sloupce se prostě přepíšou jinými
// čísly. Krátký posun ve směru, kterým jsi v týdnu skočil, to spojí
// s klepnutím na den.
export function slideSwap(el, dir, fill) {
  if (!el) return;
  if (reducedMotion()) { fill(); return; }
  el.style.transition = "none";
  el.style.opacity = "0";
  el.style.transform = `translateX(${dir >= 0 ? 14 : -14}px)`;
  fill();
  void el.offsetWidth;                       // vynutí reflow, ať přechod běží
  el.style.transition = "opacity .26s ease, transform .26s cubic-bezier(.32,.72,0,1)";
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(0)";
  });
}

// ── Animace grafů ───────────────────────────────────────────────────────────
// Chart.js má v appce animation:false všude, a to je správně pro překreslení
// při obnovení dat. Při PRVNÍM vykreslení grafu ale tah zleva doprava ukáže,
// že se něco děje, a stojí to 400 ms.
const _drawn = new Set();

export function chartAnim(key) {
  if (reducedMotion() || _drawn.has(key)) return false;
  _drawn.add(key);
  return { duration: 420, easing: "easeOutQuart" };
}

// Nové místo = grafy se kreslí znovu jako poprvé.
export function resetChartAnim() {
  _drawn.clear();
}
