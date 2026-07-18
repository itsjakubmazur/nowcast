// Pozorování hvězd — astronomické výpočty čistě v prohlížeči (bez API).
// Nízkoprecizní efemeridy dle P. Schlytera (stjarnhimlen.se) — přesnost
// ~1–2′ pro Slunce, ~2° pro Měsíc a planety; pro "kdy a co pozorovat"
// bohatě stačí. Časy počítáme vzorkováním výšky nad obzorem po 5 minutách.

import { state } from "./state.js";

const RAD = Math.PI / 180;
const sin = x => Math.sin(x * RAD), cos = x => Math.cos(x * RAD);
const asinD = x => Math.asin(x) / RAD, atan2D = (y, x) => Math.atan2(y, x) / RAD;
const norm360 = x => ((x % 360) + 360) % 360;

// dny od epochy 2000-01-00 00:00 UT (Schlyterova konvence: d(2000-01-01 0h)=1)
function dayNumber(date) {
  return date.getTime() / 86400000 - 10956.0;
}

// ── Slunce: ekliptikální → ekvatoreální souřadnice ──────────────────────────
function sunPos(d) {
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = norm360(356.0470 + 0.9856002585 * d);
  const E = M + e * (180 / Math.PI) * sin(M) * (1 + e * cos(M));
  const xv = cos(E) - e;
  const yv = sin(E) * Math.sqrt(1 - e * e);
  const v = atan2D(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  const lon = norm360(v + w);
  return { lon, r, L: norm360(w + M) }; // L = střední délka pro hvězdný čas
}

function eclToEq(xecl, yecl, zecl, d) {
  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = xecl;
  const ye = yecl * cos(ecl) - zecl * sin(ecl);
  const ze = yecl * sin(ecl) + zecl * cos(ecl);
  const ra = norm360(atan2D(ye, xe));
  const dec = atan2D(ze, Math.sqrt(xe * xe + ye * ye));
  return { ra, dec };
}

// výška tělesa (ra, dec) nad obzorem v čase date na lat/lon
function altitude(ra, dec, date, lat, lon, sunL) {
  const d = dayNumber(date);
  const utHours = (d - Math.floor(d)) * 24; // UT hodin od půlnoci (d je celé o půlnoci UT)
  const gmst0 = norm360(sunL + 180);
  const lst = norm360(gmst0 + utHours * 15 + lon);
  const ha = norm360(lst - ra);
  return asinD(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha));
}

export function sunAltitude(date, lat, lon) {
  const d = dayNumber(date);
  const s = sunPos(d);
  const { ra, dec } = eclToEq(cos(s.lon) * s.r, sin(s.lon) * s.r, 0, d);
  return altitude(ra, dec, date, lat, lon, s.L);
}

// ── Měsíc — hlavní poruchové členy ──────────────────────────────────────────
function moonPos(d) {
  const N = norm360(125.1228 - 0.0529538083 * d);
  const i = 5.1454;
  const w = norm360(318.0634 + 0.1643573223 * d);
  const a = 60.2666; // poloměry Země
  const e = 0.054900;
  const M = norm360(115.3654 + 13.0649929509 * d);

  let E = M + e * (180 / Math.PI) * sin(M) * (1 + e * cos(M));
  for (let k = 0; k < 4; k++) {
    E = E - (E - e * (180 / Math.PI) * sin(E) - M) / (1 - e * cos(E));
  }
  const xv = a * (cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * sin(E);
  const v = atan2D(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);

  const xh = r * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(i));
  const yh = r * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(i));
  const zh = r * (sin(v + w) * sin(i));

  let lonm = norm360(atan2D(yh, xh));
  let latm = atan2D(zh, Math.sqrt(xh * xh + yh * yh));

  // poruchy (nejvýznamnější členy)
  const s = sunPos(d);
  const Ms = norm360(356.0470 + 0.9856002585 * d);
  const Ls = s.L;
  const Lm = norm360(N + w + M);
  const D = norm360(Lm - Ls);   // střední elongace
  const F = norm360(Lm - N);
  lonm += -1.274 * sin(M - 2 * D) + 0.658 * sin(2 * D) - 0.186 * sin(Ms)
        - 0.059 * sin(2 * M - 2 * D) - 0.057 * sin(M - 2 * D + Ms)
        + 0.053 * sin(M + 2 * D) + 0.046 * sin(2 * D - Ms);
  latm += -0.173 * sin(F - 2 * D) - 0.055 * sin(M - F - 2 * D)
        - 0.046 * sin(M + F - 2 * D) + 0.033 * sin(F + 2 * D);

  return { lon: norm360(lonm), lat: latm, r, sunL: s.L, elong: norm360(Lm - s.lon) };
}

