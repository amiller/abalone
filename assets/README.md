# Abalone entry artwork

`mascot.png` (light theme) and `mascot-dark.png` (dark theme) are the Abalone
mascot: a cartoon abalone peeking out from under its shell, brown in the light
version and ink-and-mint in the dark one. They are original illustrations made
with OpenAI's image generation tool (via the Codex CLI) on 12 October 2026, not
specimen photographs or evidence of a security property. `index.html` and
`redeem/index.html` show one or the other through the `.on-light` and `.on-dark`
classes in `redeem.css`. Each is the 1024 px transparent source reduced to a
256-colour palette with Pillow 12.3:

    python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).quantize(256, method=Image.Quantize.FASTOCTREE).save(sys.argv[2], optimize=True)' SOURCE.png assets/mascot.png

`friend.html` is copied on its own into release directories, so it embeds
560 px WebP copies as `data:` URLs (its CSP allows `img-src data:` and nothing
else external). Made with ImageMagick 6.9.11-60:

    convert assets/mascot.png -resize 560x560 -strip -define webp:alpha-quality=90 -quality 80 mascot-560.webp

SHA-256:

    5f4a7e01db5f40a3ecb3217bd224be72c452bb1e7fb495eee4fb4afaa14d71bd  assets/mascot.png
    c0fbc9169211ac4fda7628d2095e4b62331300cf3f83008b279ceb5ad5b27ea9  assets/mascot-dark.png

`abalone.svg` is an original hand-authored vector mark for these pages, used in
the header and as the SVG favicon.

`icon-32.png`, `icon-512.png` (transparent PNG favicons), `icon-180.png` (touch
icon on paper `#fbfaf7`) and `og-1200x630.png` (share image for `index.html` and
`redeem/index.html`: the mascot and wordmark on paper `#fbfaf7`) are rendered
from `mascot.png`. From the site root:

    python3 assets/make-icons.py

(ImageMagick 6.9.11-60, OptiPNG 0.7.7, fonts Georgia and DejaVu Sans Mono; each
PNG is reduced to at most 255 colours.) The output is reproducible with those
versions. SHA-256:

    070d471c3f0457a63b6d9cedb99f411bcc0ba38c5a2060c5a3fc5634d70bf18e  assets/icon-180.png
    bf0c663eb71347aea32490744310d4f9c374d74a29eac857d8b4c50b6ba317f5  assets/icon-32.png
    3e73d05ec900f919598cca2c8fa2f49e7eb4a82c83615842d60179914b9d09bb  assets/icon-512.png
    97cb999cf662eb047b5825539af509a57797b5ede1bf98824ff79b02c3e62528  assets/og-1200x630.png
