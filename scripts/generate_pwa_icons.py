#!/usr/bin/env python3
"""
DCE Holdings PWA icons — match brandbook wordmark.
Sans-serif, DCE white bold, Holdings gold light, stacked, no frame.
"""
from PIL import Image, ImageDraw, ImageFont
import os

NAVY = (27, 38, 66)        # #1B2642
GOLD = (184, 139, 71)      # #B88B47
WHITE = (255, 255, 255)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

FONT_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]
FONT_LIGHT = [
    # Noto Sans Display Light is close to the light weight in the reference
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-Light.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Light.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]

def _load(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def load_bold(size):  return _load(FONT_BOLD, size)
def load_light(size): return _load(FONT_LIGHT, size)

def _fit(draw, text, target_h, loader, max_width=None):
    fs = max(10, target_h)
    for _ in range(8):
        f = loader(fs)
        b = draw.textbbox((0, 0), text, font=f)
        h = b[3] - b[1]
        w = b[2] - b[0]
        if h == 0: break
        r_h = target_h / h
        r_w = (max_width / w) if (max_width and w > 0) else float('inf')
        r = min(r_h, r_w)
        if 0.95 <= r <= 1.05: break
        fs = int(fs * r)
    return loader(max(10, fs))

def make_icon(size, filename, with_subtitle=True):
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    draw = ImageDraw.Draw(img)

    if with_subtitle:
        # Reference: "DCE" white bold big, "Holdings" gold light same visual size below
        main = "DCE"
        sub  = "Holdings"

        # DCE — target ~28% icon height, width ≤ 68%
        main_font = _fit(draw, main, int(size * 0.28), load_bold, max_width=int(size * 0.68))
        mb = draw.textbbox((0, 0), main, font=main_font)
        mw, mh = mb[2] - mb[0], mb[3] - mb[1]

        # Holdings — target similar cap-height to DCE (~28% icon height too), width ≤ 82%
        sub_font  = _fit(draw, sub,  int(size * 0.20), load_light, max_width=int(size * 0.82))
        sb = draw.textbbox((0, 0), sub, font=sub_font)
        sw, sh = sb[2] - sb[0], sb[3] - sb[1]

        gap = max(2, size // 40)
        total_h = mh + gap + sh
        y_start = int((size - total_h) * 0.48)  # bias slightly upward for optical center

        # DCE white
        mx = (size - mw) // 2 - mb[0]
        my = y_start - mb[1]
        draw.text((mx, my), main, font=main_font, fill=WHITE)

        # Holdings gold
        sx = (size - sw) // 2 - sb[0]
        sy = y_start + mh + gap - sb[1]
        draw.text((sx, sy), sub, font=sub_font, fill=GOLD)
    else:
        # Favicon fallback — bare DCE white on navy
        main = "DCE"
        main_font = _fit(draw, main, int(size * 0.58), load_bold, max_width=int(size * 0.82))
        mb = draw.textbbox((0, 0), main, font=main_font)
        mw, mh = mb[2] - mb[0], mb[3] - mb[1]
        mx = (size - mw) // 2 - mb[0]
        my = (size - mh) // 2 - mb[1]
        draw.text((mx, my), main, font=main_font, fill=WHITE)

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({size}×{size})")

def make_maskable(size, filename):
    """Content within central 80% safe zone."""
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    draw = ImageDraw.Draw(img)
    inner = int(size * 0.80)

    main = "DCE"
    sub  = "Holdings"

    main_font = _fit(draw, main, int(inner * 0.32), load_bold, max_width=int(inner * 0.78))
    mb = draw.textbbox((0, 0), main, font=main_font)
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]

    sub_font  = _fit(draw, sub,  int(inner * 0.23), load_light, max_width=int(inner * 0.92))
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]

    gap = max(2, size // 40)
    total_h = mh + gap + sh
    y_start = int((size - total_h) * 0.48)

    mx = (size - mw) // 2 - mb[0]
    my = y_start - mb[1]
    draw.text((mx, my), main, font=main_font, fill=WHITE)

    sx = (size - sw) // 2 - sb[0]
    sy = y_start + mh + gap - sb[1]
    draw.text((sx, sy), sub, font=sub_font, fill=GOLD)

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({size}×{size}, maskable)")

print("Generating DCE PWA icons (brandbook wordmark style)…")
make_icon(180, "apple-touch-icon.png", with_subtitle=True)
make_icon(192, "icon-192.png", with_subtitle=True)
make_icon(512, "icon-512.png", with_subtitle=True)
make_maskable(512, "icon-maskable-512.png")
make_icon(32, "favicon-32.png", with_subtitle=False)
make_icon(16, "favicon-16.png", with_subtitle=False)
print("Done.")
