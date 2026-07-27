"""Sonda 9: běží cron Cloudflare workeru a doručuje push?

Diagnostika hlásí "upozornění aktivní", takže server registraci má — problém
je tedy dál v řetězu. Tahle sonda se ptá workeru zvenku:
  - je vůbec nasazený (odpoví /vapid-public-key)?
  - běžel někdy cron a kdy naposledy?
  - kolik má odběratelů a kolik jim naposledy poslal?
  - s jakým HTTP stavem skončilo poslední odeslání?

Rozliší to tři úplně jiné příčiny, které zvenku vypadají stejně:
  cron neběží · cron běží, ale nemá co poslat · posílá, ale push služba odmítá
"""
import json
from datetime import datetime, timezone
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 60)
# Musí sedět s WORKER_BASE ve web/js/state.js — jiná subdoména
# by vrátila 404 a vypadalo by to, že worker není nasazený.
WORKER = "https://nowcast-narrate.kubajzek.workers.dev"


def get(path):
    try:
        r = requests.get(f"{WORKER}{path}", headers=UA, timeout=T)
        return r.status_code, r.text[:2000]
    except Exception as e:
        return None, f"CHYBA {str(e)[:200]}"


def main():
    print(f"Sonda 9 — {datetime.now(timezone.utc).isoformat()}")
    print(f"Worker: {WORKER}\n")

    print("=== je worker nasazený? ===")
    code, body = get("/vapid-public-key")
    print(f"  /vapid-public-key: HTTP {code}")
    print(f"    {body[:200]}")
    if code != 200:
        print("  → worker neodpovídá; cron ani push nemůžou fungovat")

    print("\n=== stav cronu ===")
    code, body = get("/cron-status")
    print(f"  /cron-status: HTTP {code}")
    if code == 404:
        print("  → endpoint neexistuje = nasazená verze workeru je STARŠÍ")
        print("     než tenhle commit. Deploy workeru neproběhl.")
        return
    if code != 200:
        print(f"    {body[:400]}")
        return

    try:
        st = json.loads(body)
    except Exception:
        print(f"    nečitelná odpověď: {body[:300]}")
        return

    print(json.dumps(st, ensure_ascii=False, indent=2))

    print("\n=== čtení ===")
    age = st.get("lastRunAgeMin")
    if st.get("lastRunUtc") is None:
        print("  ✗ cron NIKDY neproběhl → trigger se nespouští")
        print("     (Cloudflare cron triggery jsou na free plánu, ale musí být")
        print("      nasazené přes wrangler s [triggers] crons — zkontroluj deploy)")
    elif age is not None and age > 30:
        print(f"  ✗ poslední běh před {age} min → cron se zastavil")
    else:
        print(f"  ✓ cron běžel před {age} min")

    subs = st.get("subscribers")
    print(f"  odběratelů v KV: {subs}")
    if subs == 0:
        print("     ✗ nula → registrace se neuložila (a diagnostika lže)")

    ss = st.get("lastSendStatus")
    if ss is None:
        print("  poslední odeslání: ŽÁDNÉ — cron nikdy neměl co poslat")
        print("     (to je normální, když u oblíbených míst neprší)")
    elif ss == 201:
        print("  ✓ poslední odeslání: 201 = push služba ho přijala")
        print("     → pokud přesto nic nedorazilo, je to na straně zařízení")
    elif ss in (401, 403):
        print(f"  ✗ poslední odeslání: {ss} = VAPID podpis odmítnut")
        print("     → chybí nebo nesedí VAPID_PRIVATE_KEY jako secret workeru")
    elif ss == 410:
        print("  ✗ poslední odeslání: 410 = odběr vypršel, je potřeba obnovit")
    else:
        print(f"  ? poslední odeslání: HTTP {ss}")

    if st.get("lastError"):
        print(f"  ✗ poslední chyba cronu: {st['lastError']}")
    if not st.get("vapidConfigured"):
        print("  ✗ VAPID_PUBLIC_KEY není ve workeru nastavený")

    print("\n=== sdílené učení (nové endpointy) ===")
    code, body = get("/model-scores?lat=50.08&lon=14.42")
    print(f"  /model-scores: HTTP {code}")
    print(f"    {body[:300]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
