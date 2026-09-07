// Polární záře — z planetárního Kp indexu na odpověď „uvidím ji odsud?".
//
// Kp je jedno číslo pro celou planetu (stahuje ho pipeline/aurora.py z NOAA
// SWPC). Samo o sobě neříká nic o tom, jestli má smysl jít ven — to závisí na
// geomagnetické šířce místa, a ta se od té zeměpisné liší o víc než stupeň.
// Převod je proto tady, na straně místa, ne v pipeline.
//
// ── ŘETĚZEC VÝPOČTU ────────────────────────────────────────────────────────
// 1. geomagnetická šířka místa (dipólová aproximace kolem osy geomagnetického
//    pólu),
// 2. z Kp rovnice ovalu: jak daleko na jih sahá jeho jižní okraj,
// 3. rozdíl mezi ovalem a místem → viditelnost (okem / fotoaparátem / vůbec),
// 4. průnik s NOCÍ, OBLAČNOSTÍ a MĚSÍCEM — jinak je celý výpočet akademický.
//
// Bod 4 je záměrný rozdíl proti tomu, co dělají jiné kalkulačky záře: ty
// spočítají oval a skončí, takže slíbí záři pod souvislou oblačností. Data
// o oblačnosti i o Měsíci už appka má (Open-Meteo `cloud_cover` a výpočty ve
// stargaze.js), takže je nespojit by bylo plýtvání — a slib, který nemůže
// platit. Princip „nejistota se přiznává" platí i obráceně: když je zataženo,
// řekne se to rovnou, ne až v poznámce pod čarou.

import { state } from "./state.js";
import { esc, revealSwap } from "./utils.js";
import { uiIcon } from "./uiicons.js";
import { computeNight } from "./stargaze.js";

// ── Geomagnetický pól ───────────────────────────────────────────────────────
// Severní GEOMAGNETICKÝ pól dipólu (ne magnetický pól, kam ukazuje kompas —
// ten je jinde a stěhuje se řádově rychleji). Hodnota pro epochu ~2025 podle
// IGRF; posouvá se zhruba o 0,05° za rok, takže na desetinu stupně vydrží
// roky a na výsledný verdikt (celé stupně) prakticky napořád.
const POLE_LAT = 80.7;
const POLE_LON = -72.7;

const RAD = Math.PI / 180;

/**
 * Geomagnetická šířka místa (dipólová aproximace).
 *
 * sin(φm) = sin(φ)·sin(φp) + cos(φ)·cos(φp)·cos(λ − λp)
 *
 * Je to sférická vzdálenost od pólu, jen vyjádřená jako šířka. Pro střední
 * Evropu vychází o ~1° NÍŽ než zeměpisná (Brno 49,19° → 48,4° geomag.), což
 * je přesně ten rozdíl, kvůli kterému se nedá počítat ze zeměpisné šířky.
 */
