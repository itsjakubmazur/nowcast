"""
Verifikace nowcastu SRÁŽEK proti měřeným úhrnům ze srážkoměrné sítě.

Proč to vzniklo: verify.py hodnotí jen teplotu, protože ji stanice měří
spolehlivě. Jenže na srážky se lidi ptají — "bude pršet?" je celá otázka
téhle aplikace — a přesnost srážek jsme dosud neměřili vůbec. Přitom máme
436 srážkoměrů s desetiminutovým krokem, což je hustší síť, než s jakou
se verifikuje většina veřejných nowcastů.

Jak to funguje: nowcast neumíme ověřit hned, protože předpovídá budoucnost.
Při každém běhu se proto uloží, kolik mm slibujeme na příští hodinu pro
každý srážkoměr (pending), a v některém z pozdějších běhů se to porovná
s tím, co srážkoměr skutečně naměřil (mm_1h). Stejný vzor jako u COTREC.

Metriky, které z toho lezou, jsou záměrně ty, které se ve srážkové
verifikaci používají a jsou vypovídající i při velké převaze suchých případů:
  POD  (probability of detection) — kolik skutečných dešťů jsme trefili
  FAR  (false alarm ratio)        — kolik z našich předpovědí deště byl planý poplach
  CSI  (critical success index)   — souhrn obojího, hlavní číslo
  bias — kolikrát víc/míň mm slibujeme, než reálně spadne

Proč ne "úspěšnost v %": při suchu (a to je většina času) by vycházela přes
95 % i pro předpověď "nikdy neprší". CSI takhle obelstít nejde.

Výstup: data/accuracy_precip.json + pipeline/state/precip_pending.json
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
STATE_DIR = Path(__file__).parent / "state"
PENDING_PATH = STATE_DIR / "precip_pending.json"
HISTORY_PATH = STATE_DIR / "precip_history.json"

WINDOW_DAYS = 30
LEAD_MIN = 60          # hodnotíme předpověď na +1 h (srážkoměr hlásí mm_1h)
TOL_MIN = 20           # tolerance shody času předpovědi a měření
MAX_PENDING = 20000
RAIN_MM = 0.1          # od kolika mm považujeme hodinu za "pršelo"
MATCH_KM = 8           # srážkoměr musí být blízko bodu mřížky
PENDING_MAX_AGE_H = 6  # nespárované záznamy po téhle době zahodíme


def haversine_km(lat1, lon1, lat2, lon2):
    from math import asin, cos, radians, sin, sqrt
    p1, p2 = radians(lat1), radians(lat2)
    dp = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(a))


def load(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def predicted_mm_next_hour(grid, idx):
    """
    Součet mm za prvních LEAD_MIN minut pro bod mřížky.

    grid["series"][idx] je řada mm/h po step_min minutách; úhrn je tedy
    součet hodnot × (step/60), ne prostý součet.
    """
    series = (grid.get("series") or {}).get(str(idx))
    if not series:
        return 0.0
    step = grid.get("step_min") or 10
    n = max(1, LEAD_MIN // step)
    return round(sum(series[:n]) * (step / 60.0), 3)


def build_pending(grid, rain, now):
    """Pro každý srážkoměr ulož, kolik mm slibujeme na příští hodinu."""
    pts = grid.get("pts") or []
    if not pts:
        return []
    valid = (now + timedelta(minutes=LEAD_MIN)).isoformat()
    out = []
    for st in (rain.get("stations") or []):
        if st.get("stale") or st.get("lat") is None or st.get("lon") is None:
            continue
        # nejbližší bod mřížky
        bi, bd = -1, 1e9
        for i, pt in enumerate(pts):
            d = haversine_km(st["lat"], st["lon"], pt[0], pt[1])
            if d < bd:
                bd, bi = d, i
        if bi < 0 or bd > MATCH_KM:
            continue
        out.append({
            "id": st.get("id") or st.get("name"),
            "valid_utc": valid,
            "pred_mm": predicted_mm_next_hour(grid, bi),
            "dist_km": round(bd, 1),
        })
    return out


def score(pending, rain, now):
    """
    Spáruje čekající předpovědi s měřením a vrátí (nové záznamy, zbytek).

    Měření se bere jako mm_1h dané stanice — tedy úhrn za hodinu, která
    právě skončila. Pár se uzná, když se čas platnosti trefí do TOL_MIN.
    """
    by_id = {}
    for st in (rain.get("stations") or []):
        sid = st.get("id") or st.get("name")
        if sid and not st.get("stale") and st.get("mm_1h") is not None:
            by_id[sid] = st

    obs_time = rain.get("generated_at_utc") or now.isoformat()
    try:
        obs_dt = datetime.fromisoformat(obs_time)
    except ValueError:
        obs_dt = now

    hits = misses = false_alarms = correct_neg = 0
    sum_pred = sum_obs = 0.0
    scored = 0
    still = []

    for p in pending:
        try:
            valid = datetime.fromisoformat(p["valid_utc"])
        except Exception:
            continue
        if abs((obs_dt - valid).total_seconds()) > TOL_MIN * 60:
            # Ještě nedozrálo, nebo naopak dávno propadlo.
            if (now - valid).total_seconds() < PENDING_MAX_AGE_H * 3600:
                still.append(p)
            continue
        st = by_id.get(p.get("id"))
        if st is None:
            continue

        pred = float(p.get("pred_mm") or 0.0)
        obs = float(st.get("mm_1h") or 0.0)
        pred_rain = pred >= RAIN_MM
        obs_rain = obs >= RAIN_MM
        if pred_rain and obs_rain:
            hits += 1
        elif pred_rain and not obs_rain:
            false_alarms += 1
        elif obs_rain and not pred_rain:
            misses += 1
        else:
            correct_neg += 1
        sum_pred += pred
        sum_obs += obs
        scored += 1

    if not scored:
        return None, still

    entry = {
        "run_utc": now.isoformat(),
        "lead_min": LEAD_MIN,
        "n": scored,
        "hits": hits, "misses": misses,
        "false_alarms": false_alarms, "correct_neg": correct_neg,
        "sum_pred_mm": round(sum_pred, 2),
        "sum_obs_mm": round(sum_obs, 2),
    }
    return entry, still


def aggregate(history):
    h = sum(e.get("hits", 0) for e in history)
    m = sum(e.get("misses", 0) for e in history)
    f = sum(e.get("false_alarms", 0) for e in history)
    cn = sum(e.get("correct_neg", 0) for e in history)
    sp = sum(e.get("sum_pred_mm", 0) for e in history)
    so = sum(e.get("sum_obs_mm", 0) for e in history)
    n = h + m + f + cn
    if not n:
        return None
    pod = h / (h + m) if (h + m) else None
    far = f / (h + f) if (h + f) else None
    csi = h / (h + m + f) if (h + m + f) else None
    return {
        "n": n,
        "rain_cases": h + m,
        "pod_pct": round(pod * 100, 1) if pod is not None else None,
        "far_pct": round(far * 100, 1) if far is not None else None,
        "csi_pct": round(csi * 100, 1) if csi is not None else None,
        # Nad 1 = slibujeme víc mm, než spadne. Pod 1 = podceňujeme.
        "amount_bias": round(sp / so, 2) if so > 0.5 else None,
        "sum_pred_mm": round(sp, 1),
        "sum_obs_mm": round(so, 1),
    }


def main():
    now = datetime.now(timezone.utc)
    grid = load(DATA_DIR / "forecast_grid.json", None)
    rain = load(DATA_DIR / "chmi_rain.json", None)
    if not grid or not rain:
        print("verify_precip.py: chybí forecast_grid.json nebo chmi_rain.json — vynechávám",
              file=sys.stderr)
        return

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    pending = load(PENDING_PATH, [])
    if not isinstance(pending, list):
        pending = []

    entry, still = score(pending, rain, now)
    history = load(HISTORY_PATH, [])
    if not isinstance(history, list):
        history = []
    if entry:
        history.append(entry)
        print(f"  spárováno {entry['n']} stanic: {entry['hits']} trefa, "
              f"{entry['misses']} minutí, {entry['false_alarms']} planý poplach")

    cutoff = (now - timedelta(days=WINDOW_DAYS)).isoformat()
    history = [e for e in history if e.get("run_utc", "") >= cutoff]

    # Nové sliby na příští hodinu
    fresh = build_pending(grid, rain, now)
    still.extend(fresh)
    if len(still) > MAX_PENDING:
        still = still[-MAX_PENDING:]

    PENDING_PATH.write_text(json.dumps(still, ensure_ascii=False))
    HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False))

    agg = aggregate(history)
    out = {
        "generated_at_utc": now.isoformat(),
        "window_days": WINDOW_DAYS,
        "lead_min": LEAD_MIN,
        "threshold_mm": RAIN_MM,
        "n_runs": len(history),
        "method": ("Slib nowcastu na +1 h uložený v čase vydání a porovnaný "
                   "s tím, co srážkoměr skutečně naměřil. CSI, POD a FAR místo "
                   "prosté úspěšnosti — ta by při převaze suchých hodin vycházela "
                   "vysoká i pro předpověď „nikdy neprší“."),
        "scores": agg,
    }
    (DATA_DIR / "accuracy_precip.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2))
    if agg:
        print(f"verify_precip.py: CSI {agg['csi_pct']} %, POD {agg['pod_pct']} %, "
              f"FAR {agg['far_pct']} %, bias {agg['amount_bias']} "
              f"(n={agg['n']}, dešťových případů {agg['rain_cases']})")
    else:
        print(f"verify_precip.py: zatím bez vyhodnocených párů "
              f"({len(still)} čeká na měření)")


if __name__ == "__main__":
    main()
