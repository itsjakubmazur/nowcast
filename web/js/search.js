import { debounce, esc } from "./utils.js";

const HISTORY_KEY = "nowcast_search_history";
const HISTORY_MAX = 5;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function pushHistory(entry) {
  const hist = loadHistory().filter(h => h.label !== entry.label);
  hist.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, HISTORY_MAX)));
}

export async function geocode(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=cs&country=CZ`);
  return (await r.json()).results || [];
}

// Reverzní geokódování pro GPS tlačítko — ať se místo "Moje poloha" ukáže
// skutečný název obce. Nominatim (OSM), žádný klíč netřeba.
export async function reverseGeocode(lat, lon) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=cs`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const a = data.address || {};
    return a.city || a.town || a.village || a.municipality || a.suburb || a.county || null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function initSearch(onSelect) {
  const input = document.getElementById("search");
  const ul = document.getElementById("suggestions");
  let items = []; // aktuální seznam kandidátů (result nebo history)
  let activeIdx = -1;

  function close() {
    ul.style.display = "none";
    activeIdx = -1;
  }

  function renderList(list, isHistory) {
    items = list;
    activeIdx = -1;
    ul.innerHTML = "";
    if (!list.length) { close(); return; }
    list.forEach((res, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `sugg-${i}`;
      const label = isHistory ? res.label : res.name + (res.admin1 ? `, ${res.admin1}` : "");
      li.innerHTML = isHistory ? `${esc(label)}<span class="sugg-hist">nedávné</span>` : esc(label);
      li.addEventListener("mousedown", e => {
        e.preventDefault();
        pick(i);
      });
      ul.appendChild(li);
    });
    ul.style.display = "block";
  }

  function pick(i) {
    const res = items[i];
    if (!res) return;
    const isHistory = res.lat !== undefined && res.latitude === undefined;
    const lat = isHistory ? res.lat : res.latitude;
    const lon = isHistory ? res.lon : res.longitude;
    const label = isHistory ? res.label : (res.name + (res.admin1 ? `, ${res.admin1}` : ""));
    input.value = isHistory ? res.label : res.name;
    close();
    pushHistory({ lat, lon, label });
    onSelect(lat, lon, isHistory ? res.label : res.name);
  }

  function highlight(idx) {
    ul.querySelectorAll("li").forEach(li => li.removeAttribute("aria-selected"));
    if (idx >= 0 && ul.children[idx]) {
      ul.children[idx].setAttribute("aria-selected", "true");
      ul.children[idx].scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", `sugg-${idx}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  const doSearch = debounce(async v => {
    try { renderList(await geocode(v), false); } catch { /* ignore */ }
  }, 300);

  input.addEventListener("input", e => {
    const v = e.target.value.trim();
    if (v.length < 2) {
      const hist = loadHistory();
      if (hist.length) renderList(hist, true); else close();
      return;
    }
    doSearch(v);
  });

  input.addEventListener("focus", () => {
    if (!input.value.trim()) {
      const hist = loadHistory();
      if (hist.length) renderList(hist, true);
    }
  });

  input.addEventListener("keydown", e => {
    if (ul.style.display === "none" || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      highlight(activeIdx);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      highlight(activeIdx);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(activeIdx >= 0 ? activeIdx : 0);
    } else if (e.key === "Escape") {
      close();
    }
  });

  document.addEventListener("click", e => {
    if (!e.target.closest(".suggest")) close();
  });

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  ul.setAttribute("role", "listbox");
}
