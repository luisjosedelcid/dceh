#!/usr/bin/env python3
"""
Idempotently inject PWA meta tags + service worker registration into every /public/*.html.
Wraps injection with markers <!--PWA:START--> / <!--PWA:END--> so re-running replaces cleanly.
"""
import os, re, sys, glob

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "..", "public")

START = "<!--PWA:START-->"
END   = "<!--PWA:END-->"

BLOCK = f"""{START}
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<meta name="theme-color" content="#1B2642">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="DCE">
<meta name="application-name" content="DCE Holdings">
<meta name="format-detection" content="telephone=no">
<script>
  if ('serviceWorker' in navigator) {{
    window.addEventListener('load', () => {{
      navigator.serviceWorker.register('/sw.js', {{ scope: '/' }}).catch(() => {{}});
    }});
  }}
</script>
{END}"""

BLOCK_RE = re.compile(re.escape(START) + r".*?" + re.escape(END), re.DOTALL)

def inject(path):
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()

    # Skip files without <head>
    if "</head>" not in html.lower():
        return False, "no-head"

    if BLOCK_RE.search(html):
        new = BLOCK_RE.sub(BLOCK, html)
        action = "updated"
    else:
        # Insert just before </head> (case-insensitive)
        m = re.search(r"</head>", html, re.IGNORECASE)
        if not m:
            return False, "no-head-close"
        new = html[:m.start()] + BLOCK + "\n" + html[m.start():]
        action = "inserted"

    if new != html:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        return True, action
    return False, "unchanged"

def main():
    files = sorted(glob.glob(os.path.join(PUBLIC_DIR, "*.html")))
    for p in files:
        changed, action = inject(p)
        flag = "✔" if changed else "·"
        print(f"  {flag} {os.path.basename(p):40s} {action}")
    print(f"Processed {len(files)} files.")

if __name__ == "__main__":
    main()
