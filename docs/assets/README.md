# Documentation artwork

`abalone-banner-light.png` and `abalone-banner-dark.png` are the README banner:
the Abalone mascot, the wordmark and the line "a cypherpunk AI privacy shell",
on a transparent background at 1440×440 (shown at 720 px wide). The light
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
        -depth 8 -strip "docs/assets/abalone-banner-$t.png"
    done

SHA-256:

    c98425506dbc6018cb7529ad4feeb0c3e4eda2deb79f18243fb96b6ce24c0e91  docs/assets/abalone-banner-light.png
    b74ab6bde6d5131c15cae91e2b1d24d4487f4a094638241f3d282a4692eba2f1  docs/assets/abalone-banner-dark.png

Check with `sha256sum docs/assets/abalone-banner-*.png`. The banner is
illustration, not evidence of a security property.
