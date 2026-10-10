#!/usr/bin/env bash
# Optimistic first window on local anvil with an artificial safe-head lag (1 s blocks, safe = latest − 30 blocks).
#   1. A redeem returns once its claim is included; the first turn is served before the claim is safe.
#   2. A lost race: peer A's claim of a second gift is included and A serves a turn on it, then a reorg
#      (anvil_reorg) replaces those blocks with peer B's claim of the same code. When the safe head passes, A records
#      the loss, stops serving that account with a plain message, and its loss is what it served (≤ $0.05).
#   3. The ledger reconciles, with the optimistic window accounted separately.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/abo.XXXX)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
waitfor() { for _ in $(seq 180); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
mkdir -p "$W/config/curated" "$W/i"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/curated/manifest.json" "$W/config/curated/"
node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json"
ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null
export ABALONE_CONFIG="$W/config"
RPC=http://127.0.0.1:$((20000 + RANDOM % 20000)) OWN=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
anvil --port "${RPC##*:}" --block-time 1 --slots-in-an-epoch 30 > "$W/anvil.log" 2>&1 & anvil=$!
"$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
trap 'kill $anvil $relay $(cat "$W"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$W"' EXIT
waitfor "$W/relay.log" "/tcp/"; R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
sleep 2
REG=$(forge create --root "$root/contracts" --rpc-url "$RPC" --private-key "$OWN" --broadcast src/CouponRegistry.sol:CouponRegistry 2>&1 | grep -o "Deployed to: 0x[0-9a-fA-F]*" | cut -d' ' -f3)
M=0x$(printf 'dev-peer' | sha256sum | cut -c1-64)
cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "allow(bytes32,uint32)" "$M" 10 || exit 1
rpc() { curl -s -X POST -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"; }
blk() { rpc eth_getBlockByNumber "[\"$1\",false]" | node -pe 'parseInt(JSON.parse(require("fs").readFileSync(0)).result.number)'; }
newpeer() {
  mkdir -p "$1"; openssl rand -hex 32 | tr -d '\n' > "$1/eth.key"; chmod 600 "$1/eth.key"
  local a; a=$(node -e 'import(process.argv[1]).then(c=>console.log(c.addressOf(Buffer.from(require("fs").readFileSync(process.argv[2],"utf8"),"hex"))))' "$root/lib/chain.mjs" "$1/eth.key")
  cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "register(address,bytes32)" "$a" "$M" && cast send -q --rpc-url "$RPC" --private-key "$OWN" --value 1ether "$a"; echo "$a"
}
ISS=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift --issuer-pub)
A=$(newpeer "$W/a"); B=$(newpeer "$W/b")
"$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$W/a" --issuer "$ISS" --chain "$RPC" --registry "$REG" > "$W/a.log" 2>&1 & echo $! > "$W/a.pid"
waitfor "$W/a.log" "p2p-circuit" || { cat "$W/a.log"; exit 1; }
P=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/a.log" | head -1)
ABALONE_DIR="$W/i" "$root/bin/abalone" gift --setup 6usd > /dev/null
rcp() { local who=$1; shift; mkdir -p "$W/$who/home" "$W/$who/work"; (cd "$W/$who/work" && env -i XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" ABALONE_NO_CANARIES=1 PATH="$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$W/$who/home" ABALONE_DIR="$W/$who/home/.abalone" ABALONE_CONFIG="$W/config" GIFT_MAX_TOKENS=200 TERM=dumb "$@" < /dev/null 2>&1); }
gift() { ABALONE_DIR="$W/i" "$root/bin/abalone" gift "$1" --peer "$P" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*'; }
acct() { node -e 'import(process.argv[1]).then(g=>console.log(g.parseGift(process.argv[2]).m.account))' "$root/lib/gift.mjs" "$1"; }
claimblk() { rpc eth_getLogs "[{\"address\":\"$REG\",\"fromBlock\":\"0x0\",\"topics\":[\"$(cast keccak 'Claimed(bytes32,address)')\",\"0x$1\"]}]" | node -pe 'parseInt(JSON.parse(require("fs").readFileSync(0)).result.at(-1).blockNumber)'; }

echo "== 1. first turn before the claim is safe"
t1=$(gift 5usd); a1=$(acct "$t1")
s=$(date +%s%3N); rcp u abalone redeem --peer "$P" "$t1" > /dev/null; e=$(date +%s%3N)
out=$(rcp u node "$root/tests/fixtures/gift-client.mjs" one); f=$(date +%s%3N)
cb=$(claimblk "$a1"); sb=$(blk safe)
check "redeem $((e - s)) ms, first turn answered $((f - s)) ms after the redeem started, while the claim (block $cb) was not yet safe (safe head $sb)" '[[ $out == *"\"status\":200"* ]] && (( sb < cb ))'

echo "== 2. a lost race"
t2=$(gift 1usd); a2=$(acct "$t2")
rcp v abalone redeem --peer "$P" "$t2" > /dev/null
out=$(rcp v node "$root/tests/fixtures/gift-client.mjs" one); served=$(node -pe 'JSON.parse(process.argv[1])[0].charge?.charge ?? 0' "$out")
check "A served the second gift optimistically ($served µ\$)" '[[ $out == *"\"status\":200"* ]]'
X=$(claimblk "$a2"); L=$(blk latest); depth=$((L - X + 1))
nB=$(cast call --rpc-url "$RPC" "$REG" "n(address)(uint64)" "$B"); nonceB=$(cast nonce --rpc-url "$RPC" "$B")
raw=$(cast mktx --rpc-url "$RPC" --private-key "0x$(cat "$W/b/eth.key")" --legacy --gas-limit 300000 --gas-price 2000000000 --nonce "$nonceB" "$REG" "checkpoint(uint64,bytes,bytes32[])" $((nB + 1)) 0x00 "[0x$a2]")
rpc anvil_reorg "[$depth,[[\"$raw\",0]]]" > "$W/reorg.json"
echo "  reorg of depth $depth from block $X: $(cat "$W/reorg.json")"
until grep -q "claim lost for ${a2:0:8}" "$W/a.log"; do sleep 1; (( SECONDS > 600 )) && break; done
holder=$(cast call --rpc-url "$RPC" --block safe "$REG" "claimedBy(bytes32)(address)" "0x$a2")
check "at the safe head the code belongs to B (${holder,,}), and A recorded the loss: $(grep "claim lost" "$W/a.log" | cut -c1-110)" '[[ ${holder,,} == ${B,,} ]] && grep -q "claim lost for ${a2:0:8}" "$W/a.log"'
out=$(rcp v node "$root/tests/fixtures/gift-client.mjs" one)
check "A now refuses that account with a plain message: $(cut -c1-150 <<<"$out")" '[[ $out == *"\"status\":409"*"Another computer redeemed this gift at the same moment"* ]]'
out=$(rcp u node "$root/tests/fixtures/gift-client.mjs" one)
check "the first gift, whose claim is safe, still works after the reorg (A resumed from the chain's n)" '[[ $out == *"\"status\":200"* ]]'

echo "== 3. reconciliation"
st=$(ABALONE_DIR="$W/i" node -e 'import(process.argv[1]).then(async p=>{const g=await p.giftClient(process.argv[3],require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit);const gi=await import(process.argv[2]);console.log(JSON.stringify(await gi.issue(g.url,{type:"status"})));await g.close()})' "$root/lib/p2p.mjs" "$root/lib/gift.mjs" "$P")
out=$(node "$root/tests/fixtures/ledger-check.mjs" "$W/a/ledger.jsonl" "$st"); echo "$out" | sed 's/^/  /'
check "the ledger reconciles; the lost claim commits only what A served, inside its \$0.05 optimistic window" '[[ $out == *reconciled* && $out == *"status matches"* && $out == *"optimistic losses: 1 claim(s)"* ]]'
echo "gift-optimistic: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
