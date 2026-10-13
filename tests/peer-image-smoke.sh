#!/usr/bin/env bash
# The peer image's tree (the path list of souk-ab's workspaces/mac-node/build.sh: no vendor/pi/, no frontend build) from
# `git archive HEAD`, with node_modules and vendor/phala-aci/node_modules symlinked (the image installs them with npm ci):
# `abalone peer relay` starts, and `abalone peer serve --evidence dev` loads every module and reaches its own config
# checks (a NEAR key and live NEAR are needed past that point). Catches a static import of frontend code (vendor/pi/) on the peer path.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
img="$ABALONE_DIR/image"; mkdir -p "$img"
git -C "$root" archive HEAD bin lib agents/pi verifiers vendor/phala-aci/package.json vendor/phala-aci/verifier-ts package.json package-lock.json providers.json policy.json | tar -x -C "$img"
ln -s "$root/node_modules" "$img/node_modules" && ln -s "$root/vendor/phala-aci/node_modules" "$img/vendor/phala-aci/node_modules"
check "the image has no vendor/pi/ tree" '[[ ! -e $img/vendor/pi ]]'
(cd "$img" && exec node bin/abalone.mjs peer relay --listen /ip4/127.0.0.1/tcp/0 > "$ABALONE_DIR/relay.out" 2>&1) & pid=$!
for _ in $(seq 40); do grep -q "abalone relay" "$ABALONE_DIR/relay.out" && break; kill -0 $pid 2>/dev/null || break; sleep 0.5; done
kill $pid 2>/dev/null; out=$(cat "$ABALONE_DIR/relay.out"); echo "$out" | head -2 | sed 's/^/  relay: /'
check "peer relay starts" '[[ $out == *"abalone relay 12D3Koo"* ]]'
out=$(cd "$img" && timeout 30 node bin/abalone.mjs peer serve --evidence dev --listen /ip4/127.0.0.1/tcp/0 --reserve 1usd 2>&1); echo "$out" | head -2 | sed 's/^/  serve: /'
check "peer serve loads every module and stops only at its config check (no NEAR key here)" '[[ $out == "no nearai key configured"* ]]'
echo "peer-image-smoke: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
