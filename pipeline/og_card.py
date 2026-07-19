"""
OG sdílecí karta (1200×630) — to, co se zobrazí při poslání odkazu v iMessage,
WhatsApp, Slacku atd. Vlevo brand + hook + feature chipy, vpravo živý radarový
snímek v zaobleném "okně" s chipem ŽIVĚ a časem. Kreslí se 2× supersamplovaně
a downscaluje LANCZOSem, ať jsou hrany a text ostré i po zmenšení náhledu.

Průhledné prvky se kreslí na oddělené overlay vrstvy skládané přes
Image.alpha_composite — ImageDraw totiž alfu nemíchá, ale zapisuje, takže
polopropustný tvar kreslený přímo do podkladu by vyšel plnou barvou.

Font: Figtree (variabilní, assets/fonts/Figtree.ttf, licence SIL OFL) —
stejný brand font jako na webu; fallback DejaVu Sans, kdyby soubor chyběl.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ── Rozměry a barvy ──────────────────────────────────────────────────────────
W, H = 1200, 630
S = 2  # supersampling

BG_TOP     = (6, 10, 20)
BG_BOTTOM  = (15, 24, 48)
ACCENT     = (10, 132, 255)    # #0A84FF — stejný jako --accent na webu
ACCENT2    = (191, 90, 242)    # #BF5AF2
LIVE_RED   = (255, 69, 58)
TEXT       = (243, 246, 252)
TEXT_MUTED = (167, 180, 208)
TEXT_DIM   = (108, 130, 174)
CARD_BG    = (10, 17, 32)

_FONT_PATH = Path(__file__).parent.parent / "assets" / "fonts" / "Figtree.ttf"
_DEJAVU    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _font(size_pt: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    """Inter v dané váze (variabilní osa wght); fallback DejaVu Bold."""
    size = size_pt * S
    try:
        f = ImageFont.truetype(str(_FONT_PATH), size)
        f.set_variation_by_axes([weight])
        return f
    except OSError:
        try:
            return ImageFont.truetype(_DEJAVU, size)
        except OSError:
            return ImageFont.load_default(size=size)


def _overlay(base: Image.Image):
    """Nová průhledná vrstva + její ImageDraw; složí se přes _merge()."""
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    return ov, ImageDraw.Draw(ov)


def _rr(draw: ImageDraw.ImageDraw, box, radius: int, **kw) -> None:
    draw.rounded_rectangle(box, radius=radius * S, **kw)


def _bg_gradient() -> Image.Image:
    """Diagonální tmavý gradient pozadí (přes malý obrázek + resize = plynulé)."""
    g = Image.new("RGB", (64, 64))
    px = g.load()
    for y in range(64):
        for x in range(64):
            t = (x + y * 1.6) / (64 + 64 * 1.6)
            px[x, y] = tuple(
                int(BG_TOP[c] + (BG_BOTTOM[c] - BG_TOP[c]) * t) for c in range(3)
            )
    return g.resize((W * S, H * S), Image.Resampling.BILINEAR)


def _radial_glow(size: int, color, peak_alpha: int) -> Image.Image:
    """Kruhová záře s kvadratickým spádem alfy do ztracena."""
    glow = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(glow)
    steps = 48
    for i in range(steps, 0, -1):
        r = size // 2 * i / steps
        a = int(peak_alpha * (1 - i / steps) ** 2)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=a)
    out = Image.new("RGBA", (size, size), (*color, 0))
    out.putalpha(glow)
    return out


def _bolt(draw: ImageDraw.ImageDraw, box) -> None:
    """Blesk (glyf) do zadaného boxu — kreslený polygon, žádné emoji fonty."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    pts = [(0.58, 0.08), (0.22, 0.56), (0.46, 0.56),
           (0.40, 0.92), (0.78, 0.42), (0.52, 0.42)]
    draw.polygon([(x0 + px * w, y0 + py * h) for px, py in pts],
                 fill=(255, 255, 255, 255))