export function geomagLat(lat, lon) {
  const s = Math.sin(lat * RAD) * Math.sin(POLE_LAT * RAD)
    + Math.cos(lat * RAD) * Math.cos(POLE_LAT * RAD) * Math.cos((lon - POLE_LON) * RAD);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

// ── Oval ───────────────────────────────────────────────────────────────────
// Jižní okraj polárního ovalu v geomagnetické šířce podle Kp. Tabulka NOAA
// (Kp 0 → 66,5°, každý stupeň Kp posune oval o ~2,05° na jih) je v tomhle
// rozsahu prakticky lineární, takže se počítá vzorcem, ne interpolací.
const OVAL_KP0 = 66.5;
const OVAL_PER_KP = 2.05;

/** Jižní okraj ovalu pro dané Kp, v geomagnetické šířce. */
export function ovalEdge(kp) {
  return OVAL_KP0 - OVAL_PER_KP * kp;
}

// Jak daleko JIŽNĚ od okraje ovalu je jev ještě vidět. Záře svítí ve výšce
// zhruba 100–400 km, takže ji z dálky vidíš nízko nad severním obzorem —
// proto se dá pozorovat i stovky kilometrů pod ovalem samotným.
//
// Kalibrace na skutečné události v ČR (Brno, geomag. 48,4°):
//   Kp 9 → okraj 48,1° → schodek −0,3° → okem, vysoko    (10. 5. 2024 seděl)
//   Kp 8 → okraj 50,1° → schodek  1,7° → okem nad obzorem (10. 10. 2024)
//   Kp 7 → okraj 52,2° → schodek  3,8° → fotoaparát
//   Kp 5 → okraj 56,3° → schodek  7,9° → nic
const EYE_MARGIN = 2;    // do 2° pod okrajem — reálná šance pouhým okem
const CAM_MARGIN = 6;    // do 6° pod okrajem — na fotce ano, okem ne

/**
 * Viditelnost pro dané Kp a geomagnetickou šířku.
 * Vrací { level, label, detail } — level je 0 (nic) až 3 (vysoko na obloze).
 */
export function visibility(kp, mlat) {
  const deficit = ovalEdge(kp) - mlat;      // o kolik stupňů je oval severněji
  if (deficit <= 0) return { level: 3, label: "okem, vysoko na obloze", short: "okem" };
  if (deficit <= EYE_MARGIN) return { level: 2, label: "okem nad severním obzorem", short: "okem" };
  if (deficit <= CAM_MARGIN) return { level: 1, label: "jen fotoaparátem", short: "foto" };
  return { level: 0, label: "odsud vidět nebude", short: "ne" };
}

/** Nejnižší Kp, při kterém by na daném místě vyšla daná úroveň. */
function kpNeeded(mlat, margin) {
  const kp = (OVAL_KP0 - mlat - margin) / OVAL_PER_KP;
  return Math.max(0, Math.min(9, kp));
}

// ── Vykreslení ─────────────────────────────────────────────────────────────

// Dvě škály, protože dvě různé věci.
//
// BAR_ROLE je SÍLA BOUŘE: sloupce jsou plochy, takže smí použít --yellow,
// který je na text ve světlém motivu příliš světlý (a hlídka kontrastu ve
// smoke testu ho správně odmítne).
//
// TEXT_ROLE je ODPOVĚĎ: „uvidíš" je dobrá zpráva, tedy zelená, i když je za
// ní Kp 8 a červený sloupec. Barvit verdikt podle síly bouře by znamenalo
// napsat „šance pouhým okem" červeně, což se čte jako varování.
const BAR_ROLE = ["muted", "yellow", "orange", "red"];
const TEXT_ROLE = ["muted", "orange-text", "green-text", "green-text"];

function fmtKp(kp) {
  // Kp má krok po třetinách. Desetinná čárka je česky správně a jedno
  // desetinné místo je přesně rozlišení zdroje — víc by předstíralo přesnost.
  return kp.toFixed(1).replace(".", ",");
}

function hm(dt) {
  return dt
    ? dt.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: state.tz })
    : null;
}

/**
 * Sloupcový graf Kp řady.
 *
 * Není to Chart.js: je to čtyřicet obdélníků bez os a bez interakce, na což
 * je plátno i knihovna zbytečná váha. Stejný důvod, proč je `.nstrip`
 * v astro panelu taky jen řada <i>.
 *
 * Prahy MÍSTA jsou vodorovné linky přes graf — teprve ony dělají z abstraktní
 * řady odpověď: sloupec, který linku přeroste, je noc, kdy má smysl jít ven.
 */
function kpBars(series, mlat, nowIso) {
  if (!series.length) return "";
  const kpEye = kpNeeded(mlat, EYE_MARGIN);
  const kpCam = kpNeeded(mlat, CAM_MARGIN);

  const bars = series.map(p => {
    const vis = visibility(p.kp, mlat);
    const h = Math.max(4, Math.round((p.kp / 9) * 100));
    const future = p.t > nowIso;
    const den = new Date(p.t).toLocaleDateString("cs-CZ", {
      weekday: "short", day: "numeric", month: "numeric", timeZone: state.tz,
    });
    const cas = new Date(p.t).toLocaleTimeString("cs-CZ", {
      hour: "2-digit", minute: "2-digit", timeZone: state.tz,
    });
    return `<i class="kpb${future ? " fut" : ""}" style="height:${h}%;--kpc:var(--${BAR_ROLE[vis.level]})"
      title="${esc(den)} ${esc(cas)} · Kp ${esc(fmtKp(p.kp))} · ${esc(vis.label)}"></i>`;
  }).join("");

  // Poloha linky: 0 % je dole, 100 % nahoře (Kp 9). Popisky si sedají na
  // OPAČNÉ strany — prahy pro fotoaparát a pro oko dělí jen dva stupně Kp,
  // takže na 90px grafu leží pár pixelů od sebe a nad sebou by se překryly.
  const line = (kp, cls, popis) => (kp <= 9
    ? `<span class="kpline ${cls}" style="bottom:${((kp / 9) * 100).toFixed(1)}%"><b>${esc(popis)}</b></span>`
    : "");

  // Hranice mezi měřením a předpovědí. Musí se počítat z DAT, ne umísťovat
  // doprostřed: řada je nesouměrná (den dozadu, tři dopředu), takže „teď"
  // leží zhruba ve čtvrtině. Popisek uprostřed osy tvrdil, že polovina grafu
  // je minulost — a tím pádem že špička už proběhla.
  const iFut = series.findIndex(p => p.t > nowIso);
  const nowPct = iFut < 0 ? 100 : (iFut / series.length) * 100;
  const nowMark = iFut <= 0 ? "" : `<span class="kp-nowline" style="left:${nowPct.toFixed(1)}%"></span>`;

  const first = series[0], last = series[series.length - 1];
  const dm = t => new Date(t).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", timeZone: state.tz });
  const kps = series.map(p => p.kp);

  return `<div class="kp-chart">
    <div class="kp-plot" role="img"
      aria-label="Průběh indexu Kp od ${esc(dm(first.t))} do ${esc(dm(last.t))}, hodnoty ${esc(fmtKp(Math.min(...kps)))} až ${esc(fmtKp(Math.max(...kps)))} z devíti">
      ${line(kpCam, "cam", "fotoaparát")}
      ${line(kpEye, "eye", "okem")}
      ${bars}
      ${nowMark}
    </div>
    <div class="kp-axis">
      <span>${esc(dm(first.t))}</span>
      ${iFut > 0 ? `<span class="kp-now" style="left:${nowPct.toFixed(1)}%">teď</span>` : ""}
      <span>${esc(dm(last.t))}</span>
    </div>
  </div>`;
}

