# Abalone static entry

The buildless GitHub Pages source is this `pages` branch, which shares no history
with `main`. Its public entry is
`https://amiller.github.io/abalone/redeem`; Pages serves `redeem/index.html`.
The page works as readable HTML without JavaScript, including the instructions
for a setup agent whose HTTP fetch cannot see a URL fragment.

The copy button reads a gift fragment into browser memory and includes it only in
an explicitly requested clipboard copy. Section navigation preserves the gift for
that copy; a changed `#code=` fragment replaces it. Malformed, empty or duplicate
codes are never copied. If clipboard access is denied, the page restores the gift
fragment to the address bar locally so the user can copy the full link. The page performs no redemption, storage, analytics or network
requests containing coupon data. Static images, script and stylesheet are local;
CSP denies network connections and form submissions, and referrers are disabled.
Gift-bearing clipboard text should be pasted only into a trusted setup agent.
`index.html` and `friend.html` have no script. Dark is the default theme; a light
theme follows `prefers-color-scheme`.

## Deployment

Select GitHub Actions as the repository's Pages source. The reviewed
`.github/workflows/pages.yml` uploads this branch and deploys on a push to
`pages` or explicit dispatch. The Pages environment must permit the `pages`
branch. `friend.html` is the release landing template; `tools/release.sh` on
`main` takes it with `--site-template`. No npm install or build is needed. The workflow does not deploy the
issuer or a model service.

Publish this entry together with the documented durable `abalone credit` runtime
and its matching installation/access instructions. Earlier process-only releases
do not implement the described handoff. Runtime packaging, signed trial inputs
and service availability are maintained independently of the static website.

## Checks

Run `node --check assets/redeem.js`, `git diff --check` and a local static server. Inspect desktop and mobile
widths in both colour schemes, keyboard focus, missing/malformed fragments, clipboard failure, section
navigation before copying, and the absence of horizontal
scroll and CSP console errors. `friend.html` must pass the release template
check (CSP `default-src 'none'`, links to the hosted redeem entry and the setup
skill, no script or versioned installer link). Never use a real coupon for page
testing. With a synthetic fragment, verify browser network requests contain no
coupon bytes and no external requests.

Artwork provenance is in [assets/README.md](assets/README.md).
