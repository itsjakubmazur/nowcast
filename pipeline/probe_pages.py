"""
Sonda: proč se nasazený web nemění, i když každý běh hlásí úspěšný deploy.

Pozorovaný stav: pipeline jede po pěti minutách, krok "Deploy to GitHub Pages"
hlásí "Reported success!", ale https://itsjakubmazur.github.io/nowcast/ dál
servíruje data z jednoho konkrétního okamžiku. Kontrolní workflow stale-check
to potvrdil z druhé strany (338 minut staré při zcela zdravé pipeline), takže
to není chyba appky ani prohlížeče.

Tenhle skript se ptá GitHubu na jeho vlastní pohled: co je zač poslední
deployment prostředí github-pages, jaké má stavy a co říká Pages API o stavu
webu. Běží z runneru, protože ze sandboxu není api.github.com ani github.io
dosažitelné.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

REPO = os.environ.get("GITHUB_REPOSITORY", "itsjakubmazur/nowcast")
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
SITE = "https://itsjakubmazur.github.io/nowcast"


def api(path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "nowcast-probe",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "nowcast-probe"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.headers, r.read()


def main():
    now = datetime.now(timezone.utc)
    print(f"=== Sonda GitHub Pages — {now.isoformat()} ===\n")

    print("--- co web opravdu servíruje ---")
    try:
        headers, body = get(f"{SITE}/data/radar_manifest.json")
        m = json.loads(body)
        gen = m.get("generated_at_utc")
        t = datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
        print(f"  generated_at_utc: {gen}")
        print(f"  stáří:            {int((now - t).total_seconds() // 60)} min")
        for h in ("age", "cache-control", "etag", "last-modified", "x-served-by",
                  "x-cache", "x-cache-hits", "x-timer", "server", "date"):
            if headers.get(h):
                print(f"  {h}: {headers[h]}")
    except Exception as e:
        print(f"  CHYBA: {e}")

    print("\n--- nastavení Pages ---")
    try:
        p = api("/pages")
        for k in ("status", "build_type", "source", "html_url", "public",
                  "protected_domain_state", "pending_domain_unverified_at"):
            if k in p:
                print(f"  {k}: {p[k]}")
    except Exception as e:
        print(f"  CHYBA: {e}")

    print("\n--- posledních 10 deploymentů prostředí github-pages ---")
    # Tady je jádro otázky: deployment se identifikuje verzí, kterou
    # actions/deploy-pages odvozuje z commit SHA. Když se repo nemění,
    # posílá každý běh tu samou verzi. Chceme vidět, jestli GitHub takové
    # deploymenty vůbec zakládá, nebo je zahazuje jako duplicitní.
    try:
        deps = api("/deployments?environment=github-pages&per_page=10")
        for d in deps:
            print(f"  id={d['id']}  {d['created_at']}  sha={d['sha'][:8]}  "
                  f"{d.get('description') or ''}")
        if deps:
            print("\n--- stavy nejnovějšího deploymentu ---")
            for s in api(f"/deployments/{deps[0]['id']}/statuses?per_page=10"):
                print(f"  {s['created_at']}  {s['state']}  "
                      f"{(s.get('description') or '')[:140]}")
                if s.get("environment_url"):
                    print(f"      {s['environment_url']}")
    except Exception as e:
        print(f"  CHYBA: {e}")

    print("\n--- světové stanice (METAR + bóje) ---")
    # Krok metar v pipeline trvá vteřinu, když zdroj selže, a vypadá to úplně
    # stejně jako když projde — dlaždice zůstanou staré. Jediné, co to opravdu
    # rozhodne, je obsah nasazených dlaždic.
    try:
        _, body = get(f"{SITE}/data/metar/index.json")
        idx = json.loads(body)
        print(f"  index: {idx.get('stations')} stanic, {len(idx.get('tiles') or [])} dlaždic, "
              f"generováno {idx.get('generated_at_utc')}")
        # Dlaždice 13_10 = severovýchod USA, kde je bójí nejvíc.
        _, tb = get(f"{SITE}/data/metar/13_10.json")
        tile = json.loads(tb)
        sts = tile.get("stations") or []
        buoys = [s for s in sts if s.get("source") == "ndbc"]
        print(f"  dlaždice 13_10: {len(sts)} stanic, z toho bójí {len(buoys)}")
        if buoys:
            b = buoys[0]
            print(f"    vzorek: {b['name']} {b['lat']},{b['lon']} {b['temp']} °C")
        else:
            print("    ✗ žádná bóje — krok metar buď neproběhl, nebo zdroj selhal")
    except Exception as e:
        print(f"  CHYBA: {str(e)[:160]}")

    print("\n--- Cloudflare worker ---")
    # Sonda v prohlížeči zachytila, že /verdict padá na CORS: "No
    # 'Access-Control-Allow-Origin' header". Náš kód CORS hlavičky posílá na
    # všech cestách včetně chybových, takže odpověď bez nich nepřišla z našeho
    # kódu, ale od Cloudflare (vyčerpaný limit, spadlý worker, 1101). Rozdíl
    # pozná jen syrová odpověď i s hlavičkami.
    for path in ("/cron-status",
                 "/verdict?lat=49.86&lon=18.36&label=Rychvald&radar=dry"):
        u = f"https://nowcast-narrate.kubajzek.workers.dev{path}"
        try:
            req = urllib.request.Request(u, headers={
                "User-Agent": "nowcast-probe",
                "Origin": "https://itsjakubmazur.github.io",
            })
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read(400).decode("utf-8", "replace")
                print(f"  {path.split('?')[0]}: HTTP {r.status}")
                print(f"    ACAO: {r.headers.get('access-control-allow-origin')}")
                print(f"    cf-ray: {r.headers.get('cf-ray')}  "
                      f"content-type: {r.headers.get('content-type')}")
                print(f"    tělo: {body[:300]}")
        except urllib.error.HTTPError as e:
            body = e.read(400).decode("utf-8", "replace")
            print(f"  {path.split('?')[0]}: HTTP {e.code}")
            print(f"    ACAO: {e.headers.get('access-control-allow-origin')}")
            print(f"    tělo: {body[:300]}")
        except Exception as e:
            print(f"  {path.split('?')[0]}: CHYBA {e}")

    print("\n--- pages/builds (starší API, ukáže i chybu buildu) ---")
    try:
        b = api("/pages/builds?per_page=5")
        if isinstance(b, dict):
            print(f"  {b}")
        else:
            for x in b:
                err = (x.get("error") or {}).get("message")
                print(f"  {x['created_at']}  {x['status']}  {err or ''}")
    except Exception as e:
        print(f"  CHYBA: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
