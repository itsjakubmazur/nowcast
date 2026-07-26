"""Sonda: kontrola NASAZENÝCH dat (ruční workflow_dispatch, nic nezapisuje)."""
import sys
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "nowcast-probe/1.0"}
PAGES = "https://itsjakubmazur.github.io/nowcast/data"


def get(n):
    return requests.get(f"{PAGES}/{n}", headers=UA, timeout=(10, 60))


def main():
    print(f"Nasazená data — {datetime.now(timezone.utc).isoformat()}\n")

    r = get("chmi_stations.json")
    if r.ok:
        j = r.json()
        print(f"chmi_stations.json  {j.get('count')} stanic  ({j.get('generated_at_utc')})")

    r = get("chmi_stats.json")
    if r.ok:
        j = r.json()
        st = j.get("stations", {})
        withrec = sum(1 for v in st.values() if v.get("records"))
        withnorm = sum(1 for v in st.values() if v.get("monthly_normals"))
        print(f"chmi_stats.json     {len(st)} stanic  "
              f"(s rekordy {withrec}, s normály {withnorm})")
        for wsi, v in list(st.items())[:3]:
            rec = v.get("records") or {}
            print(f"   {v.get('name', wsi)[:24]:26s} rekordy: {list(rec)[:5]}")
    else:
        print(f"chmi_stats.json     HTTP {r.status_code}")

    r = get("metar_names.json")
    if r.ok:
        j = r.json()
        names = j.get("names", {})
        named = {k: v for k, v in names.items() if v}
        print(f"metar_names.json    {len(names)} ICAO, s městem {len(named)}")
        for k in ("LKPR", "LKTB", "LKMT", "KJFK", "RJTT", "EDDC"):
            if k in names:
                print(f"   {k} → {names[k]!r}")
    else:
        print(f"metar_names.json    HTTP {r.status_code}")

    r = get("metar_history.json")
    if r.ok:
        j = r.json()
        st = j.get("stations", {})
        tot = sum(len(v.get("series", [])) for v in st.values())
        print(f"metar_history.json  {len(st)} stanic, {tot} záznamů "
              f"({j.get('updated_at_utc')})")
        for k, v in list(st.items())[:4]:
            print(f"   {v.get('name', k)[:26]:28s} {len(v.get('series', []))} bodů")
    else:
        print(f"metar_history.json  HTTP {r.status_code}")

    r = get("metar/13_10.json")
    if r.ok:
        st = r.json().get("stations", [])
        print(f"metar/13_10.json    {len(st)} stanic; ukázka jmen: "
              f"{[s['name'] for s in st[:4]]}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
