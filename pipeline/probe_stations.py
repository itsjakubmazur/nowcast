"""Sonda 7: co znamená první číslo u VKH/KKH v aerologickém výpisu.

Předpoklad "km" neplatí: Praha měla VKH 2,500 při 700 hPa (~3 km, zhruba sedí),
ale Prostějov 10,500 při 804 hPa — a 804 hPa je asi 1,9 km. Místo hádání
čteme oficiální popis radiosondáže (PDF v adresáři) přes pdftotext.
"""
import re
import subprocess
import tempfile
from pathlib import Path
import requests

UA = {"User-Agent": "Mozilla/5.0 (compatible; NowcastBot/1.0)"}
T = (15, 90)
ROOT = "https://opendata.chmi.cz"
PDF = f"{ROOT}/meteorology/weather/radiosounding/radiosondaz_popis_cz_1.0.pdf"


def main():
    r = requests.get(PDF, headers=UA, timeout=T)
    print(f"PDF: HTTP {r.status_code}, {len(r.content)} B")
    if not r.ok:
        return

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "popis.pdf"
        p.write_bytes(r.content)
        txt = subprocess.run(["pdftotext", "-layout", str(p), "-"],
                             capture_output=True, text=True).stdout

    print(f"text: {len(txt)} znaků\n")

    # Vytiskni okolí každé zkratky, která nás zajímá.
    for token in ("VKH", "KKH", "CAPE", "CINH", "DCI", "Tkonv", "vypis", "výpis"):
        print(f"=== {token} ===")
        found = False
        for m in re.finditer(re.escape(token), txt, re.IGNORECASE):
            found = True
            s = max(0, m.start() - 320)
            frag = txt[s:m.end() + 320].replace("\n", " ⏎ ")
            frag = re.sub(r"\s+", " ", frag)
            print(f"  …{frag}…\n")
            break   # stačí první výskyt na token
        if not found:
            print("  (nenalezeno)\n")

    # Hledej explicitně jednotky u hladin
    print("=== řádky se 'hladin' ===")
    for line in txt.splitlines():
        if re.search(r"hladin", line, re.IGNORECASE):
            print(f"  | {line.strip()[:200]}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
