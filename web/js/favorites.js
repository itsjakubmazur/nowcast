import { state, WORKER_BASE } from "./state.js";
import { localHM, esc } from "./utils.js";
import { showToast } from "./toast.js";
import { getSettings, logNotif } from "./settings.js";
import { assessRain, precipDescr } from "./verdict.js";

const FAV_KEY = "nowcast_favs";
const FAV_MAX = 5;
const LAST_LOCATION_KEY = "nowcast_last_location";
const NOTIF_SNOOZE_KEY = "nowcast_notif_snooze";

export function loadFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
  catch { return []; }
}
function saveFavs(favs) {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  maybeResubscribePush();
}

export function saveLastLocation(lat, lon, label) {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat, lon, label, t: Date.now() }));
  } catch { /* ignore */ }
}
export function loadLastLocation() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_LOCATION_KEY));
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
  } catch { /* ignore */ }
  return null;
}

export function renderFavRow(onSelect) {
  const row = document.getElementById("fav-row");
  const favs = loadFavs();
  row.innerHTML = "";
  favs.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "fav-chip";
    chip.innerHTML = `${esc(f.label)} <span class="fav-remove" data-i="${i}" title="Odebrat">✕</span>`;
    chip.addEventListener("click", e => {
      if (e.target.dataset.i !== undefined) {
        const updated = loadFavs();
        updated.splice(+e.target.dataset.i, 1);
        saveFavs(updated);
        renderFavRow(onSelect);
      } else {
        onSelect(f.lat, f.lon, f.label);
      }
    });
    row.appendChild(chip);
  });
}

export function updateFavBtn(lat, lon, label, onChange) {
  const btn = document.getElementById("btn-fav");
  btn.style.display = "";
  const favs = loadFavs();
  const idx = favs.findIndex(f => Math.abs(f.lat - lat) < 0.01 && Math.abs(f.lon - lon) < 0.01);
  if (idx >= 0) {
    btn.textContent = "★ Uloženo";
    btn.classList.add("saved");
    btn.onclick = () => {
      const updated = loadFavs();
      updated.splice(updated.findIndex(f => Math.abs(f.lat - lat) < 0.01 && Math.abs(f.lon - lon) < 0.01), 1);
      saveFavs(updated);
      onChange();
      updateFavBtn(lat, lon, label, onChange);
    };
  } else {
    btn.textContent = "☆ Uložit";
    btn.classList.remove("saved");
    btn.onclick = () => {
      if (loadFavs().length >= FAV_MAX) {
        showToast(`Můžeš mít nejvýše ${FAV_MAX} oblíbených míst.`);
        return;
      }
      saveFavs([...loadFavs(), { lat, lon, label }]);
      requestNotifPermission();
      onChange();
      updateFavBtn(lat, lon, label, onChange);
    };
  }
}

// ── In-page Notification API (funguje jen s otevřenou kartou) ───────────────
function notifAllowed() {
  return "Notification" in window && Notification.permission === "granted";
}
async function requestNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
}

