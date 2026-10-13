#!/usr/bin/env python3
"""Render the favicon PNGs and the share image from assets/mascot.png.
Run from the site root: python3 assets/make-icons.py (ImageMagick 6.9.11-60, OptiPNG 0.7.7, fonts Georgia and DejaVu Sans Mono)."""
import subprocess

PAPER, INK, MUTED = "#fbfaf7", "#1d1c1a", "#6b675f"
MASCOT = ["(", "assets/mascot.png", "-trim", "+repage"]

def write(name, *args):
    out = f"assets/{name}"
    subprocess.run(["convert", *args, "-depth", "8", "-strip", "-colors", "255", out], check=True)
    subprocess.run(["optipng", "-quiet", "-o7", "-strip", "all", out], check=True)

for size in 32, 512:
    write(f"icon-{size}.png", *MASCOT, "-resize", f"{size}x{size}", ")", "-background", "none", "-gravity", "center", "-extent", f"{size}x{size}")
write("icon-180.png", "-size", "180x180", f"xc:{PAPER}", *MASCOT, "-resize", "152x152", ")", "-gravity", "center", "-composite")
write("og-1200x630.png", "-size", "1200x630", f"xc:{PAPER}", *MASCOT, "-resize", "x420", ")", "-geometry", "+56+105", "-composite",
      "-fill", INK, "-font", "Georgia", "-pointsize", "124", "-annotate", "+600+312", "Abalone",
      "-fill", MUTED, "-font", "DejaVu-Sans-Mono", "-pointsize", "29", "-annotate", "+606+374", "a cypherpunk AI privacy shell")
