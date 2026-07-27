"""Sonda 10: proč u Rychvaldu chybí ALADIN a hlásí se "žádná stanice do 40 km".

Obojí ukazuje na nasazená data, ne na kód:
  - ALADIN se do žebříčku dostane jen když data/aladin.json existuje, běh není
    starší 18 h a nejbližší bod mřížky je do ~30 km
  - "žádná čerstvá stanice" znamená, že v chmi_stations.json není ani jedna
    stanice do 40 km s měřením mladším 120 min

Sonda se ptá přímo nasazeného webu, aby se to dalo oddělit.
Plus stav cronu workeru (diagnostika push).
"""
import json
import math
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 60)
PAGES = "https://itsjakubmazur.github.io/nowcast/data"
WORKER = "https://nowcast-narrate.kubajzek.workers.dev"

# Rychvald — místo ze screenshotu
LAT, LON = 49.86, 18.36


def km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def age_min(iso, now):
    if not iso:
        return None
    try:
        return (now - datetime.fromisoformat(str(iso).replace("Z", "+00:00"))).total_seconds() / 60
    except Exception:
        return None


def fetch(name):
    try:
        r = requests.get(f"{PAGES}/{name}", headers=UA, timeout=T)
        if not r.ok:
            print(f"  ✗ {name}: HTTP {r.status_code}")
            return None
        print(f"  ✓ {name}: {len(r.content) / 1024:.1f} kB")
        return r.json()
    except Exception as e:
        print(f"  ✗ {name}: {str(e)[:150]}")
        return None


def main():
    now = datetime.now(timezone.utc)
    print(f"Sonda 10 — {now.isoformat()}")
    print(f"Testovací místo: Rychvald {LAT}, {LON}\n")

    print("=== soubory ===")
    chmi = fetch("chmi_stations.json")
    aladin = fetch("aladin.json")
    metar = fetch("metar_stations.json")

    print("\n=== stanice ČHMÚ do 40 km ===")
    if chmi:
        sts = chmi.get("stations") or []
        gen = age_min(chmi.get("generated_at_utc"), now)
        print(f"  celkem {len(sts)} stanic, soubor starý {gen:.0f} min"
              if gen is not None else f"  celkem {len(sts)} stanic")
        near = []
        for s in sts:
            if s.get("lat") is None or s.get("temp") is None:
                continue
            d = km(LAT, LON, s["lat"], s["lon"])
            if d <= 40:
                near.append((d, s))
        near.sort(key=lambda x: x[0])
        print(f"  do 40 km s teplotou: {len(near)}")
        fresh = 0
        for d, s in near[:8]:
            a = age_min(s.get("time_utc"), now)
            ok = a is not None and a <= 120
            fresh += ok
            print(f"    {d:5.1f} km  {s.get('name','?')[:28]:28s} "
                  f"{s.get('temp')} °C  stáří {a:.0f} min" if a is not None
                  else f"    {d:5.1f} km  {s.get('name','?')[:28]:28s} bez času")
            if a is not None and a > 120:
                print("           ↑ STARŠÍ NEŽ 120 min → appka ji nepoužije")
        n_fresh = sum(1 for d, s in near
                      if (age_min(s.get("time_utc"), now) or 1e9) <= 120)
        print(f"  → čerstvých (≤120 min): {n_fresh}")
        if n_fresh == 0:
            print("    ✗ TOHLE je důvod hlášky 'žádná čerstvě hlásící stanice'")

    print("\n=== METAR do 40 km (záložní zdroj) ===")
    if metar:
        sts = metar.get("stations") or []
        near = sorted(
            ((km(LAT, LON, s["lat"], s["lon"]), s) for s in sts
             if s.get("lat") is not None and s.get("temp") is not None),
            key=lambda x: x[0])[:3]
        for d, s in near:
            a = age_min(s.get("time_utc"), now)
            print(f"    {d:5.1f} km  {s.get('name','?')[:28]:28s} {s.get('temp')} °C  "
                  f"stáří {a:.0f} min" if a is not None else f"    {d:5.1f} km  bez času")

    print("\n=== ALADIN ===")
    if aladin:
        run = age_min(aladin.get("run_utc"), now)
        pts = aladin.get("pts") or []
        print(f"  běh {aladin.get('run_utc')} → starý {run:.0f} min "
              f"({run/60:.1f} h)" if run is not None else "  bez run_utc")
        print(f"  bodů mřížky: {len(pts)}")
        if run is not None and run > 18 * 60:
            print("    ✗ starší než 18 h → appka ALADIN ZAHODÍ (limit v loadAladin)")
        if pts:
            best, bd = None, 1e9
            for i, pt in enumerate(pts):
                d = km(LAT, LON, pt[0], pt[1])
                if d < bd:
                    bd, best = d, i
            print(f"  nejbližší bod: index {best}, {bd:.1f} km "
                  f"({pts[best][0]}, {pts[best][1]})")
            if bd > 33:
                print("    ✗ dál než ~30 km → aladinSeries vrátí null")
            has_t = str(best) in (aladin.get("temp") or {})
            print(f"  má ten bod teplotní řadu? {'ANO' if has_t else 'NE ✗'}")
            if has_t:
                print(f"    délka řady: {len(aladin['temp'][str(best)])} hodin")
    else:
        print("  ✗ aladin.json vůbec nedorazil → ALADIN nemůže být v žebříčku")

    print("\n=== cron workeru (push) ===")
    try:
        r = requests.get(f"{WORKER}/cron-status", headers=UA, timeout=T)
        print(f"  HTTP {r.status_code}")
        if r.status_code == 404:
            print("  → endpoint chybí = nasazený worker je starší než tenhle commit")
        elif r.ok:
            st = r.json()
            print(json.dumps(st, ensure_ascii=False, indent=2))
            if st.get("lastRunUtc") is None:
                print("  ✗ cron nikdy neproběhl")
            else:
                print(f"  ✓ cron běžel před {st.get('lastRunAgeMin')} min, "
                      f"odběratelů {st.get('subscribers')}, "
                      f"naposledy poslal {st.get('lastNotified')}")
            ss = st.get("lastSendStatus")
            if ss is None:
                print("  poslední odeslání: žádné (u oblíbených míst nebylo co hlásit)")
            elif ss == 201:
                print("  ✓ poslední odeslání přijato push službou (201)")
            elif ss in (401, 403):
                print(f"  ✗ {ss} — VAPID_PRIVATE_KEY nesedí nebo chybí")
            else:
                print(f"  ? poslední odeslání HTTP {ss}")
    except Exception as e:
        print(f"  CHYBA {str(e)[:200]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
