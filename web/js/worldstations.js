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

export async function loadMetarTile(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const id = metarTileId(lat, lon);
  if (cache.has(id)) return cache.get(id);
  if (inflight.has(id)) return inflight.get(id);

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

// Nasype dlaždici pro dané místo do state, odkud si ji vezme
// nearestFreshStation() stejně jako ČHMÚ/WU/METAR doma.
export async function ensureWorldStations(lat, lon) {
  const st = await loadMetarTile(lat, lon);
  state.METAR_WORLD = { stations: st, tile: metarTileId(lat, lon) };
  return st;
}
