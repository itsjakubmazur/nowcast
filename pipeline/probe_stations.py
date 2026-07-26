"""
Diagnostická sonda (ruční workflow_dispatch) — nic nezapisuje do data/.

Kolo 8 přezkoumává vlastní dřívější závěr. V kolech 1–4 jsem tvrdil, že ČHMÚ
publikuje jen 40 stanic. Ten závěr ale stál na regexu

    10m-0-20000-0-(\\d+)-{date}\\.json

který vidí VÝHRADNĚ WIGOS ID s prefixem 0-20000-0. Kdyby ČHMÚ publikovalo
světové stanice pod jiným prefixem, sonda by je nezapočítala a "40" by byl
artefakt mého vlastního filtru, ne vlastnost dat. Navíc:
  * meta1 obsahuje 759 stanic včetně Reykjavíku → globální WMO číselník,
  * v recent/data/10min/ bylo 11 875 odkazů, ale můj regex jich uznal 2 000.
Ten rozdíl jsem tehdy odbyl tím, že se odkazy v HTML počítají dvakrát.
Tady se to měří poctivě a bez předpokladu o tvaru názvu.
"""

import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

import requests

UA = {"User-Agent": "nowcast-probe/1.0 (+github actions)"}
TIMEOUT = (15, 90)
ROOT = "https://opendata.chmi.cz"
BASE = f"{ROOT}/meteorology/climate"


def head(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}", flush=True)


def get(url):
    return requests.get(url, headers=UA, timeout=TIMEOUT)


def links(html):
    """Unikátní odkazy, bez rodiče a bez absolutních URL."""
    out, seen = [], set()
    for l in re.findall(r'href="([^"?][^"]*)"', html):
        if l.startswith("http") or l == "../" or l in seen:
            continue
        seen.add(l)
        out.append(l)
    return out


def shape(name):
    """Název souboru s číselnými skupinami nahrazenými značkami — ať je vidět
    kolik RŮZNÝCH tvarů se v adresáři vyskytuje, ne kolik souborů."""
    s = re.sub(r'\d{8}', 'YYYYMMDD', name)
    s = re.sub(r'\d{6}', 'YYYYMM', s)
    return re.sub(r'\d+', 'N', s)


def probe_tree():
    head("A) Co všechno na opendata.chmi.cz vlastně je")
    for url in (f"{ROOT}/", f"{ROOT}/meteorology/"):
        r = get(url)
        print(f"  {url}: HTTP {r.status_code}")
        if r.ok:
            print(f"    {links(r.text)}")


def probe_ids(label, url, date_hint=None):
    """Počítá stanice BEZ předpokladu o prefixu WIGOS ID."""
    head(f"B) {label} — {url}")
    r = get(url)
    if not r.ok:
        print(f"  HTTP {r.status_code}")
        return
    ls = links(r.text)
    files = [l for l in ls if not l.endswith("/")]
    dirs = [l for l in ls if l.endswith("/")]
    print(f"  unikátních odkazů: {len(ls)} ({len(files)} souborů, {len(dirs)} adresářů)")

    shapes = Counter(shape(f) for f in files)
    print(f"  tvarů názvů: {len(shapes)}")
    for s, n in shapes.most_common(12):
        print(f"    {n:6d}×  {s}")

    # Prefix-agnostické ID: cokoli mezi prvním pomlčkovým blokem a datem.
    # Např. "10m-0-20000-0-11406-20260726.json" → "0-20000-0-11406"
    pat = re.compile(r'^(?:10m|1h|dly|mon)-(.+?)-(?:\d{8}|\d{6})\.json$')
    ids = set()
    prefixes = Counter()
    for f in files:
        m = pat.match(f)
        if m:
            sid = m.group(1)
            ids.add(sid)
            parts = sid.split("-")
            prefixes["-".join(parts[:3]) if len(parts) >= 4 else sid] += 1
    print(f"  unikátních ID stanic (bez ohledu na prefix): {len(ids)}")
    print(f"  podle prefixu WIGOS: {dict(prefixes.most_common(10))}")
    if ids:
        print(f"  ukázka ID: {sorted(ids)[:6]}")

    # Kolik souborů regexem z kol 1–4 (jen 0-20000-0) vs. celkem?
    old = {i for i in ids if i.startswith("0-20000-0-")}
    print(f"  z toho by starý regex uznal: {len(old)}  "
          f"→ NEVIDĚL BY: {len(ids) - len(old)}")


def probe_metadata_variants():
    head("C) now/metadata/ — meta1 známe, co je v meta2/3/4?")
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    yday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y%m%d")
    for n in (1, 2, 3, 4):
        for d in (today, yday):
            r = get(f"{BASE}/now/metadata/meta{n}-{d}.json")
            if not r.ok:
                continue
            try:
                j = r.json()
                data = j.get("data", {}).get("data", {})
                hdr = data.get("header") or data.get("columns")
                vals = data.get("values", [])
                print(f"  meta{n}-{d}: {len(vals)} řádků")
                print(f"    hlavička: {str(hdr)[:220]}")
                if vals:
                    print(f"    vzorek: {str(vals[0])[:220]}")
            except Exception as e:
                print(f"  meta{n}-{d}: parse chyba {e}")
            break


def main():
    print(f"Sonda kolo 8 — {datetime.now(timezone.utc).isoformat()}")
    for fn in (probe_tree, probe_metadata_variants):
        try:
            fn()
        except Exception as e:
            print(f"  !! {fn.__name__}: {e}", file=sys.stderr)
    for label, url in (("now/data", f"{BASE}/now/data/"),
                       ("recent/data/10min", f"{BASE}/recent/data/10min/"),
                       ("recent/data/1hour", f"{BASE}/recent/data/1hour/")):
        try:
            probe_ids(label, url)
        except Exception as e:
            print(f"  !! {label}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