export function moonAltitude(date, lat, lon) {
  const d = dayNumber(date);
  const m = moonPos(d);
  const xe = m.r * cos(m.lon) * cos(m.lat);
  const ye = m.r * sin(m.lon) * cos(m.lat);
  const ze = m.r * sin(m.lat);
  const { ra, dec } = eclToEq(xe, ye, ze, d);
  const alt = altitude(ra, dec, date, lat, lon, m.sunL);
  // topocentrická korekce (paralaxa ~1°) — Měsíc je blízko
  return alt - asinD(cos(alt * RAD) / m.r);
}

// ── Planety (Merkur–Saturn) ─────────────────────────────────────────────────
const PLANETS = {
  Venuše:  { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5],
             a: 0.723330, e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
  Mars:    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5],
             a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
  Jupiter: { N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5],
             a: 5.20256, e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
  Saturn:  { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5],
             a: 9.55475, e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
};

function planetEq(name, d) {
  const el = PLANETS[name];
  const N = norm360(el.N[0] + el.N[1] * d);
  const i = el.i[0] + el.i[1] * d;
  const w = norm360(el.w[0] + el.w[1] * d);
  const a = el.a;
  const e = el.e[0] + el.e[1] * d;
  const M = norm360(el.M[0] + el.M[1] * d);

  let E = M + e * (180 / Math.PI) * sin(M) * (1 + e * cos(M));
  for (let k = 0; k < 5; k++) {
    E = E - (E - e * (180 / Math.PI) * sin(E) - M) / (1 - e * cos(E));
  }
  const xv = a * (cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * sin(E);
  const v = atan2D(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);

  // heliocentrické ekliptikální
  const xh = r * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(i));
  const yh = r * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(i));
  const zh = r * (sin(v + w) * sin(i));

  // geocentrické: + poloha Slunce
  const s = sunPos(d);
  const xg = xh + s.r * cos(s.lon);
  const yg = yh + s.r * sin(s.lon);
  const zg = zh;
  const eq = eclToEq(xg, yg, zg, d);
  return { ...eq, sunL: s.L };
}

// ── Meteorické roje (hlavní, každoroční) ────────────────────────────────────
const SHOWERS = [
  { name: "Kvadrantidy", from: [12, 28], to: [1, 12], peak: [1, 3], zhr: 120 },
  { name: "Lyridy", from: [4, 14], to: [4, 30], peak: [4, 22], zhr: 18 },
  { name: "Eta Akvaridy", from: [4, 19], to: [5, 28], peak: [5, 6], zhr: 50 },
  { name: "Delta Akvaridy", from: [7, 12], to: [8, 23], peak: [7, 30], zhr: 25 },
  { name: "Perseidy", from: [7, 17], to: [8, 24], peak: [8, 12], zhr: 100 },
  { name: "Orionidy", from: [10, 2], to: [11, 7], peak: [10, 21], zhr: 20 },
  { name: "Leonidy", from: [11, 6], to: [11, 30], peak: [11, 17], zhr: 15 },
  { name: "Geminidy", from: [12, 4], to: [12, 20], peak: [12, 13], zhr: 150 },
  { name: "Ursidy", from: [12, 17], to: [12, 26], peak: [12, 22], zhr: 10 },
];

function mdNum(m, d) { return m * 100 + d; }

function activeShowers(date) {
  const today = mdNum(date.getMonth() + 1, date.getDate());
  return SHOWERS.filter(s => {
    const f = mdNum(...s.from), t = mdNum(...s.to);
    return f <= t ? (today >= f && today <= t) : (today >= f || today <= t);
  }).map(s => {
    const peak = mdNum(...s.peak);
    return { ...s, isPeak: Math.abs(peak - today) <= 1 };
  }).sort((a, b) => (b.isPeak - a.isPeak) || (b.zhr - a.zhr));
}

// ── Vzorkování nočních událostí ─────────────────────────────────────────────
const STEP_MIN = 5;

