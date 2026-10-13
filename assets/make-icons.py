#!/usr/bin/env python3
"""Render the favicon PNGs and the share image from the contour shell inlined in redeem/index.html.
Run from the site root: python3 assets/make-icons.py (CairoSVG 2.9.0, ImageMagick 6.9.11-60, OptiPNG 0.7.7)."""
import re
import subprocess
import cairosvg

BG, INK, MUTED, ACCENT = "#0b1012", "#f3f0e7", "#b4c6c3", "#bce9dd"
page = open("redeem/index.html").read()
svg = re.search(r'<svg class="shell".*?</svg>', page, re.S)[0]
defs = re.search(r"<defs>.*?</defs>", svg)[0]
wash = re.search(r'<ellipse class="wash"[^>]*/>', svg)[0].replace('class="wash"', 'opacity=".22"')
rim = re.search(r'<path class="rim" d="([^"]+)"', svg)[1]
rings = re.findall(r'<path class="ring" d="([^"]+)"', svg)
pores = re.findall(r'<ellipse class="pore" ([^/]+)/>', svg)
VIEW = (27, -344, 1026, 708)

def shell(x, y, width, every=1, rim_px=1.6, ring_px=1, pore_px=1.2):
    s = width / VIEW[2]
    u = lambda px: px / s
    body = [defs, wash, f'<path d="{rim}" fill="none" stroke="{INK}" stroke-width="{u(rim_px)}"/>']
    body += [f'<path d="{d}" fill="none" stroke="{MUTED}" stroke-width="{u(ring_px)}"/>' for d in rings[every - 1::every]]
    body += [f'<ellipse {p} fill="{BG}" stroke="{INK}" stroke-width="{u(pore_px)}"/>' for p in pores]
    return f'<g transform="translate({x} {y}) scale({s}) translate({-VIEW[0]} {-VIEW[1]})">{"".join(body)}</g>'

def write(name, w, h, inner):
    doc = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{inner}</svg>'
    out = f"assets/{name}"
    cairosvg.svg2png(bytestring=doc.encode(), write_to=out)
    subprocess.run(["convert", out, "+dither", "-colors", "48", f"PNG8:{out}"], check=True)
    subprocess.run(["optipng", "-quiet", "-o7", "-strip", "all", out], check=True)

def icon(size, every, rim_px, ring_px, pore_px):
    pad = size * .06
    width = size - 2 * pad
    y = (size - width * VIEW[3] / VIEW[2]) / 2
    return f'<rect width="{size}" height="{size}" rx="{size * .18}" fill="{BG}"/>' + shell(pad, y, width, every, rim_px, ring_px, pore_px)

write("icon-32.png", 32, 32, icon(32, 6, 1.6, 1, 1))
write("icon-180.png", 180, 180, icon(180, 2, 3, 1.4, 2))
write("icon-512.png", 512, 512, icon(512, 1, 6, 2.6, 4))
write("og-1200x630.png", 1200, 630, f'<rect width="1200" height="630" fill="{BG}"/>' + shell(560, 95, 580, 1, 3, 1.8, 2.6)
      + f'<text x="72" y="290" font-family="Georgia, DejaVu Serif, serif" font-size="88" letter-spacing="-2.6" fill="{INK}">Abalone</text>'
      + f'<text x="76" y="360" font-family="DejaVu Sans, sans-serif" font-size="30" fill="{MUTED}">A cypherpunk AI privacy shell.</text>'
      + f'<text x="76" y="404" font-family="DejaVu Sans, sans-serif" font-size="30" fill="{MUTED}">Incognito sessions with</text>'
      + f'<text x="76" y="448" font-family="DejaVu Sans, sans-serif" font-size="30" fill="{MUTED}">TEE-based private inference.</text>'
      + f'<rect x="76" y="500" width="64" height="3" fill="{ACCENT}"/>')
