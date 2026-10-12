# Abalone static entry

The buildless GitHub Pages source is this directory. Its public entry is
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

## Deployment

Select GitHub Actions as the repository's Pages source. The reviewed
`.github/workflows/pages.yml` uploads only `site/` and deploys on a relevant main
branch push or explicit dispatch. The Pages environment must permit the reviewed
main branch. No npm install or build is needed. The workflow does not deploy the
issuer or a model service.

Publish this entry together with the documented durable `abalone credit` runtime
and its matching installation/access instructions. Earlier process-only releases
do not implement the described handoff. Runtime packaging, signed trial inputs
and service availability are maintained independently of the static website.

## Checks

Run `make verify-docs`, `node --check site/assets/redeem.js`, and a local static
server. Inspect desktop and mobile widths, keyboard focus, missing/malformed
fragments, clipboard failure, and section navigation before copying. With a
synthetic fragment, verify browser network requests contain no coupon bytes and
no external requests. Never use a real coupon for page testing.

Artwork provenance is in [assets/README.md](assets/README.md).
