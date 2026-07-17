"""
Hydrologie — hlásné profily ČHMÚ (stavy a průtoky povrchových vod).

Dle dokumentace "Popis základních hydrologických dat now a recent":
  /hydrology/now/     — aktuální den, 10min interval, doplňováno 1× za hodinu
  /hydrology/recent/  — starší než 24 h
  metadata: DBC, STATION_NAME, STREAM_NAME, GEOGR1/2, H [cm], Q [m3/s], TH [°C]
            + prahy SPA (SPA1H..SPA4H / SPA1Q..SPA4Q dle SPA_TYP) a sucho (DRYH/DRYQ)

Přesná struktura adresářů/souborů v dokumentu není — skript si proto adresář
vylistuje sám (stejný přístup jako CAP výstrahy ve fuse.py), všechno diagnosticky
loguje a při nečekaném tvaru dat měkce skončí (pipeline jede dál bez hydrologie).

Výstup: data/hydro.json — [{id, name, stream, lat, lon, h_cm, q_m3s, t_utc,
                            spa, dry, trend_cm}]
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

import time as _time

# keep-alive: opendata server má vysokou latenci TLS handshaku — jedno
# recyklované spojení zrychlí stahování řádově
SESSION = requests.Session()

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/hydrology"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)", "Accept": "application/json,*/*"}
TIMEOUT = (5, 15)
MAX_STATIONS = 400   # pojistka proti tisícům souborů
BUDGET_S = 120       # tvrdý rozpočet — pipeline nesmí čekat na pomalý server
_T0 = _time.monotonic()


def over_budget():
    return _time.monotonic() - _T0 > BUDGET_S


def get(url):
    try:
        r = SESSION.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.ok:
            return r
        print(f"  HTTP {r.status_code}: {url}", file=sys.stderr)
    except Exception as e:
        print(f"  ERR {url}: {e}", file=sys.stderr)
    return None


def list_dir(url):
    """Vrátí hrefs z HTML dir-listingu (nebo [] když nedostupné)."""
    r = get(url)
    if not r:
        return []
    hrefs = re.findall(r'href="([^"?][^"]*)"', r.text)
    return [h for h in hrefs if not h.startswith("../")]


def find_json_files(root):
    """Rekurzivně (max 2 úrovně) najde .json soubory pod root; loguje strukturu."""
    out = []
    first = list_dir(root)
    print(f"  [diag] {root} → {len(first)} položek: {first[:12]}", file=sys.stderr)
    for h in first:
        if h.lower().endswith(".json"):
            out.append(root.rstrip("/") + "/" + h)
        elif h.endswith("/"):
            sub = root.rstrip("/") + "/" + h
            subitems = list_dir(sub)
            print(f"  [diag] {sub} → {len(subitems)} položek: {subitems[:8]}", file=sys.stderr)
            for h2 in subitems:
                if h2.lower().endswith(".json"):
                    out.append(sub.rstrip("/") + "/" + h2)
    return out


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _walk_values(obj):
    """Najde v JSONu první seznam řádků ('values' pivot, nebo prostý list dictů)."""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for key in ("values", "data", "records", "items"):
            if key in obj:
                found = _walk_values(obj[key])
                if found is not None:
                    return found
        for v in obj.values():
            if isinstance(v, (dict, list)):
                found = _walk_values(v)
                if found is not None:
                    return found
    return None


def _parse_meta_row_list(row):
    """
    meta1 řádek dle PDF pořadí (ověřeno v CI diagnostice):
      [WSI, DBC, název, tok, lat, lon, SPA_TYP, "vodní stav", "CM",
       DRYH, SPA1H..SPA4H, "průtok", "M3_S", DRYQ, SPA1Q..SPA4Q, …]
    Prahy kotvíme na jednotkové stringy CM / M3_S — kdyby ČHMÚ posunulo sloupce.
    """
    if len(row) < 9 or not isinstance(row[1], str):
        return None
    dbc = row[1].strip()
    lat, lon = _num(row[4]), _num(row[5])
    if not dbc or lat is None or lon is None:
        return None

    def anchor_block(unit):
        for i, c in enumerate(row):
            if isinstance(c, str) and c.strip().upper() == unit:
                nums = [_num(x) for x in row[i + 1:i + 6]]
                return (nums + [None] * 5)[:5]   # [DRY, SPA1, SPA2, SPA3, SPA4]
        return [None] * 5
    hb = anchor_block("CM")
    qb = anchor_block("M3_S")

    spa_typ = "H"
    for c in row[6:9]:
        if isinstance(c, str) and c.strip().upper() in ("H", "Q"):
            spa_typ = c.strip().upper()
            break

    return {
        "id": dbc,
        "name": str(row[2] or dbc),
        "stream": str(row[3] or ""),
        "lat": round(lat, 4), "lon": round(lon, 4),
        "spa_typ": spa_typ,
        "dry_h": hb[0], "spa_h": hb[1:4],
        "dry_q": qb[0], "spa_q": qb[1:4],
    }


def parse_metadata(files):
    """Metadata → {dbc: {name, stream, lat, lon, spa_typ, prahy…}}. Loguje tvar."""
    stations = {}
    for url in files:
        # meta2/meta3 mají jiný layout — stačí meta1 (obsahuje vše potřebné)
        fname = url.rsplit("/", 1)[-1].lower()
        if "meta" in fname and "meta1" not in fname:
            continue
        r = get(url)
        if not r:
            continue
        try:
            data = r.json()
        except Exception as e:
            print(f"  [diag] metadata nejsou JSON: {url} ({e})", file=sys.stderr)
            continue
        rows = _walk_values(data)
        if not rows:
            print(f"  [diag] metadata bez řádků: {url} klíče={list(data)[:8] if isinstance(data, dict) else type(data)}", file=sys.stderr)
            continue
        print(f"  [diag] metadata {url.rsplit('/',1)[-1]}: {len(rows)} řádků, vzorek: {json.dumps(rows[0], ensure_ascii=False)[:300]}", file=sys.stderr)
        for row in rows:
            st = None
            if isinstance(row, list):
                st = _parse_meta_row_list(row)
            elif isinstance(row, dict):
                dbc = str(row.get("DBC") or "").strip()
                lat, lon = _num(row.get("GEOGR1")), _num(row.get("GEOGR2"))
                if dbc and lat is not None and lon is not None:
                    st = {"id": dbc, "name": str(row.get("STATION_NAME") or dbc),
                          "stream": str(row.get("STREAM_NAME") or ""),
                          "lat": round(lat, 4), "lon": round(lon, 4),
                          "spa_typ": str(row.get("SPA_TYP") or "H").upper(),
                          "spa_h": [_num(row.get(f"SPA{i}H")) for i in (1, 2, 3)],
                          "spa_q": [_num(row.get(f"SPA{i}Q")) for i in (1, 2, 3)],
                          "dry_h": _num(row.get("DRYH")), "dry_q": _num(row.get("DRYQ"))}
            if st:
                stations[st["id"]] = st
    return stations


_series_diag_left = 2


def parse_series(url):
    """Datový soubor stanice → [(dt_str, h_cm, q_m3s)] seřazené vzestupně."""
    global _series_diag_left
    r = get(url)
    if not r:
        return []
    try:
        data = r.json()
    except Exception:
        return []
    rows = _walk_values(data)
    if _series_diag_left > 0:
        top = list(data)[:8] if isinstance(data, dict) else f"list[{len(data)}]"
        sample = json.dumps(rows[:2], ensure_ascii=False)[:400] if rows else "—"
        print(f"  [diag] data {url.rsplit('/',1)[-1]}: top={top} rows={len(rows) if rows else 0} vzorek={sample}", file=sys.stderr)
        _series_diag_left -= 1
    if not rows:
        return []
    out = []
    for row in rows:
        if isinstance(row, dict):
            dt = row.get("DT") or row.get("dt") or row.get("DATE") or row.get("time")
            h = _num(row.get("H") or row.get("h"))
            q = _num(row.get("Q") or row.get("q"))
        elif isinstance(row, list) and len(row) >= 2:
            # pivot varianta: [id?, dt, H, Q, ...] — hledej dt (string s '-' nebo ':')
            dt = next((c for c in row if isinstance(c, str) and ("-" in c or ":" in c)), None)
            nums = [_num(c) for c in row if _num(c) is not None]
            h = nums[0] if nums else None
            q = nums[1] if len(nums) > 1 else None
        else:
            continue
        if dt is None or (h is None and q is None):
            continue
        out.append((str(dt), h, q))
    out.sort(key=lambda x: x[0])
    return out


def spa_level(st, h, q):
    """0 = normál, 1–3 = stupně povodňové aktivity, -1 = pod limitem sucha."""
    use_q = st["spa_typ"].startswith("Q")
    val = q if use_q else h
    thresholds = st["spa_q"] if use_q else st["spa_h"]
    dry = st["dry_q"] if use_q else st["dry_h"]
    if val is None:
        return None
    if dry is not None and val < dry:
        return -1
    level = 0
    for i, thr in enumerate(thresholds, start=1):
        if thr is not None and val >= thr:
            level = i
    return level


def main():
    print("\n=== Hydrologie — hlásné profily (opendata.chmi.cz) ===", file=sys.stderr)

    meta_files = find_json_files(f"{BASE}/now/metadata/")
    if not meta_files:
        meta_files = find_json_files(f"{BASE}/now/")
        meta_files = [f for f in meta_files if "meta" in f.lower()]
    print(f"  Metadata souborů: {len(meta_files)}", file=sys.stderr)
    stations = parse_metadata(meta_files[:10])
    if not stations:
        print("  Bez metadat stanic — končím (viz [diag] výše)", file=sys.stderr)
        return

    data_files = find_json_files(f"{BASE}/now/data/")
    print(f"  Datových souborů: {len(data_files)}", file=sys.stderr)
    if data_files:
        print(f"  [diag] příklad názvů: {[f.rsplit('/',1)[-1] for f in data_files[:6]]}", file=sys.stderr)

    # datový soubor → DBC: ze všech číselných skupin v názvu vyber tu, která
    # odpovídá známé stanici (v názvu bývá i WSI s dalšími čísly)
    known = set(stations)
    by_dbc = {}
    for f in data_files:
        for grp in re.findall(r"\d{3,}", f.rsplit("/", 1)[-1]):
            if grp in known:
                by_dbc.setdefault(grp, f)
                break

    # resume: předchozí stanice drž (CI cache soubor přenáší mezi běhy),
    # v tomhle běhu obnov, co se stihne — nejdřív dosud nestažené
    prev = {}
    prev_path = DATA_DIR / "hydro.json"
    if prev_path.exists():
        try:
            prev = {s["id"]: s for s in json.loads(prev_path.read_text()).get("stations", [])}
        except Exception:
            prev = {}
    order = sorted(stations.items(), key=lambda kv: kv[0] in prev)  # nové první

    out_stations = []
    matched = 0
    for dbc, st in order[:MAX_STATIONS]:
        if over_budget():
            print(f"  Rozpočet {BUDGET_S} s vyčerpán — beru, co je ({matched} stanic)", file=sys.stderr)
            break
        f = by_dbc.get(dbc)
        if not f:
            continue
        series = parse_series(f)
        if not series:
            continue
        matched += 1
        dt, h, q = series[-1]
        # trend: rozdíl vůči hodnotě ~6 h zpět (36 × 10 min)
        trend = None
        if h is not None and len(series) > 36 and series[-37][1] is not None:
            trend = round(h - series[-37][1], 1)
        out_stations.append({
            **{k: st[k] for k in ("id", "name", "stream", "lat", "lon")},
            "h_cm": h, "q_m3s": q, "t": dt,
            "spa": spa_level(st, h, q), "trend_cm": trend,
        })

    # merge s předchozím stavem — čerstvé přepisují, staré zůstávají
    merged = {**prev, **{s["id"]: s for s in out_stations}}
    out_stations = list(merged.values())
    print(f"  Stanic s daty: čerstvě {matched}, celkem {len(out_stations)} / metadata {len(stations)}", file=sys.stderr)
    if not out_stations:
        print("  Žádná napárovaná data — hydro.json nepřepisuji", file=sys.stderr)
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "hydro.json").write_text(json.dumps({
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "stations": out_stations,
    }, ensure_ascii=False, separators=(",", ":")))
    n_spa = sum(1 for s in out_stations if (s["spa"] or 0) > 0)
    print(f"  ✓ hydro.json — {len(out_stations)} profilů, {n_spa} v SPA", file=sys.stderr)


if __name__ == "__main__":
    main()
