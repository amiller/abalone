#!/usr/bin/env bash
# Build the release artifact from a commit: git archive of HEAD (or $1), `npm ci` in the root, pi/ and aci/, then the
# pi and aci builds, packed as abalone-<rev>.tar.gz with its sha256. Given a base URL, also writes install.sh with that
# digest pinned, so the friend's one-liner installs exactly this artifact.
#   tools/release.sh [rev] [base URL the artifact will be served from]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rev=$(git -C "$root" rev-parse --short "${1:-HEAD}") base=${2:-}
out="$root/local-data/release/$rev"; rm -rf "$out"; mkdir -p "$out/build"
git -C "$root" archive --prefix=abalone/ "$rev" | tar -x -C "$out/build"
cd "$out/build/abalone"
npm ci --no-audit --no-fund --omit=dev
# pi's own build, except coding-agent is built unbundled (bin/abalone runs dist/cli.js; the bundle step expects the
# OAuth chunks of providers the fork removed).
(cd pi && npm ci --no-audit --no-fund && bash -c "$(node -p 'require("./package.json").scripts["build:offline"].replace("cd ../coding-agent && npm run build", "cd ../coding-agent && npm run build:unbundled")')")
(cd aci && npm ci --no-audit --no-fund && npm run build)
tar -C "$out/build" -czf "$out/abalone-$rev.tar.gz" abalone
sha=$(sha256sum "$out/abalone-$rev.tar.gz" | cut -d' ' -f1)
# Without a base URL there is nothing for install.sh to fetch from, so none is written (tools/friend-kit.sh renders its own).
if [[ $base ]]; then sed -e "s|@REV@|$rev|g" -e "s|@SHA256@|$sha|g" -e "s|@BASE@|$base|g" "$out/build/abalone/tools/install.sh.in" > "$out/install.sh"
else echo "no base URL given, so no install.sh: tools/release.sh $rev <base URL> writes one" >&2; fi
# The landing page, to host next to install.sh and the tarball (Andrew's step; nothing is published from here).
sed -e "s|@REV@|$rev|g" -e "s|@SHA256@|$sha|g" "$out/build/abalone/site/index.html" > "$out/index.html"
rm -rf "$out/build"
echo "abalone-$rev.tar.gz sha256 $sha ($(du -h "$out/abalone-$rev.tar.gz" | cut -f1))"
echo "$out"