def _chip(draw: ImageDraw.ImageDraw, x: int, y: int, label: str, dot,
          font: ImageFont.FreeTypeFont) -> int:
    """Pill s barevnou tečkou; vrací x pravého okraje (pro řazení do řádku)."""
    pad_x, chip_h, dot_r, gap = 18 * S, 46 * S, 5 * S, 10 * S
    tw = draw.textlength(label, font=font)
    wpx = int(pad_x * 2 + dot_r * 2 + gap + tw)
    _rr(draw, [x, y, x + wpx, y + chip_h], 23,
        fill=(255, 255, 255, 16), outline=(255, 255, 255, 40), width=S)
    cy = y + chip_h // 2
    draw.ellipse([x + pad_x, cy - dot_r, x + pad_x + dot_r * 2, cy + dot_r],
                 fill=(*dot, 255))
    draw.text((x + pad_x + dot_r * 2 + gap, cy), label, font=font,
              fill=(214, 222, 240, 255), anchor="lm")
    return x + wpx


def build_card(radar: Image.Image | None, time_label: str) -> Image.Image:
    """Sestaví OG kartu. `radar` = RGBA snímek radaru (průhledné pozadí) nebo
    None (vykreslí se jen brand strana); `time_label` = lokální čas snímku."""
    base = _bg_gradient().convert("RGBA")

    # Karta radaru vpravo — geometrie potřebná i pro pozadí (záře, prstence)
    cx0, cy0, cx1, cy1 = 628 * S, 78 * S, 1136 * S, 552 * S
    ccx, ccy = (cx0 + cx1) // 2, (cy0 + cy1) // 2

    # Záře: modrá za radarem, fialová v levém dolním rohu
    glow = _radial_glow(1150 * S, ACCENT, 52)
    base.alpha_composite(glow, (ccx - glow.width // 2, ccy - glow.height // 2))
    glow2 = _radial_glow(700 * S, ACCENT2, 26)
    base.alpha_composite(glow2, (-220 * S, H * S - 380 * S))

    # Jemné radarové prstence kolem středu karty (vlastní vrstva kvůli alfě)
    ov, d = _overlay(base)
    for r in range(150, 700, 130):
        rr = r * S
        d.ellipse([ccx - rr, ccy - rr, ccx + rr, ccy + rr],
                  outline=(255, 255, 255, 22), width=S)
    base.alpha_composite(ov)

    # ── Radarové "okno" ──────────────────────────────────────────────────────
    ov, d = _overlay(base)
    _rr(d, [cx0, cy0, cx1, cy1], 26, fill=(*CARD_BG, 255),
        outline=(255, 255, 255, 56), width=2 * S)
    base.alpha_composite(ov)

    inset = 10 * S
    ix0, iy0, ix1, iy1 = cx0 + inset, cy0 + inset, cx1 - inset, cy1 - inset
    inner = Image.new("RGBA", (ix1 - ix0, iy1 - iy0), (8, 13, 25, 255))
    idraw = ImageDraw.Draw(inner)
    # decentní mapová mřížka pod radarem — opakní tmavě šedomodrá (kreslí se
    # přímo do opakního podkladu, takže žádná alfa)
    step = 47 * S
    grid_col = (20, 28, 46, 255)
    for gx in range(step, inner.width, step):
        idraw.line([(gx, 0), (gx, inner.height)], fill=grid_col, width=S)
    for gy in range(step, inner.height, step):
        idraw.line([(0, gy), (inner.width, gy)], fill=grid_col, width=S)

    if radar is not None:
        r = radar.convert("RGBA")
        scale = min(inner.width / r.width, inner.height / r.height)
        rw, rh = int(r.width * scale), int(r.height * scale)
        r = r.resize((rw, rh), Image.Resampling.BILINEAR)
        inner.alpha_composite(r, ((inner.width - rw) // 2, (inner.height - rh) // 2))

    mask = Image.new("L", inner.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner.width, inner.height],
                                           radius=20 * S, fill=255)
    base.paste(inner.convert("RGB"), (ix0, iy0), mask)

    # ── Chipy v okně + levý sloupec (společná overlay vrstva) ───────────────
    ov, d = _overlay(base)

    # Chip ŽIVĚ (nahoře vlevo v okně)
    f_chip = _font(21, 650)
    lx, ly = cx0 + 18 * S, cy0 + 18 * S
    lw = int(d.textlength("ŽIVĚ", font=f_chip)) + 46 * S
    _rr(d, [lx, ly, lx + lw, ly + 40 * S], 20,
        fill=(8, 12, 22, 210), outline=(*LIVE_RED, 150), width=S)
    d.ellipse([lx + 15 * S, ly + 15 * S, lx + 25 * S, ly + 25 * S],
              fill=(*LIVE_RED, 255))
    d.text((lx + 33 * S, ly + 20 * S), "ŽIVĚ", font=f_chip,
           fill=(*TEXT, 255), anchor="lm")

    # Chip s časem (dole vpravo v okně)
    f_time = _font(21, 500)
    tlabel = f"radar {time_label}"
    tw = int(d.textlength(tlabel, font=f_time))
    tx1, ty1 = cx1 - 18 * S, cy1 - 18 * S
    _rr(d, [tx1 - tw - 32 * S, ty1 - 40 * S, tx1, ty1], 20,
        fill=(8, 12, 22, 210), outline=(255, 255, 255, 44), width=S)
    d.text((tx1 - 16 * S, ty1 - 20 * S), tlabel, font=f_time,
           fill=(191, 214, 250, 255), anchor="rm")

    # Levý sloupec: logo + wordmark
    x = 72 * S
    ly0, lsz = 118 * S, 92 * S
    logo = Image.new("RGBA", (lsz, lsz))
    lpx = logo.load()
    for yy in range(lsz):
        for xx in range(0, lsz, 4):
            t = (xx + yy) / (2 * lsz)
            c = tuple(int(ACCENT[i] + (ACCENT2[i] - ACCENT[i]) * t) for i in range(3))
            for dx in range(4):
                if xx + dx < lsz:
                    lpx[xx + dx, yy] = (*c, 255)
    lmask = Image.new("L", (lsz, lsz), 0)
    ImageDraw.Draw(lmask).rounded_rectangle([0, 0, lsz, lsz], radius=24 * S, fill=255)
    logo.putalpha(lmask)
    ov.alpha_composite(logo, (x, ly0))
    _bolt(d, [x + 22 * S, ly0 + 16 * S, x + lsz - 22 * S, ly0 + lsz - 16 * S])

    f_brand = _font(66, 800)
    bx = x + lsz + 26 * S
    bcy = ly0 + lsz // 2
    d.text((bx, bcy), "nowcast", font=f_brand, fill=(*TEXT, 255), anchor="lm")
    wm_end = bx + d.textlength("nowcast", font=f_brand)
    dot_r = 7 * S
    d.ellipse([wm_end + 8 * S, bcy + 18 * S - dot_r,
               wm_end + 8 * S + dot_r * 2, bcy + 18 * S + dot_r],
              fill=(*ACCENT, 255))

    # Hook + podtitulek
    f_h = _font(44, 700)
    d.text((x, 288 * S), "Kdy přesně začne pršet?", font=f_h, fill=(*TEXT, 255))
    f_sub = _font(25, 450)
    d.text((x, 356 * S), "Živý radar, 2h nowcast a AI meteorolog", font=f_sub,
           fill=(*TEXT_MUTED, 255))
    d.text((x, 392 * S), "kamkoli na světě. Doma na minuty přesně.", font=f_sub,
           fill=(*TEXT_MUTED, 255))

    # Feature chipy
    f_c = _font(23, 550)
    cxp = x
    cyp = 452 * S
    cxp = _chip(d, cxp, cyp, "Radar ČHMÚ", (55, 214, 122), f_c) + 12 * S
    cxp = _chip(d, cxp, cyp, "+2 h nowcast", ACCENT, f_c) + 12 * S
    _chip(d, cxp, cyp, "AI verdikt", ACCENT2, f_c)

    # URL
    f_url = _font(22, 500)
    d.text((x, 556 * S), "itsjakubmazur.github.io/nowcast", font=f_url,
           fill=(*TEXT_DIM, 255))

    base.alpha_composite(ov)
    return base.convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
