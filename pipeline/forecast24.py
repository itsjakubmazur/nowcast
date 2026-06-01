"""
Fáze 4d — 24h předpověď po vybraných místech
- Hodinová data na 24 h: weather_code, temperature_2m, precipitation,
  precipitation_probability, wind_speed_10m, wind_gusts_10m.
- Open-Meteo multi-location (stejný přístup jako grid.py): vše v pár requestech.
- Výstup: data/forecast24.json
  {
    "generated_at_utc": "...",
    "places": [
      {
        "id": "Praha",
        "lat": 50.08, "lon": 14.42,
        "hourly": [          # nejbližších 6 hodin, po 1 h
          {"t": "14:00", "wc": 3, "temp": 18, "precip": 0.0, "prob": 10, "wind": 14},
          ...
        ],
        "blocks": [          # zbývající čas do 24 h, okna po 3 h
          {"t": "15–18", "wc": 61, "tmin": 16, "tmax": 19,
           "precip": 1.2, "prob": 60, "gust": 22},
          ...
        ]
      },
      ...
    ]
  }
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from ingest import DATA_DIR, OPEN_METEO_URL

# ── Konfigurace míst ──────────────────────────────────────────────────────────
# Vybrali jsme reprezentativní česká města + výchozí bod pipeline (Praha).
# Frontend je zobrazuje jako záložní sadu; interaktivní bod se dělá přes JS
# (fetch z prohlížeče na Open-Meteo geocoding → dotaz na tento endpoint provede
#  JS přímo, nebo se použije nejbližší předpočítané místo).
PLACES = [
    ("Praha",      50.0755, 14.4378),
    ("Brno",       49.1951, 16.6068),
    ("Ostrava",    49.8209, 18.2625),
    ("Plzeň",      49.7384, 13.3736),
    ("Liberec",    50.7663, 15.0543),
    ("Olomouc",    49.5938, 17.2509),
    ("České Budějovice", 48.9747, 14.4742),
    ("Hradec Králové",   50.2092, 15.8328),
    ("Zlín",       49.2231, 17.6686),
    ("Jihlava",    49.3961, 15.5913),
    ("Karlovy Vary", 50.2310, 12.8710),
    ("Ústí nad Labem", 50.6607, 14.0323),
]

OM_BATCH = 100   # Open-Meteo max lokací na request (prakticky nikdy nepřekročíme)
N_HOURLY = 6     # počet hodinových kroků (nejbližší hodiny)
BLOCK_H  = 3     # velikost agregačního okna pro zbytek 24 h

# WMO weather_code: vyšší = závažnější (pro výběr repr. kódu z okna)
# Pořadí závažnosti: bouřka > sněžení > déšť > přeháňky > mlha > zataženo > polojasno > jasno
_WC_SEVERITY = {
    **{c: 9 for c in [95, 96, 99]},    # bouřky
    **{c: 8 for c in [71, 73, 75, 77]},  # sněžení
    **{c: 7 for c in [85, 86]},          # sněhové přeháňky
    **{c: 6 for c in [55, 57, 65, 67]},  # silný déšť/mrholení
    **{c: 5 for c in [51, 53, 61, 63, 80, 81, 82]},  # slabý–mírný déšť
    **{c: 4 for c in [45, 48]},          # mlha
    **{c: 3 for c in [3]},               # zataženo
    **{c: 2 for c in [1, 2]},            # polojasno
    **{c: 1 for c in [0]},               # jasno
}


def _severity(wc: int | None) -> int:
    if wc is None:
        return 0
    return _WC_SEVERITY.get(wc, 1)


def _most_severe(codes: list) -> int | None:
    valid = [c for c in codes if c is not None]
    if not valid:
        return None
    return max(valid, key=_severity)


def _to_utc(s: str) -> datetime:
    if s and ("+" not in s) and not s.endswith("Z"):
        s += "+00:00"
    return datetime.fromisoformat(s)


def _om_get(params: dict) -> dict:
    """
    GET na Open-Meteo s retry a backoff.
    Opakuje při timeoutu nebo 5xx, max 3 pokusy, prodleva 3/6/12 s.
    Vyhodí výjimku pokud všechny pokusy selžou.
    """
    import time
    delays = [3, 6, 12]
    last_exc = None
    for attempt, delay in enumerate(delays, 1):
        try:
            r = requests.get(OPEN_METEO_URL, params=params, timeout=(10, 60))
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}", response=r)
            r.raise_for_status()
            return r.json()
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as e:
            last_exc = e
            if attempt < len(delays):
                print(f"  OM pokus {attempt} selhal ({e.__class__.__name__}), čekám {delay}s…")
                time.sleep(delay)
            else:
                print(f"  OM pokus {attempt} selhal ({e.__class__.__name__}), vzdávám se.")
    raise last_exc


def fetch_forecast24(places: list) -> list:
    """
    Stáhne hodinovou předpověď pro seznam (name, lat, lon) míst.
    Vrátí list slovníků připravených pro JSON výstup.
    """
    results = []
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    for start in range(0, len(places), OM_BATCH):
        chunk = places[start:start + OM_BATCH]
        lats = ",".join(f"{p[1]:.4f}" for p in chunk)
        lons = ",".join(f"{p[2]:.4f}" for p in chunk)
        params = {
            "latitude":  lats,
            "longitude": lons,
            "hourly": ",".join([
                "weather_code",
                "temperature_2m",
                "precipitation",
                "precipitation_probability",
                "wind_speed_10m",
                "wind_gusts_10m",
            ]),
            "timezone":      "UTC",
            "forecast_days": 2,
            "models":        "icon_d2",
        }
        try:
            data = _om_get(params)
        except Exception as e:
            print(f"  ⚠ forecast24 batch {start//OM_BATCH} CHYBA (všechny pokusy): {e}",
                  file=sys.stderr)
            for p in chunk:
                results.append({"id": p[0], "lat": p[1], "lon": p[2], "error": str(e)})
            continue

        items = data if isinstance(data, list) else [data]
        for place, item in zip(chunk, items):
            name, lat, lon = place
            rec = _parse_item(item, now_utc)
            rec["id"]  = name
            rec["lat"] = round(lat, 4)
            rec["lon"] = round(lon, 4)
            results.append(rec)

    return results


def _nn(lst: list, i: int, default=None):
    """Bezpečné čtení ze seznamu — vrátí default místo IndexError nebo None."""
    v = lst[i] if i < len(lst) else None
    return default if v is None else v


def _nn_list(lst: list, indices) -> list:
    """Filtrovaný podseznam — vynechá None a out-of-bounds."""
    result = []
    for j in indices:
        v = lst[j] if j < len(lst) else None
        if v is not None:
            result.append(v)
    return result


def _parse_item(item: dict, now_utc: datetime) -> dict:
    """Zparsuje jednu Open-Meteo odpověď → hourly (6 h) + blocks (3h do 24 h)."""
    h = item.get("hourly", {})
    times = [_to_utc(t) for t in (h.get("time") or [])]
    wc    = h.get("weather_code") or []
    temp  = h.get("temperature_2m") or []
    prec  = h.get("precipitation") or []
    prob  = h.get("precipitation_probability") or []
    wind  = h.get("wind_speed_10m") or []
    gust  = h.get("wind_gusts_10m") or []

    # Najdi index první hodiny ≥ now_utc
    start_i = next((i for i, t in enumerate(times) if t >= now_utc), None)
    if start_i is None:
        return {"hourly": [], "blocks": []}

    # ── Nejbližších N_HOURLY hodin ────────────────────────────────────────────
    hourly_out = []
    for k in range(N_HOURLY):
        i = start_i + k
        if i >= len(times):
            break
        t = times[i]
        temp_v = _nn(temp, i)
        prec_v = _nn(prec, i, 0.0)
        prob_v = _nn(prob, i, 0)
        wind_v = _nn(wind, i, 0)
        hourly_out.append({
            "t":      t.strftime("%H:%M"),
            "wc":     _nn(wc, i),
            "temp":   round(temp_v) if temp_v is not None else None,
            "precip": round(prec_v, 1),
            "prob":   round(prob_v),
            "wind":   round(wind_v),
        })

    # ── 3h bloky pro zbytek 24h ───────────────────────────────────────────────
    block_start_i = start_i + N_HOURLY
    end_i = start_i + 24
    blocks_out = []
    i = block_start_i
    while i < end_i and i < len(times):
        block_end_i = min(i + BLOCK_H, end_i, len(times))
        js = range(i, block_end_i)
        wc_sl   = [wc[j] if j < len(wc) else None for j in js]
        temp_sl = _nn_list(temp, js)
        prec_sl = _nn_list(prec, js)
        prob_sl = _nn_list(prob, js)
        gust_sl = _nn_list(gust, js)

        t_from = times[i].strftime("%H")
        t_to   = times[min(block_end_i, len(times) - 1)].strftime("%H")
        blocks_out.append({
            "t":      f"{t_from}–{t_to}",
            "wc":     _most_severe(wc_sl),
            "tmin":   round(min(temp_sl)) if temp_sl else None,
            "tmax":   round(max(temp_sl)) if temp_sl else None,
            "precip": round(sum(prec_sl), 1) if prec_sl else 0.0,
            "prob":   max(prob_sl) if prob_sl else 0,
            "gust":   round(max(gust_sl)) if gust_sl else 0,
        })
        i += BLOCK_H

    return {"hourly": hourly_out, "blocks": blocks_out}


def main():
    print("\n=== Fáze 4d — 24h předpověď ===")
    print(f"  Míst: {len(PLACES)}, dávka OM: {OM_BATCH}")

    places_data = fetch_forecast24(PLACES)

    # Výpis pro kontrolu
    for p in places_data:
        if "error" in p:
            print(f"  {p['id']}: CHYBA — {p['error']}")
            continue
        h0 = p["hourly"][0] if p["hourly"] else {}
        def _fmt(v, suffix="", width=3):
            return f"{v:{width}}{suffix}" if v is not None else f"{'—':>{width+len(suffix)}}"
        print(f"  {p['id']:22s}: +0h wc={_fmt(h0.get('wc'))}  "
              f"temp={_fmt(h0.get('temp'), '°C', 3)}  "
              f"prec={_fmt(h0.get('precip'), 'mm', 4)}  "
              f"prob={_fmt(h0.get('prob'), '%')}  "
              f"| {len(p['hourly'])} hod + {len(p['blocks'])} bloky")

    ok_places  = [p for p in places_data if "error" not in p]
    err_places = [p for p in places_data if "error" in p]

    if not ok_places:
        print(f"  ✗ CHYBA: všechna místa ({len(err_places)}) selhala — forecast24.json NEPŘEPSÁN.",
              file=sys.stderr)
        sys.exit(1)

    if err_places:
        print(f"  ⚠ WARN: {len(err_places)} míst selhalo, uložím {len(ok_places)} úspěšných.")

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "n_hourly": N_HOURLY,
        "block_h":  BLOCK_H,
        "places":   ok_places,   # ukládáme jen úspěšná místa
    }
    out_path = DATA_DIR / "forecast24.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    sz = out_path.stat().st_size
    print(f"✓ Fáze 4d OK — {len(ok_places)}/{len(PLACES)} míst, "
          f"{sz // 1024} kB → {out_path}")


if __name__ == "__main__":
    main()