/**
 * Noční okno pro nejbližší noc: tma × oblačnost × Měsíc.
 *
 * Vrací null, když se noc nedá spočítat — pak se řádky prostě nevykreslí.
 * Předstírat "jasno", když o oblačnosti nic nevíme, by bylo horší než mlčet.
 */
function nightWindow(lat, lon, fc) {
  let sg = null;
  try {
    sg = computeNight(lat, lon);
  } catch (e) {
    console.warn("aurora/stargaze:", e);
    return null;
  }
  if (!sg) return null;

  // Záře se hodnotí přes astronomickou noc; v létě, kdy nenastává, se bere
  // aspoň úsek mezi soumrakem a svítáním, jinak by panel od května do srpna
  // mlčel — a přitom právě tehdy bývají nejsilnější bouře viditelné.
  const from = sg.duskAstro, to = sg.dawnAstro;

  // Oblačnost v hodinách noci. Bere se z hodinové předpovědi, kterou už
  // appka má — o vlastní request navíc tu nejde.
  let cloud = null, clearest = null;
  const hrs = fc?.hourlyFull || [];
  if (from && to && hrs.length) {
    const f = from.getTime(), t = to.getTime();
    const win = hrs.filter(h => {
      const ms = new Date(h.iso).getTime();
      return ms >= f - 3600000 && ms <= t + 3600000;
    });
    if (win.length) {
      cloud = Math.round(win.reduce((s, h) => s + (h.cloud ?? 50), 0) / win.length);
      clearest = win.reduce((b, h) => ((h.cloud ?? 100) < (b.cloud ?? 100) ? h : b));
    }
  }

  return { sg, from, to, cloud, clearest };
}

/**
 * Panel polární záře.
 *
 * @param {object|null} data  obsah data/aurora.json (null = panel se schová)
 * @param {object|null} fc    hodinová předpověď (kvůli oblačnosti)
 */
