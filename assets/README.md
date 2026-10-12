# Abalone entry artwork

The contour shell inlined in `redeem/index.html` and `friend.html` is generated
from the paper-wallet contour design by a generator not yet published. The
inline element is identical in both pages; check it with

    grep -o '<svg class="shell".*</svg>' redeem/index.html | sha256sum

which should print `5ac314baf93a343d92ff16699263e5c7eecefb0b61170dbb073a92771384c9fd`.

`nacre-960.webp` (used by `index.html` only) is a derivative of the original
AI-generated Nacre shell illustration, generated with OpenAI's image tool on
8 October 2026. It is original illustrative artwork, not a specimen photograph
or evidence of a security property. Made with ImageMagick 6.9.11-60:

    convert nacre-painted-source.png -resize 960x -strip -quality 78 nacre-960.webp

Source image SHA-256: `ccb0e0ce3e5d72dad024984626569cae27c439d2b093cd9f380ec727e9b8d0d0`.
WebP SHA-256: `d3e93f41b607ec0c8cbf9489083d3af77c95d5c556674d7413f18e2127ecc3d9`.

`abalone.svg` is an original hand-authored vector mark for these pages.
