// ── Prázdný a chybový stav panelů ───────────────────────────────────────────
//
// Appka měla na čtyřiceti místech `el.classList.remove("show")` a nikde jediný
// text "nemám data". Když selhala síť, panel prostě přestal být. To je nejhorší
// možná zpětná vazba, protože nerozlišitelně vypadá jako tři různé věci:
// "tuhle funkci nemáš", "tady zrovna není co ukázat" a "něco se rozbilo".
// Uživatel z toho neví, jestli má čekat, kliknout, nebo si stěžovat.
//
// Skrývat panel je správně jen tehdy, když opravdu NENÍ CO ŘÍCT — třeba
// bouřkový banner bez bouřky. Tam je prázdno informace. Když ale panel MĚL
// mluvit a nemohl, musí to říct.
//
// Dvě varianty, protože jsou to dvě různé situace:
//   panelEmpty  — data dorazila, ale nic v nich není / ještě nejsou
//   panelError  — data nedorazila; nabídne se zopakování
//
// Chybový stav si schválně nechává hlavičku panelu. Bez ní je to anonymní
// šedý obdélník a uživatel neví, KTERÁ část appky selhala.

import { esc } from "./utils.js";

/**
 * @param {HTMLElement} el      panel
 * @param {string} title        hlavička, ať je poznat, co selhalo
 * @param {string} msg          co se stalo, lidsky
 * @param {() => void} [retry]  když je zadané, přibude tlačítko
 */
export function panelError(el, title, msg, retry) {
  if (!el) return;
  el.innerHTML = `<div class="pfail">
    <div class="pfail-t">${esc(title)}</div>
    <div class="pfail-m">${esc(msg)}</div>
    ${retry ? `<button type="button" class="pfail-r">Zkusit znovu</button>` : ""}
  </div>`;
  if (retry) {
    el.querySelector(".pfail-r")?.addEventListener("click", () => {
      // Ať je vidět, že klik něco udělal — jinak se při rychlém selhání
      // tlačítko jen "mihne" a vypadá to, že nereaguje.
      const b = el.querySelector(".pfail-r");
      if (b) { b.disabled = true; b.textContent = "Načítám…"; }
      retry();
    }, { once: true });
  }
  el.classList.add("show");
}

/** Panel je v pořádku, jen nemá co ukázat. */
export function panelEmpty(el, title, msg) {
  if (!el) return;
  el.innerHTML = `<div class="pfail pfail-quiet">
    <div class="pfail-t">${esc(title)}</div>
    <div class="pfail-m">${esc(msg)}</div>
  </div>`;
  el.classList.add("show");
}
