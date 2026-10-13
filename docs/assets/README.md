# Documentation artwork

`abalone-banner-light.svg` and `abalone-banner-dark.svg` are the README banner:
the contour shell, the wordmark and the line "a cypherpunk AI privacy shell",
coloured for GitHub's light and dark themes on a transparent background. The
README shows one or the other with the `#gh-light-mode-only` and
`#gh-dark-mode-only` suffixes. Text uses system font stacks; nothing external
is loaded.

They are generated from the paper-wallet contour design by `shell-svg.py`, a
generator not yet published:

    python3 shell-svg.py banner light > docs/assets/abalone-banner-light.svg
    python3 shell-svg.py banner dark > docs/assets/abalone-banner-dark.svg

SHA-256:

    ba471b3b74e481fac7c1b948267923c8b140c1a705fbbe0ad734091820441814  docs/assets/abalone-banner-light.svg
    98d39fe978dd9a3af7cc2dbf059916da4bcf8169e031ea63b3493d05e576117b  docs/assets/abalone-banner-dark.svg

Check with `sha256sum docs/assets/abalone-banner-*.svg`. The same shell drawing
is the hero of the hosted redeem page. It is illustration, not evidence of a
security property.
