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

DATA_DIR = Path(__file__).parent.parent / "data"
BASE = "https://opendata.chmi.cz/hydrology"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)", "Accept": "application/json,*/*"}
TIMEOUT = (5, 15)
MAX_STATIONS = 400   # pojistka proti tisícům souborů
BUDGET_S = 90        # tvrdý rozpočet — pipeline nesmí čekat na pomalý server
_T0 = _time.monotonic()


def over_budget():
    return _time.monotonic() - _T0 > BUDGET_S


def get(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
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


def parse_metadata(files):
    """Metadata → {dbc: {name, stream, lat, lon, spa_typ, prahy…}}. Loguje tvar."""
    stations = {}
    for url in files:
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
            if not isinstance(row, dict):
                continue
            dbc = str(row.get("DBC") or row.get("dbc") or "").strip()
            lat = _num(row.get("GEOGR1") or row.get("geogr1"))
            lon = _num(row.get("GEOGR2") or row.get("geogr2"))
            if not dbc or lat is None or lon is None:
                continue
            stations[dbc] = {
                "id": dbc,
                "name": str(row.get("STATION_NAME") or row.get("station_name") or dbc),
                "stream": str(row.get("STREAM_NAME") or row.get("stream_name") or ""),
                "lat": round(lat, 4), "lon": round(lon, 4),
                "spa_typ": str(row.get("SPA_TYP") or "H").strip().upper() or "H",
                "spa_h": [_num(row.get(f"SPA{i}H")) for i in (1, 2, 3)],
                "spa_q": [_num(row.get(f"SPA{i}Q")) for i in (1, 2, 3)],
                "dry_h": _num(row.get("DRYH")),
                "dry_q": _num(row.get("DRYQ")),
            }
    return stations


def parse_series(url):
    """Datový soubor stanice → [(dt_str, h_cm, q_m3s)] seřazené vzestupně."""
    r = get(url)
    if not r:
        return []
    try:
        data = r.json()
    except Exception:
        return []
    rows = _walk_values(data)
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

    # datový soubor → DBC podle čísla v názvu
    by_dbc = {}
    for f in data_files:
        m = re.search(r"(\d{3,})", f.rsplit("/", 1)[-1])
        if m:
            by_dbc.setdefault(m.group(1), f)

    out_stations = []
    matched = 0
    for dbc, st in list(stations.items())[:MAX_STATIONS]:
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

    print(f"  Stanic s daty: {matched} / metadata {len(stations)}", file=sys.stderr)
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
