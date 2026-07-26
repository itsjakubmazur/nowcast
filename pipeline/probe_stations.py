"""Sonda: kde vzít JMÉNA letišť k ICAO kódům (bulk METAR je nemá)."""
import gzip, json, re, sys
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "nowcast-probe/1.0"}
T = (15, 90)


def get(u):
    return requests.get(u, headers=UA, timeout=T)


def main():
    print(f"Sonda — číselník jmen letišť, {datetime.now(timezone.utc).isoformat()}")
    cands = [
        "https://aviationweather.gov/data/cache/stations.cache.json.gz",
        "https://aviationweather.gov/data/cache/stations.cache.xml.gz",
        "https://aviationweather.gov/api/data/stationinfo?ids=LKPR,KJFK,RJTT&format=json",
        "https://aviationweather.gov/api/data/stationinfo?bbox=48.3,11.8,51.3,19.2&format=json",
    ]
    for url in cands:
        try:
            r = get(url)
            print(f"\n{url.rsplit('/', 1)[-1][:60]}: HTTP {r.status_code}, {len(r.content)} B")
            if not r.ok:
                print(f"  tělo: {r.text[:200]}")
                continue
            body = r.content
            if url.endswith(".gz"):
                body = gzip.decompress(body)
                print(f"  rozbaleno: {len(body)} B")
            txt = body.decode("utf-8", "replace")
            if url.endswith(".json.gz") or "format=json" in url:
                try:
                    j = json.loads(txt)
                    arr = j if isinstance(j, list) else j.get("data") or []
                    print(f"  položek: {len(arr)}")
                    if arr:
                        print(f"  klíče: {sorted(arr[0].keys())}")
                        for s in arr[:4]:
                            print(f"    {json.dumps(s, ensure_ascii=False)[:220]}")
                except Exception as e:
                    print(f"  není JSON: {e}; začátek: {txt[:200]!r}")
            else:
                print(f"  začátek: {txt[:400]!r}")
                m = re.findall(r"<station_id>(\w+)</station_id>.*?<site>([^<]*)</site>", txt[:200000], re.S)
                print(f"  párů station_id/site: {len(m)}, ukázka: {m[:5]}")
        except Exception as e:
            print(f"  CHYBA {str(e)[:160]}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
