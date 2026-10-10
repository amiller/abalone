#!/usr/bin/env bash
# Window renewal ahead of time, on local anvil with an artificial safe-head lag: 1 s blocks, 30 slots per epoch, so
# "safe" trails "latest" by 30 blocks (~30 s). One dev peer with a small window (ABALONE_WINDOW_MICRO, default 300 µ$),
# one gift, N turns one after another (live NEAR, a few cents). Checks: every turn answers (none errors), turns
# that outrun the background renewal wait with "confirming credit" instead of failing, renewals start while turns go
# on, and no debit ever falls outside a checkpointed window (tests/fixtures/ledger-check.mjs). Prints per-turn timing.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
TURNS=${TURNS:-14} WIN=${ABALONE_WINDOW_MICRO:-300}
W="$(mktemp -d /tmp/abr.XXXX)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
waitfor() { for _ in $(seq 180); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
mkdir -p "$W/config/curated" "$W/i" "$W/a"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/curated/manifest.json" "$W/config/curated/"
node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json"
ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null
export ABALONE_CONFIG="$W/config"
RPC=http://127.0.0.1:$((20000 + RANDOM % 20000)) OWN=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
anvil --port "${RPC##*:}" --block-time 1 --slots-in-an-epoch 30 > "$W/anvil.log" 2>&1 & anvil=$!
"$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
trap 'kill $anvil $relay ${peer:-} 2>/dev/null; rm -rf "$W"' EXIT
waitfor "$W/relay.log" "/tcp/"; R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
sleep 2
REG=$(forge create --root "$root/contracts" --rpc-url "$RPC" --private-key "$OWN" --broadcast src/CouponRegistry.sol:CouponRegistry 2>&1 | grep -o "Deployed to: 0x[0-9a-fA-F]*" | cut -d' ' -f3)
M=0x$(printf 'dev-peer' | sha256sum | cut -c1-64)
openssl rand -hex 32 | tr -d '\n' > "$W/a/eth.key"; chmod 600 "$W/a/eth.key"
A=$(node -e 'import(process.argv[1]).then(c=>console.log(c.addressOf(Buffer.from(require("fs").readFileSync(process.argv[2],"utf8"),"hex"))))' "$root/lib/chain.mjs" "$W/a/eth.key")
cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "allow(bytes32,uint32)" "$M" 10 && cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "register(address,bytes32)" "$A" "$M" && cast send -q --rpc-url "$RPC" --private-key "$OWN" --value 1ether "$A" || exit 1
ISS=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift --issuer-pub)
ABALONE_WINDOW_MICRO=$WIN "$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$W/a" --issuer "$ISS" --chain "$RPC" --registry "$REG" > "$W/peer.log" 2>&1 & peer=$!
waitfor "$W/peer.log" "p2p-circuit" || { cat "$W/peer.log"; exit 1; }
P=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/peer.log" | head -1)
ABALONE_DIR="$W/i" "$root/bin/abalone" gift --setup 6usd > /dev/null
tok=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift 1usd --peer "$P" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
rcp() { mkdir -p "$W/u/home" "$W/u/work"; (cd "$W/u/work" && env -i XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" ABALONE_NO_CANARIES=1 PATH="$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$W/u/home" ABALONE_DIR="$W/u/home/.abalone" ABALONE_CONFIG="$W/config" GIFT_MAX_TOKENS=60 TERM=dumb "$@" < /dev/null 2>&1); }
t0=$(date +%s%3N); rcp abalone redeem --peer "$P" "$tok" > /dev/null; t1=$(date +%s%3N)
echo "  redeem (claim at the safe head, lag 30 blocks): $((t1 - t0)) ms; window $WIN µ\$, renewal starts at half"
out=$(rcp node "$root/tests/fixtures/gift-client.mjs" seq "$TURNS")
node -e 'for (const [i, t] of JSON.parse(process.argv[1]).entries()) console.log(`  turn ${String(i + 1).padStart(2)}: ${t.status} ${String(t.ms).padStart(6)} ms  charge ${t.charge?.charge ?? "-"} µ$  remaining ${t.charge?.remaining ?? "-"}${t.waited ? "  (waited: confirming credit)" : ""}`)' "$out"
check "all $TURNS turns answered; none failed while a window was confirming" 'node -e "process.exit(JSON.parse(process.argv[1]).every(t=>t.status===200) ? 0 : 1)" "$out"'
windows=$(grep -c '"type":"window"' "$W/a/ledger.jsonl")
check "windows were renewed ($windows checkpointed windows for one gift)" '(( windows >= 2 ))'
quick=$(node -e 'const t=JSON.parse(process.argv[1]); console.log(t.filter(x=>!x.waited).length)' "$out")
check "turns served without waiting: $quick of $TURNS (renewals ran in the background)" '(( quick > TURNS / 2 ))'
st=$(ABALONE_DIR="$W/i" node -e 'import(process.argv[1]).then(async p=>{const g=await p.giftClient(process.argv[3],require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit);const gi=await import(process.argv[2]);console.log(JSON.stringify(await gi.issue(g.url,{type:"status"})));await g.close()})' "$root/lib/p2p.mjs" "$root/lib/gift.mjs" "$P")
out=$(node "$root/tests/fixtures/ledger-check.mjs" "$W/a/ledger.jsonl" "$st"); echo "$out" | sed 's/^/  /'
check "no debit outside a checkpointed window; the ledger reconciles with the peer's live balances" '[[ $out == *reconciled* && $out == *"status matches"* ]]'
echo "gift-renew: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
