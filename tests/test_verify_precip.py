"""
Testy pro pipeline/verify_precip.py — skóre srážkové předpovědi.

Proč zrovna tohle: srážková verifikace je plná pastí, do kterých se dá
spadnout tiše. Nejhorší je "úspěšnost v procentech" — při suchu (většina času)
vyjde přes 95 % i pro předpověď „nikdy neprší". Testy proto hlídají, že
metriky ten trik neumožňují a že se počítá s mm/h, ne s prostým součtem.

Spouštění: python tests/test_verify_precip.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
import verify_precip as vp  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  {detail}")
        FAILS.append(name)


def main():
    now = datetime(2026, 7, 26, 12, 0, tzinfo=timezone.utc)
    print("=== verify_precip — metriky srážkové předpovědi ===")

    # --- převod řady mm/h na úhrn --------------------------------------------
    grid = {
        "step_min": 10,
        "pts": [[50.0, 14.0], [49.0, 16.0]],
        # 6 kroků po 10 min = 1 h; 6 mm/h po celou hodinu = 6 mm
        "series": {"0": [6, 6, 6, 6, 6, 6, 0, 0], "1": [0, 0, 0, 0, 0, 0]},
    }
    check("řada mm/h se převede na úhrn, ne se sečte",
          vp.predicted_mm_next_hour(grid, 0) == 6.0,
          str(vp.predicted_mm_next_hour(grid, 0)))
    check("suchý bod dá nulu", vp.predicted_mm_next_hour(grid, 1) == 0.0)
    check("chybějící bod nespadne", vp.predicted_mm_next_hour(grid, 99) == 0.0)

    # --- párování stanic na mřížku -------------------------------------------
    rain = {"stations": [
        {"id": "A", "lat": 50.0, "lon": 14.0, "mm_1h": 0},
        {"id": "B", "lat": 49.0, "lon": 16.0, "mm_1h": 0},
        {"id": "DALEKO", "lat": 45.0, "lon": 5.0, "mm_1h": 0},
        {"id": "STALE", "lat": 50.0, "lon": 14.0, "mm_1h": 9, "stale": True},
    ]}
    pend = vp.build_pending(grid, rain, now)
    ids = {p["id"] for p in pend}
    check("stanice u bodu mřížky se spárují", {"A", "B"} <= ids, str(ids))
    check("vzdálená stanice se nespáruje", "DALEKO" not in ids, str(ids))
    check("zastaralá stanice se nepoužije", "STALE" not in ids, str(ids))
    check("slib se uloží i s předpovězeným úhrnem",
          next(p["pred_mm"] for p in pend if p["id"] == "A") == 6.0)

    # --- kontingenční tabulka ------------------------------------------------
    valid = (now + timedelta(minutes=60)).isoformat()
    pending = [
        {"id": "hit", "valid_utc": valid, "pred_mm": 2.0},      # slíbeno i naměřeno
        {"id": "miss", "valid_utc": valid, "pred_mm": 0.0},     # nesliboval, pršelo
        {"id": "false", "valid_utc": valid, "pred_mm": 3.0},    # sliboval, nepršelo
        {"id": "dry", "valid_utc": valid, "pred_mm": 0.0},      # sucho správně
    ]
    obs = {"generated_at_utc": (now + timedelta(minutes=60)).isoformat(),
           "stations": [
               {"id": "hit", "mm_1h": 1.8},
               {"id": "miss", "mm_1h": 2.5},
               {"id": "false", "mm_1h": 0.0},
               {"id": "dry", "mm_1h": 0.0},
           ]}
    entry, still = vp.score(pending, obs, now + timedelta(minutes=60))
    check("všechny čtyři případy se spárovaly", entry and entry["n"] == 4,
          str(entry))
    if entry:
        check("trefa se započítá", entry["hits"] == 1, str(entry["hits"]))
        check("minutí se započítá", entry["misses"] == 1, str(entry["misses"]))
        check("planý poplach se započítá", entry["false_alarms"] == 1,
              str(entry["false_alarms"]))
        check("správně předpovězené sucho se započítá",
              entry["correct_neg"] == 1, str(entry["correct_neg"]))
    check("spárované záznamy z fronty zmizí", not still, str(still))

    # --- agregace ------------------------------------------------------------
    agg = vp.aggregate([entry])
    check("POD = 50 % (1 trefa ze 2 skutečných dešťů)",
          agg["pod_pct"] == 50.0, str(agg["pod_pct"]))
    check("FAR = 50 % (1 planý poplach ze 2 předpovědí deště)",
          agg["far_pct"] == 50.0, str(agg["far_pct"]))
    check("CSI = 33,3 % (1 / (1+1+1))",
          abs(agg["csi_pct"] - 33.3) < 0.1, str(agg["csi_pct"]))

    # --- klíčová vlastnost: "nikdy neprší" nesmí vyjít dobře -----------------
    # 100 případů, z toho 5 dešťů. Předpověď "vždy sucho" má správnost 95 %,
    # ale CSI 0 — přesně proto se tu úspěšnost v procentech nepoužívá.
    never = {"run_utc": now.isoformat(), "n": 100,
             "hits": 0, "misses": 5, "false_alarms": 0, "correct_neg": 95,
             "sum_pred_mm": 0.0, "sum_obs_mm": 12.0}
    agg2 = vp.aggregate([never])
    check("předpověď „nikdy neprší“ má CSI 0, i když má 95 % správně",
          agg2["csi_pct"] == 0.0, str(agg2["csi_pct"]))
    check("a POD taky 0", agg2["pod_pct"] == 0.0, str(agg2["pod_pct"]))

    # --- bias množství -------------------------------------------------------
    over = {"run_utc": now.isoformat(), "n": 10,
            "hits": 5, "misses": 0, "false_alarms": 0, "correct_neg": 5,
            "sum_pred_mm": 20.0, "sum_obs_mm": 10.0}
    check("dvojnásobné sliby dají bias 2,0",
          vp.aggregate([over])["amount_bias"] == 2.0,
          str(vp.aggregate([over])["amount_bias"]))
    dry = {"run_utc": now.isoformat(), "n": 5, "hits": 0, "misses": 0,
           "false_alarms": 0, "correct_neg": 5,
           "sum_pred_mm": 0.0, "sum_obs_mm": 0.0}
    check("bez naměřených srážek se bias nepočítá (dělení nulou)",
          vp.aggregate([dry])["amount_bias"] is None)

    # --- fronta --------------------------------------------------------------
    old_valid = (now - timedelta(hours=12)).isoformat()
    _, still2 = vp.score([{"id": "x", "valid_utc": old_valid, "pred_mm": 1}], obs, now)
    check("dávno propadlý slib se z fronty zahodí", not still2, str(still2))
    future = (now + timedelta(hours=1)).isoformat()
    _, still3 = vp.score([{"id": "y", "valid_utc": future, "pred_mm": 1}],
                         {"generated_at_utc": now.isoformat(), "stations": []}, now)
    check("slib, na který měření teprve dorazí, ve frontě zůstane",
          len(still3) == 1, str(still3))

    check("prázdná agregace vrátí None", vp.aggregate([]) is None)

    print()
    if FAILS:
        print(f"✗ {len(FAILS)} selhalo: {', '.join(FAILS)}")
        sys.exit(1)
    print("✓ všechny testy verify_precip prošly")


if __name__ == "__main__":
    main()