export function checkRainNotifications() {
  if (!state.GRID) return;
  const favs = loadFavs();
  if (!favs.length) return;

  const snooze = JSON.parse(localStorage.getItem(NOTIF_SNOOZE_KEY) || "{}");
  const now = Date.now();
  const WARN_COLORS = { YELLOW: "🟡", ORANGE: "🟠", RED: "🔴", yellow: "🟡", orange: "🟠", red: "🔴" };

  if (state.GRID.warnings && state.GRID.wmatch) {
    for (const f of favs) {
      const { id } = _nearestPtLocal(f.lat, f.lon);
      if (id == null) continue; // zahraniční oblíbené místo — český grid neplatí
      const matchIdx = new Set(state.GRID.wmatch[String(id)] || []);
      const activeWarns = state.GRID.warnings.filter((w, wi) => matchIdx.has(wi) && WARN_COLORS[w.color]);
      for (const w of activeWarns) {
        const snoozeKey = `warn_${f.label}_${w.event}`;
        if (snooze[snoozeKey] && now - snooze[snoozeKey] < 60 * 60 * 1000) continue;
        const icon = WARN_COLORS[w.color];
        const msg = `${icon} ${w.event} u ${f.label} — platí do ${localHM(w.expires_utc)}`;
        if (notifAllowed()) new Notification("⚠️ Výstraha ČHMÚ", { body: msg, icon: "icon.svg", tag: snoozeKey });
        showToast(msg, { kind: "warn", timeoutMs: 8000 });
        logNotif(msg);
        snooze[snoozeKey] = now;
        localStorage.setItem(NOTIF_SNOOZE_KEY, JSON.stringify(snooze));
        return;
      }
    }
  }

  const rainThresh = getSettings().rainThresh;
  for (const f of favs) {
    const snoozeKey = `rain_${f.label}`;
    if (snooze[snoozeKey] && now - snooze[snoozeKey] < 20 * 60 * 1000) continue;
    const { id } = _nearestPtLocal(f.lat, f.lon);
    if (id == null) continue; // zahraniční oblíbené místo řeší server (worker push)
    // jednotné vyhodnocení včetně OKOLÍ bodu — bouřka 3 km vedle oblíbeného
    // místa dřív propadla sítem, protože přesně ten jeden pixel byl suchý
    const as = assessRain(id, null);
    if (!as || (as.status !== "raining" && as.status !== "soon")) continue;
    if ((as.peak ?? 0) < rainThresh) continue; // pod uživatelským prahem z Nastavení

    let msg;
    if (as.status === "raining") {
      msg = `Právě prší u ${f.label}${as.nearKm > 5 ? ` (jádro ~${as.nearKm} km)` : ""}${as.peak != null ? ` — ${as.peak} mm/h` : ""}`;
    } else {
      const mins = Math.round((as.startMs - now) / 60000);
      if (mins > 60) continue;
      const intenz = precipDescr(as.peak).fut.toLowerCase();
      msg = `Za ${mins} min — ${intenz} (${as.peak} mm/h) u ${f.label}`;
    }
    if (notifAllowed()) new Notification("🌧️ Meteo Nowcast", { body: msg, icon: "icon.svg", tag: snoozeKey });
    showToast(`🌧️ ${msg}`, { timeoutMs: 8000 });
    logNotif(`🌧️ ${msg}`);
    snooze[snoozeKey] = now;
    localStorage.setItem(NOTIF_SNOOZE_KEY, JSON.stringify(snooze));
    return;
  }
}

function _nearestPtLocal(lat, lon) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < state.GRID.pts.length; i++) {
    const dLat = state.GRID.pts[i][0] - lat, dLon = state.GRID.pts[i][1] - lon;
    const d = dLat * dLat + dLon * dLon;
    if (d < bd) { bd = d; best = i; }
  }
  // ~0.25° ≈ 25 km — dál je místo mimo pokrytí českého gridu → id null,
  // jinak by zahraniční oblíbené místo „zdědilo" data bodu na hranici ČR
  if (bd > 0.25 * 0.25) return { id: null };
  return { id: best };
}

export function clearRainSnooze() {
  const snooze = JSON.parse(localStorage.getItem(NOTIF_SNOOZE_KEY) || "{}");
  Object.keys(snooze).filter(k => k.startsWith("rain_")).forEach(k => delete snooze[k]);
  localStorage.setItem(NOTIF_SNOOZE_KEY, JSON.stringify(snooze));
}

// ── Web Push (funguje i se zavřenou kartou — přes Cloudflare Worker) ────────

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// Běží appka jako nainstalovaná PWA? Na iOS je to TVRDÁ podmínka Web Pushe:
// v Safari na kartě push nefunguje vůbec, ať uživatel klikne na co chce.
function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || window.navigator.standalone === true;
}

