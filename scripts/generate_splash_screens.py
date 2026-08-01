#!/usr/bin/env python3
"""
Generate iOS launch (splash) screens for DCE Holdings PWA.
Each iPhone class needs a specific portrait resolution.
Design: navy background, DCE wordmark centered (white DCE + gold Holdings).
"""
from PIL import Image, ImageDraw, ImageFont
import os

NAVY = (27, 38, 66)
GOLD = (184, 139, 71)
WHITE = (255, 255, 255)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "splash")
os.makedirs(OUT_DIR, exist_ok=True)

FONT_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
FONT_LIGHT = [
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-Light.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Light.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

def _load(paths, size):
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def _fit(draw, text, target_h, loader, max_width=None):
    fs = max(10, target_h)
    for _ in range(8):
        f = loader(fs)
        b = draw.textbbox((0, 0), text, font=f)
        h, w = b[3] - b[1], b[2] - b[0]
        if h == 0: break
        r_h = target_h / h
        r_w = (max_width / w) if (max_width and w > 0) else float('inf')
        r = min(r_h, r_w)
        if 0.95 <= r <= 1.05: break
        fs = int(fs * r)
    return loader(max(10, fs))

# (width, height, filename, iOS media query)
DEVICES = [
    # iPhone 15 Pro Max, 14 Pro Max, 15 Plus, 14 Plus (430x932 @3x)
    (1290, 2796, "iphone-6.7.png",
     "screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 15 Pro, 15, 14 Pro (393x852 @3x)
    (1179, 2556, "iphone-6.1.png",
     "screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 14, 13, 12, 12 Pro (390x844 @3x)
    (1170, 2532, "iphone-6.1-14.png",
     "screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 13 Pro Max, 12 Pro Max (428x926 @3x)
    (1284, 2778, "iphone-6.7-13pm.png",
     "screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 13 mini, 12 mini (375x812 @3x)
    (1125, 2436, "iphone-mini.png",
     "screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 11 Pro Max, XS Max (414x896 @3x)
    (1242, 2688, "iphone-xsmax.png",
     "screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"),
    # iPhone 11, XR (414x896 @2x)
    (828, 1792, "iphone-11.png",
     "screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"),
    # iPhone SE 3/2, 8, 7, 6s (375x667 @2x)
    (750, 1334, "iphone-se.png",
     "screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"),
]

def make_splash(w, h, filename):
    img = Image.new("RGBA", (w, h), NAVY + (255,))
    draw = ImageDraw.Draw(img)

    # Wordmark scale relative to smaller dimension
    s = min(w, h)
    main = "DCE"
    sub  = "Holdings"

    main_font = _fit(draw, main, int(s * 0.16), lambda sz: _load(FONT_BOLD, sz), max_width=int(w * 0.55))
    mb = draw.textbbox((0, 0), main, font=main_font)
    mw, mh = mb[2] - mb[0], mb[3] - mb[1]

    sub_font  = _fit(draw, sub,  int(s * 0.115), lambda sz: _load(FONT_LIGHT, sz), max_width=int(w * 0.65))
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]

    gap = int(s * 0.02)
    total_h = mh + gap + sh
    y_start = int((h - total_h) * 0.48)

    mx = (w - mw) // 2 - mb[0]
    my = y_start - mb[1]
    draw.text((mx, my), main, font=main_font, fill=WHITE)

    sx = (w - sw) // 2 - sb[0]
    sy = y_start + mh + gap - sb[1]
    draw.text((sx, sy), sub, font=sub_font, fill=GOLD)

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    print(f"  → {filename} ({w}×{h})")

print("Generating iOS splash screens…")
for w, h, fn, _ in DEVICES:
    make_splash(w, h, fn)

# Emit HTML snippet for injection
print("\nHTML links (to be added to <head>):")
lines = []
for w, h, fn, media in DEVICES:
    lines.append(f'<link rel="apple-touch-startup-image" href="/splash/{fn}?v=1" media="{media}">')
snippet = "\n".join(lines)
snippet_file = os.path.join(os.path.dirname(__file__), "..", "public", "splash", "_links.html")
open(snippet_file, "w").write(snippet + "\n")
print(f"Wrote {len(lines)} link tags to {snippet_file}")
