#!/bin/bash
# Build teep (https://github.com/13rac1/teep, AGPL-3.0) at the pinned commit for arm64 and check the binary's hash.
# usage: build-teep.sh WORKDIR   output: WORKDIR/teep, WORKDIR/LICENSE
# Needs git and Go 1.27.3; Go builds with -trimpath are reproducible for a fixed Go version, so the hash must match.
set -euo pipefail
COMMIT=d24119c84dc9cef2f53cb6654c4dfa2f0ccde505
W=$(mkdir -p "$1" && cd "$1" && pwd)
[ "$(go env GOVERSION)" = go1.27.3 ] || { echo "need go1.27.3, have $(go env GOVERSION)" >&2; exit 1; }
[ -d "$W/src" ] || git clone -q https://github.com/13rac1/teep.git "$W/src"
git -C "$W/src" checkout -q --detach "$COMMIT"
(cd "$W/src" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o "$W/teep" ./cmd/teep)
cp "$W/src/LICENSE" "$W/LICENSE"
echo "e19e1d291fc062ee788eba6aee8c74629e03adaec914d3a20f914dfc051de31a  $W/teep" | sha256sum -c