function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Proč upozornění (ne)chodí. Vrací { ok, code, msg, hint }.
 *
 * Vzniklo z konkrétní stížnosti: "notifky chodí při spuštění aplikace, jinak
 * ne". To je přesně podpis stavu, kdy funguje jen in-page Notification API
 * (běží, dokud je appka otevřená) a Web Push aktivní není. Rozdíl mezi těmi
 * dvěma věcmi ale nebyl nikde vidět, takže se to nedalo diagnostikovat.
 */
export async function pushDiagnosis() {
  if (!pushSupported()) {
    return { ok: false, code: "unsupported",
      msg: "Tenhle prohlížeč Web Push neumí.",
      hint: "Upozornění budou chodit jen s otevřenou appkou." };
  }
  if (isIOS() && !isStandalone()) {
    return { ok: false, code: "ios-not-installed",
      msg: "Na iPhonu je potřeba appku nainstalovat na plochu.",
      hint: "Sdílet → Přidat na plochu, pak upozornění zapnout znovu. " +
            "V Safari na kartě iOS push nedoručuje." };
  }
  if (Notification.permission === "denied") {
    return { ok: false, code: "denied",
      msg: "Upozornění máš v prohlížeči zakázaná.",
      hint: "Povol je v nastavení webu a zkus to znovu." };
  }
  if (!loadFavs().length) {
    return { ok: false, code: "no-favs",
      msg: "Nemáš uložené žádné oblíbené místo.",
      hint: "Push hlídá právě oblíbená místa — ulož si aspoň jedno (☆)." };
  }

  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) {
    return { ok: false, code: "not-subscribed",
      msg: "Upozornění na pozadí nejsou zapnutá.",
      hint: "Zapni je tlačítkem 🔕 — bez toho chodí jen s otevřenou appkou." };
  }

  // Poslední a nejzrádnější případ: prohlížeč subscription má, ale server o ní
  // neví (vypršela, KV ji zahodilo, subscribe kdysi selhal). Zvenku vypadá
  // všechno zapnuté a přitom nikdy nic nepřijde.
  try {
    const r = await fetch(`${WORKER_BASE}/push-status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (r.ok) {
      const st = await r.json();
      if (!st.registered) {
        return { ok: false, code: "server-missing",
          msg: "Server o tvém zařízení neví — registrace vypršela.",
          hint: "Vypni a znovu zapni upozornění, tím se obnoví." };
      }
      // Výsledek zkušebního pushe je nejsilnější důkaz — buď dorazil, nebo ne.
      const t = st.test || {};
      let hint = "";
      if (t.pendingDueAt) {
        hint = "Zkušební upozornění je naplánované — zavři appku a počkej.";
      } else if (t.status === 201) {
        hint = `Zkušební upozornění odesláno ${t.waitedSec}s po zadání a push `
             + `služba ho přijala. Pokud nedorazilo, blokuje ho systém zařízení.`;
      } else if (t.status === 410) {
        hint = "Zkušební upozornění skončilo na 410 — registrace vypršela, "
             + "vypni a zapni upozornění.";
      } else if (t.status && t.status !== 201) {
        hint = `Zkušební upozornění skončilo s kódem ${t.status}.`;
      } else if (st.lastNotified) {
        hint = `Poslední odeslané: ${st.lastNotified}`;
      }
      return { ok: true, code: "ok",
        msg: `Upozornění na pozadí jsou aktivní pro ${st.favorites} ` +
             `${st.favorites === 1 ? "místo" : st.favorites < 5 ? "místa" : "míst"}.`,
        hint };
    }
  } catch { /* server nedostupný — nižší jistota, ale ne chyba uživatele */ }

  return { ok: true, code: "ok-unverified",
    msg: "Upozornění na pozadí jsou zapnutá.",
    hint: "Stav na serveru se teď nepodařilo ověřit." };
}

/**
 * Naplánuje zkušební push za minutu.
 *
 * Odklad je celý smysl téhle funkce: notifikace v otevřené appce jedou přes
 * in-page Notification API a chodí i tehdy, když je Web Push rozbitý. Dokázat
 * se dá jen doručení, které dorazí se ZAVŘENOU appkou — proto minuta a proto
 * hláška, ať uživatel appku zavře.
 */
export async function scheduleTestPush() {
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (!sub) {
    showToast("Nejdřív zapni upozornění tlačítkem 🔕.");
    return null;
  }
  try {
    const r = await fetch(`${WORKER_BASE}/test-push`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint, delaySec: 60 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    showToast("Zkušební upozornění dorazí do minuty — teď appku zavři.",
      { timeoutMs: 9000 });
    // Za 75 s se podíváme, jak to dopadlo — i když uživatel notifikaci minul.
    setTimeout(() => renderPushDiagnosis(), 75000);
    return j;
  } catch (e) {
    showToast("Zkušební upozornění se nepodařilo naplánovat: " + e.message);
    return null;
  }
}

export function initTestPushButton() {
  const btn = document.getElementById("btn-test-push");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Plánuji…";
    await scheduleTestPush();
    btn.textContent = "Zkušební upozornění za minutu";
    setTimeout(() => { btn.disabled = false; }, 60000);
  });
}

export async function renderPushDiagnosis() {
  const el = document.getElementById("push-status");
  if (!el) return;
  let d;
  try { d = await pushDiagnosis(); }
  catch { el.classList.remove("show"); return; }
  el.innerHTML = `<b>${d.ok ? "✓" : "!"}</b> ${esc(d.msg)}` +
    (d.hint ? ` <span class="muted">${esc(d.hint)}</span>` : "");
  el.classList.toggle("push-bad", !d.ok);
  el.classList.add("show");
}

export async function initPushButton() {
  const btn = document.getElementById("btn-push");
  if (!btn || !pushSupported()) return;
  btn.classList.add("available");

  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) return;
  const existing = await reg.pushManager.getSubscription().catch(() => null);
  state.pushSubscribed = !!existing;
  _renderPushBtn(btn);

  btn.addEventListener("click", async () => {
    if (state.pushSubscribed) {
      await unsubscribePush(reg);
    } else {
      if (!loadFavs().length) {
        showToast("Nejdřív si ulož aspoň jedno oblíbené místo (☆ Uložit).");
        return;
      }
      await subscribePush(reg);
    }
    _renderPushBtn(btn);
    renderPushDiagnosis();
  });

  // Pokud už je subscribed, obnov TTL + aktuální oblíbená místa na serveru.
  if (existing) maybeResubscribePush();
  renderPushDiagnosis();
}

function _renderPushBtn(btn) {
  btn.textContent = state.pushSubscribed ? "🔔 Upozornění zapnutá" : "🔕 Zapnout upozornění";
  btn.classList.toggle("on", state.pushSubscribed);
}

async function subscribePush(reg) {
  try {
    const keyRes = await fetch(`${WORKER_BASE}/vapid-public-key`);
    const { publicKey } = await keyRes.json();
    if (!publicKey) { showToast("Server upozornění není teď dostupný."); return; }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const favorites = loadFavs();
    const r = await fetch(`${WORKER_BASE}/subscribe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), favorites }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.pushSubscribed = true;
    showToast("Upozornění zapnutá pro oblíbená místa.");
  } catch (e) {
    showToast("Upozornění se nepodařilo zapnout: " + e.message);
  }
}

async function unsubscribePush(reg) {
  try {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(`${WORKER_BASE}/unsubscribe`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    state.pushSubscribed = false;
    showToast("Upozornění vypnutá.");
  } catch (e) {
    showToast("Nepodařilo se vypnout upozornění: " + e.message);
  }
}

async function maybeResubscribePush() {
  if (!state.pushSubscribed || !pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const favorites = loadFavs();
    if (!favorites.length) return;
    await fetch(`${WORKER_BASE}/subscribe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), favorites }),
    });
  } catch { /* tichý best-effort refresh */ }
}
