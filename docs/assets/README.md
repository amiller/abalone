# Documentation artwork

`abalone-banner-light.png` and `abalone-banner-dark.png` are the README banner:
the Abalone mascot, the wordmark and the line "a cypherpunk AI privacy shell",
on a transparent background at 1111×480, trimmed to the content plus 40 px
(shown at 556 px wide, half the pixel width). The light
banner uses the brown mascot with ink `#1d1c1a`; the dark banner uses the
ink-and-mint mascot with ink `#f3f0e7`. The README shows one or the other with
the `#gh-light-mode-only` and `#gh-dark-mode-only` suffixes.

The mascot is an original illustration made with an OpenAI image generation
tool. Its 1024 px transparent sources, `mascot.png` and `mascot-dark.png`, are
not yet in this repository. The banners are composed with ImageMagick 6.9 from
those sources, Georgia (wordmark) and DejaVu Sans Mono (line):

    for v in light:mascot.png:'#1d1c1a' dark:mascot-dark.png:'#f3f0e7'; do
      IFS=: read t m ink <<<"$v"
      convert -size 1440x440 xc:none \( "$m" -trim +repage -resize x400 \) \
        -geometry +24+20 -composite -fill "$ink" \
        -font Georgia -pointsize 152 -annotate +500+250 'Abalone' \
        -font DejaVu-Sans-Mono -pointsize 32 \
        -annotate +506+316 'a cypherpunk AI privacy shell' \
        -trim +repage -bordercolor none -border 40 \
        -depth 8 -strip "docs/assets/abalone-banner-$t.png"
    done

SHA-256:

    b2045768422397acd18d79f18244c63c86210260f540e8f80f8297a65f71ff6e  docs/assets/abalone-banner-light.png
    2bc489520c5b9afb5df1c6737d18c9b13ee8eef900f40c13f2e8bf4227029c25  docs/assets/abalone-banner-dark.png

Check with `sha256sum docs/assets/abalone-banner-*.png`. The banner is
illustration, not evidence of a security property.
