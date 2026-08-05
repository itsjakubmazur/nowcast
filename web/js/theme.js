// Motiv: respektuje prefers-color-scheme dokud uživatel ručně nepřepne
// (pak se explicitní volba uloží a vždy vyhraje — viz app.css media query
// vs. [data-theme] selektory).

import { uiIcon } from "./uiicons.js";

const THEME_KEY = "nowcast_theme"; // "dark" | "light" | absent = systémový

function systemPrefersLight() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function applyThemeColorMeta(isLight) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", isLight ? "#2563eb" : "#4f8ef7");
}

export function initTheme() {
  const btn = document.getElementById("btn-theme");

  // Vždy čte čerstvou hodnotu z localStorage — NESMÍ se zachytit jednou do
  // uzávěru, jinak render() po kliknutí pořád vidí starou hodnotu (viz #4).
  function currentIsLight() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light") return true;
    if (saved === "dark") return false;
    return systemPrefersLight();
  }

  function render() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
    else if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme"); // systémový = CSS media query rozhodne
    const isLight = currentIsLight();
    // Glyf, ne emoji: ☀️/🌙 se na každé platformě kreslí jinak (a barevně)
    // uprostřed řady jednobarevných ikon v topbaru.
    if (btn) {
      btn.innerHTML = uiIcon(isLight ? "moon" : "sun");
      btn.title = isLight ? "Přepnout na tmavý motiv" : "Přepnout na světlý motiv";
      btn.setAttribute("aria-label", btn.title);
    }
    applyThemeColorMeta(isLight);
  }
  render();

  if (btn) {
    btn.addEventListener("click", () => {
      const nowLight = currentIsLight();
      const next = nowLight ? "dark" : "light";
      localStorage.setItem(THEME_KEY, next);
      window.__nowcastTheme = next;
      render();
      window.dispatchEvent(new CustomEvent("nowcast:theme-changed"));
    });
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (!localStorage.getItem(THEME_KEY)) {
        render();
        window.dispatchEvent(new CustomEvent("nowcast:theme-changed"));
      }
    });
  }
}

export function isDarkTheme() {
  return document.documentElement.getAttribute("data-theme") !== "light"
    && !(!document.documentElement.hasAttribute("data-theme") && systemPrefersLight());
}