export function renderAurora(data, fc) {
  const panel = document.getElementById("aurora-panel");
  const body = document.getElementById("aurora-body");
  if (!panel || !body) return;

  const series = Array.isArray(data?.series) ? data.series : [];
  if (!series.length) { panel.classList.remove("show"); return; }

  const lat = state.currentLat, lon = state.currentLon;
  if (lat == null || lon == null) { panel.classList.remove("show"); return; }

  const mlat = geomagLat(lat, lon);
  const nowIso = new Date().toISOString().slice(0, 19) + "Z";

  const kpEye = kpNeeded(mlat, EYE_MARGIN);
  const kpCam = kpNeeded(mlat, CAM_MARGIN);

  const nowPt = data.now || null;
  const future = series.filter(p => p.t > nowIso);
  const peak = future.length ? future.reduce((a, b) => (b.kp > a.kp ? b : a)) : null;

  // Verdikt se řídí ŠPIČKOU dopředu, ne aktuální hodnotou: v poledne je
  // dnešní Kp k ničemu, zajímá nás nejbližší noc a dva dny za ní.
  const visPeak = peak ? visibility(peak.kp, mlat) : null;

  const night = nightWindow(lat, lon, fc);

  // ── Hlavní věta ──────────────────────────────────────────────────────────
  // Skládá se z faktů, které jsou o řádek níž rozepsané — žádné číslo se tu
  // neobjeví, aniž by bylo vidět, odkud je.
  let hlava, hlavaRole;
  if (!visPeak || visPeak.level === 0) {
    hlava = "Odsud vidět nebude";
    hlavaRole = "muted";
  } else {
    const kdy = peak ? new Date(peak.t).toLocaleDateString("cs-CZ", {
      weekday: "long", timeZone: state.tz,
    }) : "";
    hlava = visPeak.level >= 2
      ? `Šance pouhým okem — ${kdy}`
      : `Šance na fotoaparát — ${kdy}`;
    hlavaRole = TEXT_ROLE[visPeak.level];
  }

  // Oblačnost verdikt ředí, ale NEPŘEBIJE ho: „zataženo" je předpověď na
  // dnešní noc, kdežto špička Kp může být za dva dny, kdy o oblačnosti
  // nevíme nic. Proto je to samostatný řádek, ne škrtnutí hlavní věty.
  const brzda = (visPeak?.level > 0 && night?.cloud != null && night.cloud >= 80)
    ? `<div class="astro-row"><span class="a-k">Ale</span><span class="a-v" style="color:var(--orange-text)">na dnešní noc zataženo (${night.cloud} %)</span><span class="a-d">oval ≠ obloha</span></div>`
    : "";

  const radky = [];

  radky.push(`<div class="astro-row aur-head"><span class="a-k">Vyhlídka</span>
    <span class="a-v" style="color:var(--${hlavaRole})">${esc(hlava)}</span>
    ${peak ? `<span class="a-d">špička Kp ${esc(fmtKp(peak.kp))}</span>` : ""}</div>`);

  radky.push(brzda);

  radky.push(`<div class="astro-row"><span class="a-k">Kp teď</span>
    <span class="a-v">${nowPt ? esc(fmtKp(nowPt.kp)) : "—"}${nowPt ? ` <span style="font-weight:400;color:var(--muted)">z 9</span>` : ""}</span>
    <span class="a-d">${nowPt
      ? (nowPt.kind === "estimated" ? "dopočtené NOAA" : "měřené")
      : "NOAA zrovna publikuje jen předpověď"}</span></div>`);

  radky.push(`<div class="astro-row"><span class="a-k">Potřeba tady</span>
    <span class="a-v">Kp ${esc(fmtKp(kpCam))}+ <span style="font-weight:400;color:var(--muted)">foto</span> · Kp ${esc(fmtKp(kpEye))}+ <span style="font-weight:400;color:var(--muted)">okem</span></span>
    <span class="a-d">geomag. šířka ${mlat.toFixed(1).replace(".", ",")}°</span></div>`);

  radky.push(kpBars(series, mlat, nowIso));

  // ── Podmínky nejbližší noci ──────────────────────────────────────────────
  if (night && (night.from || night.cloud != null)) {
    radky.push(`<div class="astro-sub">${uiIcon("sparkle")}Dnešní noc na místě</div>`);

    if (night.from && night.to) {
      radky.push(`<div class="astro-row"><span class="a-k">Tma</span>
        <span class="a-v">${esc(hm(night.from))}–${esc(hm(night.to))}</span>
        <span class="a-d">slunce pod −18°</span></div>`);
    } else {
      radky.push(`<div class="astro-row"><span class="a-k">Tma</span>
        <span class="a-v" style="color:var(--muted)">nenastává</span>
        <span class="a-d">letní světlé noci</span></div>`);
    }

    if (night.cloud != null) {
      const role = night.cloud < 30 ? "green" : "orange";
      radky.push(`<div class="astro-row"><span class="a-k">Oblačnost</span>
        <span class="a-v" style="color:var(--${role}-text)">${night.cloud} %</span>
        <span class="a-d">${night.clearest && (night.clearest.cloud ?? 100) <= 40
          ? `nejjasněji ~${esc(night.clearest.t)}` : "průměr přes noc"}</span></div>`);
    }

    // Měsíc přebije slabou záři na obzoru dřív než tenkou oblačnost, takže
    // patří do stejného seznamu, ne do poznámky.
    if (night.sg?.moonRise || night.sg?.moonSet) {
      radky.push(`<div class="astro-row"><span class="a-k">Měsíc</span>
        <span class="a-v">${night.sg.moonRise ? `↑${esc(hm(night.sg.moonRise))}` : ""}${night.sg.moonSet ? ` ↓${esc(hm(night.sg.moonSet))}` : ""}</span>
        <span class="a-d">${night.sg.darkStart && night.sg.darkEnd
          ? `bez Měsíce ${esc(hm(night.sg.darkStart))}–${esc(hm(night.sg.darkEnd))}` : "svit ruší slabou záři"}</span></div>`);
    }
  }

  radky.push(`<div class="aur-note">Kp z NOAA SWPC, tříhodinový krok. Oval je
    dipólová aproximace — na desetiny stupně to není a mimořádné bouře sahají
    jižněji, než tabulka slibuje. Směr na sever a čistý obzor si musíš ohlídat sám.</div>`);

  revealSwap(body, radky.join(""));
  panel.classList.add("show");

  // Sekce „Dnes" má v navigaci puntík, když je v ní něco mimořádného.
  // Šance na záři nad ČR mimořádná je — je to pár nocí za sluneční cyklus.
  panel.dataset.alert = (visPeak && visPeak.level > 0) ? "1" : "";
}
