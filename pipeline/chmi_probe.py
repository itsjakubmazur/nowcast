"""
Diagnostický skript — probíng ČHMÚ OpenData URL formátů.
Spustí se jednorázově, výsledky se zobrazí v GitHub Actions logu.
"""
import requests
from datetime import datetime, timezone, timedelta

BASE = "https://opendata.chmi.cz/meteorology/climate"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
TIMEOUT = 15

now = datetime.now(timezone.utc)
today = now.strftime("%Y%m%d")
yyyymm = now.strftime("%Y%m")
yyyy = now.strftime("%Y")
prev_yyyymm = (now - timedelta(days=32)).strftime("%Y%m")
prev_yyyy = str(now.year - 1)

# Dobře známá stanice — Praha/Karlov
SID5 = "11518"   # 5-digit WMO
SID_LONG = "41701010001"  # příklad 11-digit z metadat (Praha auto?)

def probe(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        size = len(r.content) if r.ok else 0
        print(f"  {r.status_code}  {size:6d}b  {url}")
        return r
    except Exception as e:
        print(f"  ERR  {url}  ({e})")
        return None

print("\n=== ČHMÚ URL PROBE ===")
print(f"  Date: {today}, YYYYMM: {yyyymm}\n")

print("--- now/data/ directory ---")
probe(f"{BASE}/now/data/")

print("\n--- now/data/ station 11518 ---")
probe(f"{BASE}/now/data/10m-0-20000-0-{SID5}-{today}.json")
probe(f"{BASE}/now/data/1h-0-20000-0-{SID5}-{today}.json")

print("\n--- recent/ directory probe ---")
probe(f"{BASE}/recent/")
probe(f"{BASE}/recent/data/")
probe(f"{BASE}/recent/data/hourly/")
probe(f"{BASE}/recent/data/1h/")
probe(f"{BASE}/recent/data/obs/")

print("\n--- recent/data/hourly/ with 5-digit ID ---")
probe(f"{BASE}/recent/data/hourly/1h-0-20000-0-{SID5}-{yyyymm}.json")
probe(f"{BASE}/recent/data/hourly/1h-0-20000-0-{SID5}-{prev_yyyymm}.json")
probe(f"{BASE}/recent/data/hourly/1h-0-20000-0-{SID5}-{today}.json")

print("\n--- recent/data/ without 'hourly' ---")
probe(f"{BASE}/recent/data/1h-0-20000-0-{SID5}-{yyyymm}.json")

print("\n--- recent/data/daily/ (climate daily) ---")
probe(f"{BASE}/recent/data/daily/")
probe(f"{BASE}/recent/data/daily/dly-0-20000-0-{SID5}-{yyyymm}.json")

print("\n--- recent/data/monthly/ ---")
probe(f"{BASE}/recent/data/monthly/")
probe(f"{BASE}/recent/data/monthly/mly-0-20000-0-{SID5}.json")

print("\n--- historical/ directory probe ---")
probe(f"{BASE}/historical/")
probe(f"{BASE}/historical/data/")
probe(f"{BASE}/historical/data/daily/")
probe(f"{BASE}/historical/data/daily/dly-0-20000-0-{SID5}-{prev_yyyy}.json")
probe(f"{BASE}/historical/data/daily/dly-0-20000-0-{SID5}-{yyyy}.json")

print("\n--- Attempt without WSI prefix (bare station number) ---")
probe(f"{BASE}/recent/data/hourly/1h-{SID5}-{yyyymm}.json")
probe(f"{BASE}/historical/data/daily/dly-{SID5}-{prev_yyyy}.json")

print("\n--- now/metadata/ directory ---")
r = probe(f"{BASE}/now/metadata/")
if r and r.ok:
    print("  Content snippet:", r.text[:500])

print("\n--- recent/metadata/ ---")
r = probe(f"{BASE}/recent/metadata/")
if r and r.ok:
    # Parse a station ID from metadata to test
    try:
        import json, re
        data = r.json()
        values = data["data"]["data"]["values"]
        print(f"  {len(values)} entries in metadata")
        for row in values[:5]:
            print(f"    {row[:6]}")
    except Exception as e:
        print(f"  Parse error: {e}")
        print("  Text snippet:", r.text[:200])

print("\n=== PROBE DONE ===\n")
