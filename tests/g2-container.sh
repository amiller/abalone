#!/usr/bin/env bash
# G2, timed: a fresh user in a fresh container installs the release artifact with the one-liner, redeems, and gets a
# first verified private turn. Prerequisites baked into the image beforehand (not timed): node 24.15.0, bubblewrap,
# curl, ca-certificates (Debian bookworm). The container runs with seccomp/AppArmor unconfined and /proc unmasked so
# bwrap can build abalone's sandbox, and with --network host to reach the artifact server, the relay and the peer on
# this laptop's loopback. The peer is a dev peer (no Mac key yet), so the container's config admits dev peers: that
# one setting is the only difference from the shipped artifact. The installer plants canaries in the friend's folder
# (ABALONE_PLANT_CANARIES=yes answers its question without a terminal), and XDG_RUNTIME_DIR is a fresh dir (a Debian container
# has none; a Linux desktop session sets it, macOS does not).
#   tests/g2-container.sh <release dir from tools/release.sh, built with base URL http://127.0.0.1:28800>
#   G2_PEER=<multiaddr> tests/g2-container.sh <release dir>
#     against an existing admitted peer (the Mac runner peer): no dev peer, the artifact's own config unchanged, the
#     gift ($0.25) signed with the local issuer key (ABALONE_ISSUER_KEY, default ~/.abalone/issuer.key) into a temp book
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rel=${1:?release dir}; rev=$(basename "$rel")
W="$(mktemp -d /tmp/abq.XXXX)"; chmod 755 "$W"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }
docker image inspect abalone-friend-prereqs > /dev/null || { echo "FAIL build the prerequisites image first (see tests/g2-container.Dockerfile)"; exit 1; }
python3 -m http.server 28800 --bind 127.0.0.1 -d "$rel" > "$W/http.log" 2>&1 & http=$!
if [[ -n ${G2_PEER:-} ]]; then
  trap 'kill $http 2>/dev/null; rm -rf "$W"' EXIT
  export ABALONE_ISSUER_KEY=${ABALONE_ISSUER_KEY:-$HOME/.abalone/issuer.key}
  P=$G2_PEER AMOUNT=0.25usd
else
"$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
trap 'kill $http $relay ${peer:-} 2>/dev/null; rm -rf "$W"' EXIT
waitfor "$W/relay.log" "/tcp/"; R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
ISS=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift --issuer-pub)
"$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$W/l" --issuer "$ISS" > "$W/peer.log" 2>&1 & peer=$!
waitfor "$W/peer.log" "p2p-circuit" || { cat "$W/peer.log"; exit 1; }
P=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/peer.log" | head -1) AMOUNT=5usd
fi
ABALONE_DIR="$W/i" "$root/bin/abalone" gift --setup 6usd > /dev/null
token=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift $AMOUNT --peer "$P" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
mkdir -p "$W/cfg/curated" && tar -xzf "$rel/abalone-$rev.tar.gz" -C "$W" abalone/providers.json abalone/policy.json abalone/curated/manifest.json
cp "$W/abalone/policy.json" "$W/cfg/"; cp "$W/abalone/curated/manifest.json" "$W/cfg/curated/"
node -e 'const p=require(process.argv[1]);p.peers.admit.dev=!process.argv[3];require("fs").writeFileSync(process.argv[2],JSON.stringify(p,null,1))' "$W/abalone/providers.json" "$W/cfg/providers.json" "${G2_PEER:-}"
chmod -R a+rX "$W/cfg"
echo "== the friend's two commands, timed, in a fresh container as a fresh user"
start=$(date +%s.%N)
docker run --rm --network host --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  -v "$W/cfg:/cfg:ro" -e ABALONE_CONFIG=/cfg -e TERM=dumb -e ABALONE_PLANT_CANARIES=yes abalone-friend-prereqs sh -c "
    export XDG_RUNTIME_DIR=\$(mktemp -d) &&
    curl -fsSL http://127.0.0.1:28800/install.sh | sh -s -- --peer $P $token &&
    ~/.local/bin/abalone sandbox -p 'Reply with exactly: abalone ok' < /dev/null" > "$W/friend.log" 2>&1
code=$?; end=$(date +%s.%N)
sed 's/g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*/g1<redacted>/; s/^/  /' "$W/friend.log"
secs=$(printf %.1f "$(echo "$end - $start" | bc)")
check "install → redeem → first verified private turn in $secs s (target ≤ 180 s, 2 commands)" '[[ $code == 0 ]] && grep -q "abalone ok" "$W/friend.log" && (( $(echo "$secs <= 180" | bc) ))'
check "canaries were planted in the friend's folder and the session ran with them (no --no-canaries)" 'grep -q "Start with: abalone$" "$W/friend.log"'
check "the installer verified the artifact digest ($rev)" 'grep -q "Installed abalone $rev" "$W/friend.log"'
check "the artifact was fetched once from the release server" '[[ $(grep -c "GET /abalone-$rev.tar.gz" "$W/http.log") == 1 ]]'
echo "g2-container: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
