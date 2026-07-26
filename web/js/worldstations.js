// Celosvětové letištní stanice (METAR) po dlaždicích 10°.
//
// Domovská ČR má vlastní soubor metar_stations.json, který se načítá hned se
// zbytkem dat — je malý a chceme ho mít na první vykreslení. Pro zbytek světa
// by ale jeden soubor s ~5000 stanicemi byl zbytečná zátěž, takže
// pipeline/metar.py je krájí na dlaždice 10° s přesahem 1,5°.
//
// Ten přesah je podstatný: hledání nejbližší stanice sahá do 40 km, takže bod
// těsně u hranice dlaždice musí vidět i letiště hned za ní. Díky přesahu stačí
// stáhnout JEDNU dlaždici a nemusíme řešit 3×3 okolí.

import { state } from "./state.js";

const cache = new Map();      // "ty_tx" → pole stanic (i prázdné, ať se nezkouší znovu)
const inflight = new Map();   // "ty_tx" → Promise, ať dvojklik nestahuje dvakrát

export function metarTileId(lat, lon) {
  const tx = Math.floor((((lon + 180) % 360) + 360) % 360 / 10) % 36;
  const ty = Math.min(17, Math.max(0, Math.floor((lat + 90) / 10)));
  return `${ty}_${tx}`;
}

// Dlaždice protínající obdélník mapy. Používá to teplotní vrstva, která na
// rozdíl od "nejbližší stanice" nepotřebuje jeden bod, ale celý výřez.
export function tilesForBounds(south, west, north, east) {
  const out = new Set();
  // Přes datovou hranici se výřez rozpadne na dva kusy — jinak by smyčka
  // od west k east obletěla svět z opačné strany a nahrnula 36 dlaždic.
  const spans = west <= east ? [[west, east]] : [[west, 180], [-180, east]];
  for (const [w, e] of spans) {
    for (let lat = Math.floor(south / 10) * 10; lat <= north; lat += 10) {
      for (let lon = Math.floor(w / 10) * 10; lon <= e; lon += 10) {
        out.add(metarTileId(Math.min(89.9, Math.max(-89.9, lat + 0.01)), lon + 0.01));
      }
    }
  }
  return [...out];
}

// Rejstřík existujících dlaždic. Bez něj bychom nad oceánem stahovali
// neexistující soubory — appka si s 404 poradí, ale prohlížeč každý takový
// požadavek vypíše do konzole a při posouvání mapy je jich spousta.
// Rejstřík má ~313 položek, takže je levnější než jediná zbytečná 404.
let _indexPromise = null;
let _tileSet = null;

export function loadTileIndex() {
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    try {
      const v = state.MANIFEST?.generated_at_utc;
      const r = await fetch(`data/metar/index.json${v ? `?v=${encodeURIComponent(v)}` : ""}`);
      if (!r.ok) return null;
      const j = await r.json();
      const ids = (j?.tiles || []).map(t => t.tile).filter(Boolean);
      _tileSet = new Set(ids);
      return _tileSet;
    } catch {
      return null;   // bez rejstříku jedeme dál, jen s možnými 404
    }
  })();
  return _indexPromise;
}

export async function loadTile(id) {
  if (cache.has(id)) return cache.get(id);
  if (inflight.has(id)) return inflight.get(id);
  await loadTileIndex();
  // null = rejstřík se nenačetl; pak radši zkusíme stáhnout, než abychom
  // kvůli chybějícímu pomocnému souboru přišli o data.
  if (_tileSet && !_tileSet.has(id)) { cache.set(id, []); return []; }
  return fetchTile(id);
}

function fetchTile(id) {
  const p = (async () => {
    try {
      // Verzujeme podle běhu pipeline, stejně jako ostatní datové soubory —
      // jinak by HTTP cache Pages mohla chvíli vracet starou dlaždici.
      const v = state.MANIFEST?.generated_at_utc;
      const r = await fetch(`data/metar/${id}.json${v ? `?v=${encodeURIComponent(v)}` : ""}`);
      // 404 je běžný a legitimní stav — nad oceánem prostě žádná dlaždice není.
      if (!r.ok) { cache.set(id, []); return []; }
      const j = await r.json();
      const st = Array.isArray(j?.stations) ? j.stations : [];
      cache.set(id, st);
      return st;
    } catch (e) {
      console.warn("Světové stanice:", e);
      cache.set(id, []);   // neopakuj při každém kliknutí
      return [];
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

export async function loadMetarTile(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return loadTile(metarTileId(lat, lon));
}

// Nasype dlaždici pro dané místo do state, odkud si ji vezme
// nearestFreshStation() stejně jako ČHMÚ/WU/METAR doma.
export async function ensureWorldStations(lat, lon) {
  const st = await loadMetarTile(lat, lon);
  state.METAR_WORLD = { stations: st, tile: metarTileId(lat, lon) };
  return st;
}
