# Abalone entry artwork

The contour shell inlined in `redeem/index.html`, `friend.html` and
`index.html` is generated from the paper-wallet contour design by a generator
not yet published. The inline element is identical in all three pages; check it with

    grep -o '<svg class="shell".*</svg>' redeem/index.html | sha256sum

which should print `5ac314baf93a343d92ff16699263e5c7eecefb0b61170dbb073a92771384c9fd`.

`nacre-960.webp` (used by `index.html` only, in dark mode; light mode shows
the contour shell) is a derivative of the original AI-generated Nacre shell
illustration, generated with OpenAI's image tool on
8 October 2026. It is original illustrative artwork, not a specimen photograph
or evidence of a security property. Made with ImageMagick 6.9.11-60:

    convert nacre-painted-source.png -resize 960x -strip -quality 78 nacre-960.webp

Source image SHA-256: `ccb0e0ce3e5d72dad024984626569cae27c439d2b093cd9f380ec727e9b8d0d0`.
WebP SHA-256: `d3e93f41b607ec0c8cbf9489083d3af77c95d5c556674d7413f18e2127ecc3d9`.

`abalone.svg` is an original hand-authored vector mark for these pages.

`icon-32.png`, `icon-180.png`, `icon-512.png` (favicons and touch icon) and
`og-1200x630.png` (share image for `index.html` and `redeem/index.html`) are
rendered from that inline shell with the dark-theme tokens. From the site root:

    python3 assets/make-icons.py

(CairoSVG 2.9.0, ImageMagick 6.9.11-60, OptiPNG 0.7.7; the script quantizes each
PNG to 48 colours without dithering.) The output is reproducible with those
versions. SHA-256:

    66b6bc1ddd929c12fe018d50842f3aded7d553d735fdd0d325e2e0425c2fbbff  assets/icon-180.png
    cab563f3952e7478c89d2d796ba8ba76a384cb5c391955fed38210c0f5ef6ed6  assets/icon-32.png
    7b077ed2bf1255e50245e478180c2c7debd740b773a74267ff5c15569833301a  assets/icon-512.png
    60fa8d87a0df6418718190b3364e0512ea205e8de9543ab764fa541b52f5193a  assets/og-1200x630.png
