// ── Stav přepínačů pro odečítač ─────────────────────────────────────────────
//
// Šestnáct ovladačů mapy neslo svůj stav VÝHRADNĚ barvou: `.active` obarví
// text a přidá prstenec, a to je všechno. Kdo appku neovládá očima, nezjistí,
// které vrstvy běží — a `#btn-temps` s `#btn-storms` startují zapnuté, takže
// nejde ani odvodit "nic není zapnuté". WCAG 1.4.1 (informace nesmí být nesena
// jen barvou) i 4.1.2 (název, role, hodnota).
//
// Stav se ale přepíná na patnácti různých místech v šesti modulech
// (radar.js, app.js, hydro.js, accum.js, settings.js…). Doplnit `aria-pressed`
// ke každému `classList.add("active")` znamená patnáct míst, která se při
// první další úpravě rozejdou. Proto je tady JEDEN pozorovatel: `.active` je
// zdroj pravdy, ARIA je jeho odraz. Nové tlačítko se přidá do seznamu níž
// a funguje samo.
//
// Dvě různé skupiny, dvě různé role:
//   • Vrstvy mapy jsou NEZÁVISLÉ vypínače → aria-pressed
//   • Rychlost animace a veličina stanic jsou VÝLUČNÉ volby → radiogroup
//     s aria-checked; "vybírá se jedna z devíti" je jiná informace než
//     "zapíná se libovolně mnoho ze sedmi", a odečítač to musí rozlišit.

const NEZAVISLE = "#radar-row-layers > button.ctrl";
const VYLUCNE = [
  { sel: ".speed-group .ctrl", skupina: ".speed-group", jmeno: "Rychlost animace" },
  { sel: "#layer-selector .layer-btn", skupina: "#layer-selector", jmeno: "Veličina stanic" },
];

function nastav(el, atribut) {
  el.setAttribute(atribut, el.classList.contains("active") ? "true" : "false");
}

export function initToggleState() {
  const sleduj = [];

  for (const el of document.querySelectorAll(NEZAVISLE)) {
    nastav(el, "aria-pressed");
    sleduj.push([el, "aria-pressed"]);
  }

  for (const { sel, skupina, jmeno } of VYLUCNE) {
    const box = document.querySelector(skupina);
    const btns = [...document.querySelectorAll(sel)];
    if (!btns.length) continue;
    if (box) {
      box.setAttribute("role", "radiogroup");
      // Popisky skupin ("Na mapě", "Stanice") byly aria-hidden, takže odečítač
      // dostal šestnáct nezařazených tlačítek. Jméno teď nese kontejner.
      if (!box.hasAttribute("aria-label")) box.setAttribute("aria-label", jmeno);
    }
    for (const el of btns) {
      el.setAttribute("role", "radio");
      nastav(el, "aria-checked");
      sleduj.push([el, "aria-checked"]);
    }
  }

  // Skupina vrstev mapy taky potřebuje jméno — jinak je to řada tlačítek
  // bez kontextu. `.rl-label` zůstává aria-hidden, protože by se jinak
  // předčítala dvakrát: jednou jako text, podruhé jako jméno skupiny.
  const vrstvy = document.getElementById("radar-row-layers");
  if (vrstvy && !vrstvy.hasAttribute("aria-label")) {
    vrstvy.setAttribute("role", "group");
    vrstvy.setAttribute("aria-label", "Vrstvy na mapě");
  }

  if (!sleduj.length || typeof MutationObserver !== "function") return;

  const mo = new MutationObserver(zaznamy => {
    for (const z of zaznamy) {
      const par = sleduj.find(([el]) => el === z.target);
      if (par) nastav(par[0], par[1]);
    }
  });
  for (const [el] of sleduj) mo.observe(el, { attributes: true, attributeFilter: ["class"] });
}
