"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

Kolo 11: dvě otevřené otázky.
  (a) KTERÉ stanice mají teplotu? meta2 je strojově čitelný katalog prvků
      (OBS_TYPE, WSI, EG_EL_ABBREVIATION, NAME, UN_DESCRIPTION, HEIGHT,
      SCHEDULE), 6591 řádků — tam je odpověď přesně, bez hádání zkratek.
      Nehledám podle názvů zkratek, ale podle českého NAME obsahujícího
      "tepl", ať mi nic neproteče kvůli špatně odhadnuté zkratce (což už se
      mi jednou stalo s WIGOS prefixem).
  (b) Co je v oficiálním popisu Klimatologicka_data_popis.pdf — ať se
      nespoléhám na to, co si o struktuře myslím.
"""

import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
T = (15, 90)
BASE = "https://opendata.chmi.cz/meteorology/climate"


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def get(u):
    return requests.get(u, headers=UA, timeout=T)


def now_data_ids():
    r = get(f"{BASE}/now/data/")
    pat = re.compile(r'^(?:10m|1h)-(.+?)-\d{8}\.json$')
    ids = set()
    for f in re.findall(r'href="([^"?][^"]*)"', r.text):
        m = pat.match(f)
        if m:
            ids.add(m.group(1))
    return ids


def probe_elements(ids):
    head("(a) meta2 — které stanice mají teplotu (podle NAME, ne podle zkratky)")
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    yday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y%m%d")
    values = None
    for d in (today, yday):
        r = get(f"{BASE}/now/metadata/meta2-{d}.json")
        if r.ok:
            try:
                values = r.json()["data"]["data"]["values"]
                print(f"  meta2-{d}: {len(values)} řádků")
                break
            except Exception as e:
                print(f"  meta2-{d} parse: {e}")
    if not values:
        print("  meta2 nedostupná")
        return

    # OBS_TYPE, WSI, EG_EL_ABBREVIATION, NAME, UN_DESCRIPTION, HEIGHT, SCHEDULE
    per_el_stations = defaultdict(set)
    el_name, el_unit = {}, {}
    for row in values:
        if len(row) < 5:
            continue
        wsi, abbr, name, unit = str(row[1]), str(row[2]), str(row[3]), str(row[4])
        per_el_stations[abbr].add(wsi)
        el_name.setdefault(abbr, name)
        el_unit.setdefault(abbr, unit)

    print(f"  různých prvků: {len(per_el_stations)}")
    print("  20 nejrozšířenějších prvků:")
    for abbr, st in sorted(per_el_stations.items(), key=lambda kv: -len(kv[1]))[:20]:
        print(f"    {abbr:14s} {len(st):5d} stanic  {el_name[abbr][:44]:46s} [{el_unit[abbr]}]")

    # Teplotní prvky — podle českého názvu, ne podle odhadnuté zkratky
    temp_els = {a: s for a, s in per_el_stations.items()
                if "tepl" in el_name[a].lower()}
    print(f"\n  TEPLOTNÍ prvky ({len(temp_els)}):")
    for abbr, st in sorted(temp_els.items(), key=lambda kv: -len(kv[1])):
        have = len(st & ids)
        print(f"    {abbr:14s} {len(st):5d} v katalogu, {have:5d} publikuje data  "
              f"{el_name[abbr][:40]}")

    any_temp = set().union(*temp_els.values()) if temp_els else set()
    print(f"\n  stanic s JAKOUKOLI teplotou v katalogu: {len(any_temp)}")
    print(f"  z toho publikuje data v now/: {len(any_temp & ids)}")
    print(f"  (dnes používáme 40)")

    # Srážky pro srovnání
    rain_els = {a: s for a, s in per_el_stations.items()
                if "srá" in el_name[a].lower() or "srazk" in el_name[a].lower()}
    any_rain = set().union(*rain_els.values()) if rain_els else set()
    print(f"  stanic se srážkami: {len(any_rain)} v katalogu, "
          f"{len(any_rain & ids)} publikuje data")

    # Rozpad podle WIGOS prefixu — kolik teplotních je národních?
    pref = Counter("-".join(w.split("-")[:3]) for w in (any_temp & ids))
    print(f"  teplotní stanice s daty podle prefixu: {dict(pref)}")


def probe_manual():
    head("(b) Oficiální popis dat — Klimatologicka_data_popis.pdf")
    url = f"{BASE}/Klimatologicka_data_popis.pdf"
    r = get(url)
    print(f"  {url.rsplit('/', 1)[-1]}: HTTP {r.status_code}, {len(r.content)} B")
    if not r.ok:
        return
    open("/tmp/popis.pdf", "wb").write(r.content)
    try:
        out = subprocess.run(["pdftotext", "-layout", "/tmp/popis.pdf", "-"],
                             capture_output=True, text=True, timeout=60)
        txt = out.stdout
    except FileNotFoundError:
        print("  pdftotext není k dispozici")
        return
    except Exception as e:
        print(f"  pdftotext: {e}")
        return
    print(f"  textu: {len(txt)} znaků")
    # Zajímají nás pasáže o rozsahu sítě, prvcích a o tom, jestli jsou data
    # jen česká — hledám klíčová slova a tiskneme okolí.
    for kw in ("globál", "svět", "zahranič", "mezinárod", "WIGOS", "0-203",
               "0-20000", "teplot", "síť", "stanic"):
        hits = [m.start() for m in re.finditer(kw, txt, re.IGNORECASE)][:2]
        for h in hits:
            frag = " ".join(txt[max(0, h - 160):h + 240].split())
            print(f"  [{kw}] …{frag}…")


def main():
    print(f"Sonda kolo 11 — {datetime.now(timezone.utc).isoformat()}")
    try:
        ids = now_data_ids()
        print(f"stanic s daty v now/: {len(ids)}")
    except Exception as e:
        print(f"!! seznam stanic: {e}", file=sys.stderr)
        ids = set()
    for fn in (lambda: probe_elements(ids), probe_manual):
        try:
            fn()
        except Exception as e:
            print(f"  !! {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
