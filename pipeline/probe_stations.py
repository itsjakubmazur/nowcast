"""
Sonda: proč chmi.py po rozšíření pořád vrací 40 stanic?

Replikuje přesně kroky z chmi.py a tiskne počty po každém, ať je vidět,
kde se seznam scvrkne. Levnější než lovit to v logu pipeline.
"""

import re
import sys
from datetime import datetime, timedelta, timezone

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

BASE = "https://opendata.chmi.cz/meteorology/climate/now"
UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)",
      "Accept": "application/json,text/html,*/*"}


def get(u):
    return requests.get(u, headers=UA, timeout=(10, 60))


def main():
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y%m%d")
    yday = (now - timedelta(days=1)).strftime("%Y%m%d")
    print(f"Sonda chmi.py — {now.isoformat()}  (dnes {today}, včera {yday})")

    # 1) metadata jako v chmi.py (klíč = celé WSI)
    merged = {}
    for d in (today, yday):
        r = get(f"{BASE}/metadata/meta1-{d}.json")
        if not r.ok:
            print(f"  meta1-{d}: HTTP {r.status_code}")
            continue
        values = r.json()["data"]["data"]["values"]
        for row in values:
            if len(row) < 5:
                continue
            wsi = str(row[0]).strip()
            if not wsi or wsi in merged:
                continue
            try:
                float(row[3]); float(row[4])
            except (TypeError, ValueError):
                continue
            merged[wsi] = True
        print(f"  meta1-{d}: {len(values)} řádků → metadata {len(merged)}")
        break

    # 2) objev stanic z výpisu now/data/
    r = get(f"{BASE}/data/")
    print(f"  now/data/: HTTP {r.status_code}, {len(r.text)} B")
    now_ids = []
    for date in (today, yday):
        for prefix in ("10m", "1h"):
            pat = re.compile(rf'{prefix}-(.+?)-{date}\.json')
            found = pat.findall(r.text)
            now_ids.extend(found)
            print(f"    vzor {prefix}-(.+?)-{date}: {len(found)} shod, "
                  f"ukázka {found[:3]}")
    uniq = list(dict.fromkeys(now_ids))
    print(f"  unikátních ID ze vzoru: {len(uniq)}")
    pref = {}
    for s in uniq:
        k = "-".join(s.split("-")[:3])
        pref[k] = pref.get(k, 0) + 1
    print(f"  podle prefixu: {pref}")

    in_meta = [s for s in uniq if s in merged]
    print(f"  po filtru 'je v metadatech': {len(in_meta)}")
    chybi = [s for s in uniq if s not in merged][:5]
    print(f"  ukázka těch, co v metadatech NEJSOU: {chybi}")

    # 3) filtr na teplotu z meta2
    temp_ids = set()
    for d in (today, yday):
        rm = get(f"{BASE}/metadata/meta2-{d}.json")
        if not rm.ok:
            print(f"  meta2-{d}: HTTP {rm.status_code}")
            continue
        vals = rm.json()["data"]["data"]["values"]
        temp_ids = {str(row[1]).strip() for row in vals
                    if len(row) > 2 and str(row[2]).strip() == "T"}
        print(f"  meta2-{d}: {len(vals)} řádků → {len(temp_ids)} s prvkem T")
        break
    final = [s for s in in_meta if s in temp_ids]
    print(f"  PO FILTRU NA TEPLOTU: {len(final)}")
    pref2 = {}
    for s in final:
        k = "-".join(s.split("-")[:3])
        pref2[k] = pref2.get(k, 0) + 1
    print(f"  finální podle prefixu: {pref2}")
    print(f"  ukázka: {final[:5]}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