function fmtHM(date) {
  return date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", timeZone: state.tz });
}

// Projde noc (od 12:00 dnes do 12:00 zítra UTC-ish) a najde přechody.
export function computeNight(lat, lon, now = new Date()) {
  // začátek "dnešní noci": dnes poledne místního času
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  if (now.getHours() < 12) start.setDate(start.getDate() - 1);

  const n = (24 * 60) / STEP_MIN;
  let darkStart = null, darkEnd = null;         // slunce < -18°
  let duskAstro = null, dawnAstro = null;
  let moonRise = null, moonSet = null;
  let prevSunAlt = null, prevMoonAlt = null;
  const moonUp = [];                            // intervaly Měsíce nad obzorem

  let curMoonUpFrom = null;
  for (let k = 0; k <= n; k++) {
    const t = new Date(start.getTime() + k * STEP_MIN * 60000);
    const sAlt = sunAltitude(t, lat, lon);
    const mAlt = moonAltitude(t, lat, lon);

    if (prevSunAlt != null) {
      if (prevSunAlt >= -18 && sAlt < -18 && !duskAstro) duskAstro = t;
      if (prevSunAlt < -18 && sAlt >= -18 && duskAstro && !dawnAstro) dawnAstro = t;
    }
    if (prevMoonAlt != null) {
      if (prevMoonAlt < 0 && mAlt >= 0 && !moonRise) moonRise = t;
      if (prevMoonAlt >= 0 && mAlt < 0 && !moonSet) moonSet = t;
    }
    if (mAlt >= 0 && curMoonUpFrom == null) curMoonUpFrom = t;
    if ((mAlt < 0 || k === n) && curMoonUpFrom != null) {
      moonUp.push([curMoonUpFrom, t]);
      curMoonUpFrom = null;
    }
    prevSunAlt = sAlt;
    prevMoonAlt = mAlt;
  }

  // tmavé okno = astronomická noc minus Měsíc nad obzorem
  if (duskAstro && dawnAstro) {
    let ds = duskAstro.getTime(), de = dawnAstro.getTime();
    // ořízni intervaly Měsíce
    const cut = [];
    let segs = [[ds, de]];
    for (const [mf, mt] of moonUp) {
      const next = [];
      for (const [a, b] of segs) {
        const f = Math.max(a, mf.getTime()), t2 = Math.min(b, mt.getTime());
        if (f >= t2) { next.push([a, b]); continue; }
        if (a < f) next.push([a, f]);
        if (t2 < b) next.push([t2, b]);
      }
      segs = next;
    }
    // nejdelší souvislý úsek bez Měsíce
    segs.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
    if (segs.length && segs[0][1] - segs[0][0] >= 20 * 60000) {
      darkStart = new Date(segs[0][0]);
      darkEnd = new Date(segs[0][1]);
    }
  }

  // planety: výška uprostřed astronomické noci (nebo v 1:00)
  const mid = duskAstro && dawnAstro
    ? new Date((duskAstro.getTime() + dawnAstro.getTime()) / 2)
    : new Date(start.getTime() + 13 * 3600000);
  const planets = [];
  for (const name of Object.keys(PLANETS)) {
    const d = dayNumber(mid);
    const p = planetEq(name, d);
    const alt = altitude(p.ra, p.dec, mid, lat, lon, p.sunL);
    const altDusk = duskAstro ? (() => {
      const dd = dayNumber(duskAstro); const pp = planetEq(name, dd);
      return altitude(pp.ra, pp.dec, duskAstro, lat, lon, pp.sunL);
    })() : alt;
    const altDawn = dawnAstro ? (() => {
      const dd = dayNumber(dawnAstro); const pp = planetEq(name, dd);
      return altitude(pp.ra, pp.dec, dawnAstro, lat, lon, pp.sunL);
    })() : alt;
    let when = null;
    if (alt > 10) when = "celou noc";
    else if (altDusk > 10) when = "večer";
    else if (altDawn > 10) when = "ráno";
    if (when) planets.push({ name, when, alt: Math.round(Math.max(alt, altDusk, altDawn)) });
  }

  return {
    duskAstro, dawnAstro, darkStart, darkEnd, moonRise, moonSet,
    planets, showers: activeShowers(now),
    fmt: fmtHM,
  };
}
