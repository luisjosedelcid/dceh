#!/usr/bin/env python3
"""
Generate DCE Holdings PWA icons.
Brand: navy #1B2642 background, gold #B88B47 monogram "DCE".
Outputs iOS-safe icons (iOS auto-rounds corners, so we keep square base).
"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

NAVY = (27, 38, 66)        # #1B2642
GOLD = (184, 139, 71)      # #B88B47
GOLD_DIM = (140, 105, 55)  # subtle inner ring

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

# Try system fonts likely to be available (Calibri unlikely on Linux, use classy serif/sans fallback)
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()

FONT_REG_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]

def load_font_reg(size):
    for path in FONT_REG_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()

def _fit_font(draw, text, target_h, loader):
    font_size = max(10, target_h)
    for _ in range(6):
        f = loader(font_size)
        bbox = draw.textbbox((0, 0), text, font=f)
        h = bbox[3] - bbox[1]
        if h == 0: break
        ratio = target_h / h
        if 0.95 <= ratio <= 1.05: break
        font_size = int(font_size * ratio)
    return loader(max(10, font_size))

def make_favicon(size, filename):
    """Tiny favicon: just DCE big and bold, no subtitle, no frame."""
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    draw = ImageDraw.Draw(img)
    text = "DCE"
    target_h = int(size * 0.55)
    font = _fit_font(draw, text, target_h, load_font)
    b = draw.textbbox((0, 0), text, font=font)
    tw, th = b[2] - b[0], b[3] - b[1]
    x = (size - tw) // 2 - b[0]
    y = (size - th) // 2 - b[1]
    draw.text((x, y), text, font=font, fill=GOLD)
    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({size}×{size}, favicon)")

def make_icon(size, filename, rounded=True, draw_frame=True):
    # Base square
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    draw = ImageDraw.Draw(img)

    if draw_frame:
        # Thin gold ring (frame) — proportional
        ring_pad = max(2, size // 22)
        ring_width = max(1, size // 90)
        draw.rectangle(
            [ring_pad, ring_pad, size - ring_pad - 1, size - ring_pad - 1],
            outline=GOLD, width=ring_width
        )

    # Big bold "DCE", slightly shifted up to leave room for HOLDINGS
    main = "DCE"
    main_h_target = int(size * 0.34)
    main_font = _fit_font(draw, main, main_h_target, load_font)
    mb = draw.textbbox((0, 0), main, font=main_font)
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]

    # "HOLDINGS" tracked-out, thin, small
    sub = "H O L D I N G S"
    sub_h_target = int(size * 0.06)
    sub_font = _fit_font(draw, sub, sub_h_target, load_font_reg)
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]

    gap = max(3, size // 32)
    total_h = mh + gap + sh
    y_start = (size - total_h) // 2

    # Draw DCE
    mx = (size - mw) // 2 - mb[0]
    my = y_start - mb[1]
    draw.text((mx, my), main, font=main_font, fill=GOLD)

    # Thin gold divider between DCE and HOLDINGS
    div_y = y_start + mh + gap // 2
    div_w = int(size * 0.30)
    div_thickness = max(1, size // 160)
    draw.rectangle(
        [(size - div_w) // 2, div_y - div_thickness // 2,
         (size + div_w) // 2, div_y + (div_thickness + 1) // 2],
        fill=GOLD
    )

    # Draw HOLDINGS
    sx = (size - sw) // 2 - sb[0]
    sy = y_start + mh + gap - sb[1]
    draw.text((sx, sy), sub, font=sub_font, fill=GOLD)

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({size}×{size})")

def make_maskable_icon(size, filename):
    """Maskable icon: content lives within the central 80% safe zone for adaptive masks."""
    img = Image.new("RGBA", (size, size), NAVY + (255,))
    draw = ImageDraw.Draw(img)
    inner = int(size * 0.80)

    main = "DCE"
    main_h_target = int(inner * 0.36)
    main_font = _fit_font(draw, main, main_h_target, load_font)
    mb = draw.textbbox((0, 0), main, font=main_font)
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]

    sub = "H O L D I N G S"
    sub_h_target = int(inner * 0.07)
    sub_font = _fit_font(draw, sub, sub_h_target, load_font_reg)
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]

    gap = max(3, size // 30)
    total_h = mh + gap + sh
    y_start = (size - total_h) // 2

    mx = (size - mw) // 2 - mb[0]
    my = y_start - mb[1]
    draw.text((mx, my), main, font=main_font, fill=GOLD)

    div_y = y_start + mh + gap // 2
    div_w = int(size * 0.28)
    div_thickness = max(1, size // 160)
    draw.rectangle(
        [(size - div_w) // 2, div_y - div_thickness // 2,
         (size + div_w) // 2, div_y + (div_thickness + 1) // 2],
        fill=GOLD
    )

    sx = (size - sw) // 2 - sb[0]
    sy = y_start + mh + gap - sb[1]
    draw.text((sx, sy), sub, font=sub_font, fill=GOLD)

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({size}×{size}, maskable)")

print("Generating DCE PWA icons…")
# iOS apple-touch-icon (Home Screen)
make_icon(180, "apple-touch-icon.png")
# Standard PWA / manifest icons
make_icon(192, "icon-192.png")
make_icon(512, "icon-512.png")
# Maskable for Android adaptive
make_maskable_icon(512, "icon-maskable-512.png")
# Favicon fallbacks — too small for HOLDINGS subtitle, only render DCE bold
make_favicon(32, "favicon-32.png")
make_favicon(16, "favicon-16.png")
print("Done.")
