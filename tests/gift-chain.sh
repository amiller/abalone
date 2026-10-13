#!/usr/bin/env bash
# The chain path against local anvil only (plugins/coupon/contracts/src/CouponRegistry.sol as it stands): claims and spending windows
# are checkpointed with the encrypted snapshot in calldata, and the peer waits for the safe head (anvil block time 1 s,
# 2 slots per epoch, so "safe" trails "latest" by about 2 blocks). Dev peers behind a local relay, live NEAR for a few
# turns. Checks: redeem waits for the safe head and claimedBy names the peer; a second peer cannot claim the same
# code; a peer whose disk is wiped restores from the chain and writes off its open window; a cloned peer hits BadN
# and exits instead of retrying. Prints redeem-to-usable timings.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/abc.XXXX)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }
mkdir -p "$W/config/agents/pi" "$W/i"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/agents/pi/admitted.json" "$W/config/agents/pi/"
node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json"
ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null
export ABALONE_CONFIG="$W/config"
RPC=http://127.0.0.1:$((20000 + RANDOM % 20000)) OWN=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
anvil --port "${RPC##*:}" --block-time 1 --slots-in-an-epoch 2 > "$W/anvil.log" 2>&1 & anvil=$!
"$root/bin/abalone" peer relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
trap 'kill $anvil $relay $(cat "$W"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$W"' EXIT
waitfor "$W/relay.log" "/tcp/"; R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
sleep 2
(cd "$root/plugins/coupon/contracts" && forge build -q) || exit 1
REG=$(forge create --root "$root/plugins/coupon/contracts" --rpc-url "$RPC" --private-key "$OWN" --broadcast src/CouponRegistry.sol:CouponRegistry 2>&1 | grep -o "Deployed to: 0x[0-9a-fA-F]*" | cut -d' ' -f3)
M=0x$(printf 'dev-peer' | sha256sum | cut -c1-64)
cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "allow(bytes32,uint32)" "$M" 10 || exit 1
echo "  registry $REG on anvil"
iss() { ABALONE_DIR="$W/i" "$root/bin/abalone" "$@"; }
ISS=$(iss gift --issuer-pub)
newpeer() { # dir: makes the peer's chain key, registers and funds its address
  mkdir -p "$1"; openssl rand -hex 32 | tr -d '\n' > "$1/eth.key"; chmod 600 "$1/eth.key"
  local a; a=$(node -e 'import(process.argv[1]).then(c=>console.log(c.addressOf(Buffer.from(require("fs").readFileSync(process.argv[2],"utf8"),"hex"))))' "$root/lib/chain.mjs" "$1/eth.key")
  cast send -q --rpc-url "$RPC" --private-key "$OWN" "$REG" "register(address,bytes32)" "$a" "$M" && cast send -q --rpc-url "$RPC" --private-key "$OWN" --value 1ether "$a"
  echo "$a"
}
startpeer() { # ledger dir, log
  "$root/bin/abalone" peer serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$1" --issuer "$ISS" --chain "$RPC" --registry "$REG" > "$2" 2>&1 & echo $! > "$2.pid"
  waitfor "$2" "p2p-circuit" || { sed 's/^/  peer: /' "$2"; return 1; }
  grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$2" | head -1
}
rcp() { local who=$1; shift; mkdir -p "$W/$who/home" "$W/$who/work"; (cd "$W/$who/work" && env -i XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" ABALONE_NO_CANARIES=1 PATH="$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$W/$who/home" ABALONE_DIR="$W/$who/home/.abalone" ABALONE_CONFIG="$W/config" GIFT_MAX_TOKENS="${GIFT_MAX_TOKENS:-400}" TERM=dumb "$@" < /dev/null 2>&1); }
ms() { date +%s%3N; }

A_ADDR=$(newpeer "$W/a"); PA=$(startpeer "$W/a" "$W/a.log") || exit 1
B_ADDR=$(newpeer "$W/b"); PB=$(startpeer "$W/b" "$W/b.log") || exit 1
grep "chain:" "$W/a.log" | sed 's/^/  peer A: /'
iss gift --setup 20usd > /dev/null
tok=$(iss gift 5usd --peer "$PA" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
acct=$(node -e 'import(process.argv[1]).then(g=>console.log(g.parseGift(process.argv[2]).m.account))' "$root/lib/gift.mjs" "$tok")

echo "== redeem waits for the safe head"
t0=$(ms); out=$(rcp u abalone redeem --peer "$PA" "$tok"); t1=$(ms)
echo "$out" | head -2 | sed 's/^/  /'
held=$(cast call --rpc-url "$RPC" "$REG" "claimedBy(bytes32)(address)" "0x$acct")
check "redeem returned once its claim was included: claimedBy = peer A at the latest block ($((t1 - t0)) ms redeem-to-usable; optimistic window until safe)" '[[ ${held,,} == ${A_ADDR,,} ]]'
for _ in $(seq 120); do [[ $(cast call --rpc-url "$RPC" --block safe "$REG" "claimedBy(bytes32)(address)" "0x$acct" | tr A-F a-f) == ${A_ADDR,,} ]] && break; sleep 0.5; done
echo "  claim safe $(( $(date +%s%3N) - t0 )) ms after the redeem started"
t2=$(ms); out=$(rcp u node "$root/tests/fixtures/gift-client.mjs" one); t3=$(ms)
check "first request served ($((t3 - t2)) ms, no new window needed)" '[[ $out == *"\"status\":200"* ]]'
out=$(rcp v abalone redeem --peer "$PB" "$tok"); check "the same code at another registered peer is refused by the chain: $(tail -1 <<<"$out" | cut -c1-90)" '[[ $out == *"claimed on chain by another peer"* ]]'

echo "== a peer whose disk is wiped restores from the chain and writes off its open window"
until [[ $(cast call --rpc-url "$RPC" --block safe "$REG" "n(address)(uint64)" "$A_ADDR") == $(cast call --rpc-url "$RPC" "$REG" "n(address)(uint64)" "$A_ADDR") ]]; do sleep 0.5; done   # restore reads the safe head
before=$(cast call --rpc-url "$RPC" "$REG" "n(address)(uint64)" "$A_ADDR")
kill "$(cat "$W/a.log.pid")"; while kill -0 "$(cat "$W/a.log.pid")" 2>/dev/null; do sleep 0.2; done
rm -f "$W/a/ledger.jsonl" "$W/a/peer.lock"
PA=$(startpeer "$W/a" "$W/a2.log") || exit 1
grep "chain:" "$W/a2.log" | sed 's/^/  peer A: /'
wo=$(grep '"writeoff":true' "$W/a/ledger.jsonl" | head -1)
check "restored at n=$before from the safe-head snapshot with a write-off of the open window ($(node -e 'const d=JSON.parse(process.argv[1]);console.log(d.charge+" µ$")' "$wo"))" '[[ -n $wo ]] && grep -q "restored checkpoint n=$before" "$W/a2.log"'
t4=$(ms); out=$(rcp u node "$root/tests/fixtures/gift-client.mjs" one); t5=$(ms)
[[ $out == *'"status":200'* ]] || echo "  after restart: $(cut -c1-300 <<<"$out")"
check "the gift still works after the restart (new window checkpointed first: $((t5 - t4)) ms)" '[[ $out == *"\"status\":200"* ]]'
st=$(ABALONE_DIR="$W/i" node -e 'import(process.argv[1]).then(async p=>{const g=await p.giftClient(process.argv[3],require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit);const gi=await import(process.argv[2]);console.log(JSON.stringify(await gi.issue(g.url,{type:"status"})));await g.close()})' "$root/lib/p2p.mjs" "$root/lib/gift.mjs" "$PA")
out=$(node "$root/tests/fixtures/ledger-check.mjs" "$W/a/ledger.jsonl" "$st"); echo "$out" | sed 's/^/  /'
check "the restored ledger reconciles (write-offs counted as spent, never past the gift's amount)" '[[ $out == *reconciled* && $out == *"status matches"* ]]'

echo "== a cloned peer hits BadN and takes the restart path"
cp -r "$W/a" "$W/clone"; rm -f "$W/clone/peer.lock" "$W/clone/peer.seed"   # same chain and slice keys, its own PeerId
PC=$(startpeer "$W/clone" "$W/clone.log") || exit 1
tok2=$(iss gift 1usd --peer "$PA" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
rcp w abalone redeem --peer "$PA" "$tok2" > /dev/null       # the original checkpoints n+1
tok3=$(iss gift 1usd --peer "$PC" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
out=$(rcp x abalone redeem --peer "$PC" "$tok3")              # the clone tries n+1 too
sleep 1
check "the clone's checkpoint was refused (BadN), it exited, and the redeem did not succeed" 'grep -q "restart: checkpoint .* refused (BadN)" "$W/clone.log" && [[ $out != *"Set up this gift"* ]]'
echo "gift-chain: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
