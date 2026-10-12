#!/usr/bin/env bash
# G1, G3, G6 against one real gift peer over libp2p, with live NEAR (z-ai/glm-5.3-flash). Spend: a few cents.
#   tests/gift.sh          the peer runs here as an unattested dev peer (the test config admits dev peers)
#   GIFT_RUNNER=1 tests/gift.sh
#                          the peer runs in Mac-runner mode against tests/fixtures/stub-runner.mjs: no provider key and
#                          no keystore in the peer, all HTTP and the relay through the runner socket, keys from /key
#   ABALONE_PEER=<multiaddr> tests/gift.sh
#                          against an existing peer (e.g. the live Mac runner peer): nothing is started or restarted,
#                          the repo's admission policy applies (no dev peers), gifts are signed with the local issuer key
#                          (ABALONE_ISSUER_KEY, default ~/.abalone/issuer.key) into a temporary book, the main gift is
#                          $0.25, and balances are reconciled from the peer's status and the charges clients saw
#   GIFT_MAC=1 tests/gift.sh
#                          the peer runs on the Mac mini (ssh mini-mesh) with App Attest evidence, listening on its own
#                          loopback only, reachable solely through a relay this script runs on the laptop's mesh address;
#                          the client admits only the approved CDHash. Needs a nearai key configured on the mini (abalone key add nearai).
# The issuer, ledger and recipients are fresh temporary dirs; recipients have an empty HOME and no provider key.
# Exits non-zero if anything fails or cannot run.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
MAC=${GIFT_MAC:-} RUN=${GIFT_RUNNER:-} MINI=${MINI_SSH:-mini-mesh} LAPTOP=${LAPTOP_MESH_IP:-192.168.100.2} REMOTE='~/projects/abalone-edge'
PROBE='~/appattest-codebinding-20260916/active/CodeBindingProbe.app'
W="$(mktemp -d /tmp/abg.XXXX)"   # short path: the sandbox's unix sockets live under it
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
remote() { timeout 300 ssh "$MINI" "cd $REMOTE && $*"; }
mkdir -p "$W/config/curated" "$W/i" "$W/l"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/curated/manifest.json" "$W/config/curated/"
[[ -z $MAC ]] && node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json"
ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null   # the working tree under test, not HEAD
export ABALONE_CONFIG="$W/config"
iss() { ABALONE_DIR="$W/i" "$root/bin/abalone" "$@"; }
rcp() { local who=$1; shift; mkdir -p "$W/$who/home" "$W/$who/work"; (cd "$W/$who/work" && env -i XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" ABALONE_NO_CANARIES=1 PATH="$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$W/$who/home" ABALONE_DIR="$W/$who/home/.abalone" ABALONE_CONFIG="$W/config" ABALONE_PEER="${ABALONE_PEER:-}" GIFT_MAX_TOKENS="${GIFT_MAX_TOKENS:-400}" TERM=dumb "$@" < /dev/null 2>&1); }
client() { local who=$1; shift; rcp "$who" node "$root/tests/fixtures/gift-client.mjs" "$@"; }
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }

REMOTE=${ABALONE_PEER:-}
[[ -n $REMOTE ]] && export ABALONE_ISSUER_KEY=${ABALONE_ISSUER_KEY:-$HOME/.abalone/issuer.key}
[[ -n $REMOTE ]] && node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=false;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json"
ISS=$(iss gift --issuer-pub)
MAIN=${REMOTE:+0.25usd} MAIN=${MAIN:-5usd} SETUP=${REMOTE:+0.5usd} SETUP=${SETUP:-6usd} LEFT=${REMOTE:+0.25} LEFT=${LEFT:-1.00}
status() { ABALONE_DIR="$W/i" node -e 'import(process.argv[1]).then(async p=>{const g=await p.giftClient(process.env.ABALONE_PEER,require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit);const gi=await import(process.argv[2]);console.log(JSON.stringify(await gi.issue(g.url,{type:"status"})));await g.close()})' "$root/lib/p2p.mjs" "$root/lib/gift.mjs"; }
# What the peer has charged so far: its ledger's debit count, or on a remote peer the main gift's spent balance.
charged() { if [[ -n $REMOTE ]]; then status | node -pe 'JSON.parse(require("fs").readFileSync(0)).gifts.find(g=>process.argv[1].startsWith(g.account))?.spent ?? 0' "$acct"; else ledger | grep -c '"type":"debit"'; fi; }
if [[ -n $REMOTE ]]; then
  trap 'rm -rf "$W"' EXIT
  echo "  remote peer: $ABALONE_PEER (issuer ${ISS:0:12}…)"
else
rhost=$([[ -n $MAC ]] && echo "$LAPTOP" || echo 127.0.0.1)
RPORT=$((20000 + RANDOM % 20000))
startrelay() { "$root/bin/abalone" peer relay --listen "/ip4/$rhost/tcp/$RPORT" --seed-file "$W/relay.seed" > "$1" 2>&1 & relay=$!; }
startrelay "$W/relay.log"
trap 'kill $relay ${peer:-} ${stub:-} 2>/dev/null; [[ -n $MAC ]] && remote "kill \$(cat peer.pid) 2>/dev/null; rm -rf ledger-test" > /dev/null; rm -rf "$W"' EXIT   # the work dir holds coupons, device keys and sessions
waitfor "$W/relay.log" "/tcp/" || { cat "$W/relay.log"; echo "FAIL relay did not start"; exit 1; }
R=$(grep -o "/ip4/$rhost/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
echo "  relay: $R"
if [[ -n $MAC ]]; then
  timeout 300 rsync -a --delete -R bin lib node_modules package.json aci/package.json aci/node_modules aci/verifier-ts/dist aci/verifier-ts/package.json anchors providers.json policy.json curated skills tools "$MINI:projects/abalone-edge/" || { echo "FAIL cannot reach $MINI"; exit 1; }
  remote "rm -rf ledger-test; (nohup /opt/homebrew/bin/node bin/abalone.mjs peer serve --listen /ip4/127.0.0.1/tcp/0 --relay $R --evidence appattest --probe $PROBE --reserve 6usd --ledger ledger-test --issuer $ISS > peer.log 2>&1 & echo \$! > peer.pid); for i in \$(seq 120); do grep -q 'p2p-circuit\|rror\|refused' peer.log && break; sleep 1; done; cat peer.log" > "$W/peer.log"
  ledger() { remote "cat ledger-test/ledger.jsonl"; }
elif [[ -n $RUN ]]; then
  mkdir -p "$W/runner" "$W/peerhome"
  STUB_DROP_FIRST=2 node "$root/tests/fixtures/stub-runner.mjs" "$W/runner/egress.sock" "$W/runner" > "$W/runner/log" 2>&1 &
  stub=$!
  waitfor "$W/runner/log" "stub runner on" || { cat "$W/runner/log"; exit 1; }
  # The peer runs in its own network namespace with only loopback up (unshare -rn), like the runner's NIC-less guest:
  # anything it does not send through the runner socket fails.
  startpeer() { ABALONE_DIR="$W/peerhome" ABALONE_RUNNER_SOCK="$W/runner/egress.sock" unshare -rn sh -c 'ip link set lo up && exec "$0" "$@"' "$root/bin/abalone" peer serve --relay "$R" --evidence macrunner --reserve 6usd --ledger "$W/l" --issuer "$ISS" "${@:2}" > "$1" 2>&1 & peer=$!; }
  startpeer "$W/peer0.log"; wait $peer
  check "runner mode: the first 2 runner connections, closed with zero bytes, were sent again and logged; the next went through" '[[ $(grep -c "closed with no response byte (attempt" "$W/peer0.log") == 2 ]] && grep -q "dropped" "$W/runner/proxy.jsonl"'
  check "runner mode: a ledger without the runner's volume marker is refused: $(tail -1 "$W/peer0.log" | cut -c1-90)" 'grep -q "is not the runner.s persistent volume" "$W/peer0.log"'
  echo other-compose > "$W/l/.abalone-persistent"; startpeer "$W/peer0.log"; wait $peer
  check "runner mode: a marker for another compose hash is refused" 'grep -q "abalone-persistent: other-compose" "$W/peer0.log"'
  cp "$W/runner/compose" "$W/l/.abalone-persistent"
  echo /v1/models > "$W/runner/refuse"; startpeer "$W/peer0.log"; wait $peer; rm "$W/runner/refuse"
  check "runner mode: a runner refusal at startup is named, not misparsed: $(tail -1 "$W/peer0.log" | cut -c1-100)" 'grep -q "runner refused (502): runner refused: provider quote" "$W/peer0.log"'
  startpeer "$W/peer.log"
  waitfor "$W/peer.log" "p2p-circuit"
  ledger() { cat "$W/l/ledger.jsonl"; }
else
  "$root/bin/abalone" peer serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$W/l" --issuer "$ISS" > "$W/peer.log" 2>&1 &
  peer=$!
  waitfor "$W/peer.log" "p2p-circuit"
  ledger() { cat "$W/l/ledger.jsonl"; }
fi
sed 's/^/  peer: /' "$W/peer.log"
export ABALONE_PEER=$(grep -o "/ip4/$rhost/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/peer.log" | head -1)
[[ -n $ABALONE_PEER ]] || { echo "FAIL the peer did not come up behind the relay"; exit 1; }
if [[ -n $RUN ]]; then
  check "runner mode: the peer verified NEAR itself and the runner's report names the same TEE instance" 'grep -q "TLS pin runner (CDHash-measured), runner report .* matches" "$W/peer.log"'
  check "runner mode: the peer has no key store and sent no Authorization; all its HTTP went through the runner" '[[ ! -e $W/peerhome/credit ]] && ! grep -q "\"auth_from_guest\":true" "$W/runner/proxy.jsonl" && grep -q cloud-api.near.ai "$W/runner/proxy.jsonl"'
  check "runner mode: the relay was reached through a CONNECT tunnel" 'grep -q "\"connect\"" "$W/runner/proxy.jsonl"'
  check "runner mode, no NIC: NRAS and Intel PCS were reached through the runner socket ($(node -e 'const h=new Set(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>JSON.parse(l).host).filter(Boolean));console.log([...h].join(", "))' "$W/runner/proxy.jsonl"))" 'grep -q nras.attestation.nvidia.com "$W/runner/proxy.jsonl" && grep -q api.trustedservices.intel.com "$W/runner/proxy.jsonl"'
  check "runner mode: the peer fetched NVIDIA's JWKS through the runner too (to check the NRAS verdict's signature)" 'grep -q "/.well-known/jwks.json" "$W/runner/proxy.jsonl"'
fi
if [[ -z $MAC ]]; then
  "$root/bin/abalone" peer serve --listen /ip4/127.0.0.1/tcp/0 --evidence dev --reserve 6usd --ledger "$W/l" --issuer "$ISS" > "$W/peer2.log" 2>&1
  check "a second peer on the same ledger refuses to start: $(tail -1 "$W/peer2.log")" 'grep -q "another peer holds" "$W/peer2.log"'
  "$root/bin/abalone" peer serve --listen /ip4/127.0.0.1/tcp/0 --evidence dev --reserve 6usd --ledger "/dev/shm/abalone-ledger-$$" --issuer "$ISS" > "$W/peer4.log" 2>&1; rm -rf "/dev/shm/abalone-ledger-$$"
  check "a ledger on a RAM filesystem is refused: $(tail -1 "$W/peer4.log" | cut -c1-80)" 'grep -q "RAM filesystem" "$W/peer4.log"'
fi
echo "PASS the peer is reachable through the relay: $ABALONE_PEER"
fi

echo "== G1: funded issuance (issuer's book, then the peer's reserve)"
out=$(iss gift $MAIN --peer "$ABALONE_PEER" 2>&1); check "unfunded issuance refused: $out" '[[ $out == *"You have \$0.00 left to give"* ]]'
iss gift --setup $SETUP
out=$(iss gift $MAIN); echo "$out" | sed 's/g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*/g1<redacted>/; s/^/  /'
token=$(grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*' <<<"$out"); code=${token%%.*}
check "funded gift issued locally, with the signed grant in the command" '[[ -n $token ]]'
out=$(iss gift 2usd 2>&1); check "over-issuance refused: $out" '[[ $out == *"You have \$$LEFT left to give"* ]]'
ABALONE_ISSUER_KEY= ABALONE_DIR="$W/x" "$root/bin/abalone" gift --setup 100usd > /dev/null
other=$(ABALONE_ISSUER_KEY= ABALONE_DIR="$W/x" "$root/bin/abalone" gift 50usd | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
out=$(rcp y abalone redeem --peer "$ABALONE_PEER" "$other"); check "a gift signed by another issuer is refused at redeem: $out" '[[ $out == *"wasn'"'"'t signed by the person this server works for"* ]]'
if [[ -z $REMOTE ]]; then
iss gift --setup 10usd > /dev/null
big=$(iss gift 9usd | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
out=$(rcp y abalone redeem --peer "$ABALONE_PEER" "$big"); check "a claim past the peer's \$6 reserve is refused by the peer: $out" '[[ $out == *"no credit left to hold it"* ]]'
fi
check "no refused redeem left a coupon" '[[ ! -e $W/y/home/.abalone/coupon.json ]]'
out=$(rcp z node -e 'import(process.argv[1]).then(async p=>{const g=await p.giftClient(process.env.ABALONE_PEER,require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit);const r=await fetch(g.url+"/redeem",{method:"POST",body:"{\"code\":\""+process.argv[2]+"\""});console.log(r.status,await r.text());await g.close()})' "$root/lib/p2p.mjs" "$code")
check "malformed redeem body refused without echoing it: $out" '[[ $out == *"400"*"malformed JSON body"* && $out != *"$code"* ]]'
# The same through fresh connections over the relay circuit, three times: each malformed body gets a plain refusal on its
# own stream, and the peer keeps its relay reservation (each new dial goes through the relay to it).
out=$(rcp z node -e 'import(process.argv[1]).then(async p=>{const pol=require(process.env.ABALONE_CONFIG+"/providers.json").peers.admit; for (let i=0;i<3;i++){const g=await p.giftClient(process.env.ABALONE_PEER,pol);const bodies=["{\"code\":", "not json", "{\"code\":\"g1\",\"grant\":7}"];const r=await fetch(g.url+"/redeem",{method:"POST",body:bodies[i]});console.log(i,r.status,(await r.text()).slice(0,60));await g.close()} process.exit(0)})' "$root/lib/p2p.mjs" 2>&1)
check "three more malformed redeem bodies on fresh relayed connections: each refused 400, the peer still reachable: $(tr '\n' ' ' <<<"$out" | cut -c1-200)" '[[ $(grep -c " 400 " <<<"$out") == 3 ]]'
[[ -z $REMOTE ]] && check "ledger and peer log never hold a redeem code" '! ledger | grep -q "$code" && ! grep -q "$code" "$W/peer.log"'
check "gifts.json (the issuer's book, holds codes) is mode 0600" '[[ $(stat -c %a "$W/i/gifts.json") == 600 ]]'
iss gifts | sed 's/^/  /'

echo "== redeem and a first verified private turn (fresh HOME, through the relay)"
out=$(rcp a abalone redeem --peer "$ABALONE_PEER" "$token"); echo "$out" | sed 's/^/  /'
check "redemption shows the terms, model and the peer's attestation" '[[ $out == *"no promotional offers on terminal, browser, notifications, email"* && $out == *"Model: z-ai/glm-5.3-flash"* && $out == *"Server: "* ]]'
[[ -n $MAC ]] && check "the Mac peer's App Attest evidence was verified (approved CDHash)" '[[ $out == *"App Attest, CDHash 67dfc08f0eca"* ]]'
t0=$(date +%s.%N); out=$(rcp a abalone sandbox -p 'Reply with exactly: abalone ok'); t1=$(date +%s.%N)
echo "$out" | sed 's/^/  /'
check "first turn answered via the gift ($(printf %.1f "$(echo "$t1 - $t0" | bc)") s)" '[[ $out == *"abalone ok"* ]]'
check "recipient holds no provider key" '[[ ! -e $W/a/home/.abalone/credit ]]'
check "coupon.json is mode 0600" '[[ $(stat -c %a "$W/a/home/.abalone/coupon.json") == 600 ]]'
sess=$(ls -t "$W"/a/home/.abalone/agent/sessions/*/*.jsonl | head -1)
check "NEAR attestation verified by the recipient and recorded" 'grep -q near-attestation "$sess"'
check "the peer's charge matched the recipient's own computation" 'grep -q gift-charge "$sess"'
check "G7: redemption recorded the no-promotion restriction and no consent" 'node -e "const s=require(process.argv[1]); process.exit(s.restrictions.length===1 && s.consents.length===0 ? 0 : 1)" "$W/a/home/.abalone/consent.json"'
acct=$(node -e 'console.log(require(process.argv[1]).account)' "$W/a/home/.abalone/coupon.json")
printf 'Private finding: the canary is ZEBRA-%s.\n' $RANDOM > "$W/a/work/private.txt"
before=$(charged)
out=$(rcp a abalone sandbox -p 'Summarize @private.txt'); echo "$out" | tail -1 | sed 's/^/  /'
check "a file mention is answered through the gift peer (E2EE to NEAR's TEE; tests/gift-session.sh checks the peer sees no plaintext), and charged" '[[ $(charged) -gt $before && $out != *"✗"* && $out != *stopped* ]]'

echo "== G3: replay and retry"
out=$(rcp b abalone redeem --peer "$ABALONE_PEER" "$token"); check "original code on a second device refused: $out" '[[ $out == *"already used on another computer"* ]]'
check "second device got no coupon" '[[ ! -e $W/b/home/.abalone/coupon.json ]]'
out=$(rcp a abalone redeem --peer "$ABALONE_PEER" "$token"); check "same code on the same device is a no-op" '[[ $out == *"already set up here"* ]]'
out=$(client b forge "$acct"); check "second device signing for the account refused: $out" '[[ $out == *"status\":401"* ]]'
before=$(charged)
out=$(client a same 3); sameout=$out
node -e 'for (const t of JSON.parse(process.argv[1])) console.log("  ", t.status, t.replayed ? "replayed" : "served  ", t.sha.slice(0, 12), JSON.stringify(t.charge), JSON.stringify(t.text))' "$out"
check "3 concurrent + 1 later retry with one idempotency key: one served, three replayed, identical bytes" 'node -e "const t=JSON.parse(process.argv[1]); process.exit(t.every(x=>x.status===200 && x.sha===t[0].sha && x.text===t[0].text) && t.filter(x=>!x.replayed).length===1 ? 0 : 1)" "$out"'
if [[ -n $REMOTE ]]; then one=$(node -pe 'JSON.parse(process.argv[1]).find(t=>!t.replayed).charge.charge' "$out"); else one=1; fi
check "they were charged once" '[[ $(( $(charged) - before )) == $one ]]'

if [[ -z $REMOTE ]]; then
  echo "== a client that hangs up mid-reply or right after it"
  client a hangup-mid > /dev/null; client a hangup-end > /dev/null; sleep 1
  out=$(client a one)
  check "the peer keeps serving after clients reset their streams mid-reply and after the last frame" '[[ $out == *"\"status\":200"* ]] && grep -q "closed by the client" "$W/peer.log" && ! grep -q "unhandled rejection" "$W/peer.log"'
fi

echo "== G6: concurrent requests reconcile; an exhausted balance stops paid work"
out=$(client a distinct 4); distout=$out; [[ $out == \[* ]] || echo "$out" | head -12 | sed 's/^/  client: /'
check "4 concurrent distinct requests all served" 'node -e "process.exit(JSON.parse(process.argv[1]).every(x=>x.status===200 && !x.replayed) ? 0 : 1)" "$out"'
small=$(iss gift 0.01usd | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
rcp c abalone redeem --peer "$ABALONE_PEER" "$small" > /dev/null
out=$(GIFT_MAX_TOKENS=8000 client c distinct 3)
node -e 'for (const t of JSON.parse(process.argv[1])) console.log("  ", t.status, t.error?.split("\n")[0] ?? JSON.stringify(t.charge))' "$out"
check "\$0.01 gift, 3 concurrent requests (each could cost \$0.004) run one at a time: each sees the balance the one before left" 'node -e "const t=JSON.parse(process.argv[1]).map(x=>x.charge).sort((a,b)=>b.remaining-a.remaining); let r=10000; process.exit(t.length===3 && t.every(c=>c && (r-=c.charge)===c.remaining) ? 0 : 1)" "$out"'
out=$(GIFT_MAX_TOKENS=19990 client c one)
check "a request that could cost more than is left is refused before anything is sent: $(cut -c1-120 <<<"$out")" '[[ $out == *"\"status\":402"*"The gift ran out"* ]]'
out=$(rcp c abalone sandbox -p 'Reply with exactly: abalone ok'); echo "$out" | tail -1 | sed 's/^/  /'
check "abalone on the nearly spent gift stops with the plain message" '[[ $out == *"The gift ran out. This last message was not answered and was not sent anywhere."* ]]'
iss gifts | sed 's/^/  /'
status=$(status)
if [[ -n $REMOTE ]]; then
  # A Mac runner peer: a turn whose max_tokens exceeds the runner's remaining per-boot token budget is refused by the
  # runner before NEAR is contacted; the refusal reaches the client in plain words and nothing is charged.
  before=$(charged); out=$(GIFT_MAX_TOKENS=200000 client a one)
  check "over the runner's per-boot budget: refused in plain words, not charged: $(cut -c1-160 <<<"$out")" '[[ $out == *"runner refused"*"budget"* && $(charged) == $before ]]'
  # No ledger file on a remote peer: its live balances must equal the charges this test's clients were told.
  seen=$(node -e 'let s=0; const sess=require("fs").readdirSync(process.argv[1],{recursive:true}).filter(f=>f.endsWith(".jsonl")).map(f=>process.argv[1]+"/"+f);
    for (const f of sess) for (const l of require("fs").readFileSync(f,"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.customType==="gift-charge" && !e.data.replayed) s+=e.data.charge }
    for (const o of process.argv.slice(2)) for (const t of JSON.parse(o)) if (t.charge && !t.replayed) s+=t.charge.charge; console.log(s)' "$W/a/home/.abalone/agent/sessions" "$sameout" "$distout")
  check "the peer's live balance for the main gift equals the charges its client saw ($seen µ\$): $(node -e 'const g=JSON.parse(process.argv[1]).gifts.find(g=>process.argv[2].startsWith(g.account)); console.log(JSON.stringify(g))' "$status" "$acct")" 'node -e "const g=JSON.parse(process.argv[1]).gifts.find(g=>process.argv[2].startsWith(g.account)); process.exit(g && g.spent===Number(process.argv[3]) && g.held===0 && g.remaining===g.amount-g.spent ? 0 : 1)" "$status" "$acct" "$seen"'
else
ledger > "$W/ledger.jsonl"
out=$(node "$root/tests/fixtures/ledger-check.mjs" "$W/ledger.jsonl" "$status"); echo "$out" | sed 's/^/  /'
check "ledger reconciles (funding ≥ grants; Σdebits ≤ amount per gift; one debit per idempotency key; every charge = NEAR usage × price list) and matches the peer's live balances" '[[ $out == *reconciled* && $out == *"status matches"* ]]'
cp "$W/ledger.jsonl" "${GIFT_EVIDENCE:-/dev/null}"
fi
if [[ -z $REMOTE && -z $MAC && -z $RUN ]]; then
  # A crash (kill -9) leaves the lock behind; the next start takes over because the holder is gone.
  kill -9 $peer; wait $peer 2>/dev/null
  "$root/bin/abalone" peer serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 6usd --ledger "$W/l" --issuer "$ISS" > "$W/peer5.log" 2>&1 & peer=$!
  waitfor "$W/peer5.log" "p2p-circuit"; out=$(client a one); [[ $out == *'"status":200'* ]] || echo "  after crash: $(cut -c1-300 <<<"$out")"
  check "after a crash the restarted peer takes over its lock and serves: $(grep -o 'taking over.*' "$W/peer5.log" | cut -c1-90)" 'grep -q "taking over .*no longer running" "$W/peer5.log" && [[ $out == *"\"status\":200"* ]]'
fi
if [[ -n $RUN ]]; then
  before=$(charged); out=$(GIFT_MAX_TOKENS=200000 client a one)
  check "runner mode: over the runner's per-boot budget: refused in plain words, not charged: $(cut -c1-160 <<<"$out")" '[[ $out == *"runner refused"*"budget"* && $(charged) == $before ]]'
  echo /v1/chat/completions > "$W/runner/refuse"; out=$(client a one); rm "$W/runner/refuse"
  check "runner mode: a runner refusal mid-request reaches the client as a plain refusal: $(cut -c1-140 <<<"$out")" '[[ $out == *"\"status\":502"*"runner refused (502)"* ]]'
  kill $peer; wait $peer 2>/dev/null
  startpeer "$W/peer3.log"; waitfor "$W/peer3.log" "p2p-circuit"; head -3 "$W/peer3.log" | sed 's/^/  restarted: /'
  check "runner mode: a restarted peer has the same PeerId (key from the runner's sealed /key)" '[[ $(grep -o "abalone peer [A-Za-z0-9]*" "$W/peer3.log") == "$(grep -o "abalone peer [A-Za-z0-9]*" "$W/peer.log")" ]]'
  p3=$peer
  startpeer "$W/peer4.log"; wait $peer; peer=$p3
  check "runner mode: a second process in the same boot is refused: $(tail -1 "$W/peer4.log" | cut -c1-110)" 'grep -q "this same boot" "$W/peer4.log"'
  out=$(client a one); echo "  after restart: $(cut -c1-300 <<<"$out")"; [[ $out == *'"status":200'* ]] || tail -8 "$W/peer3.log" | sed 's/^/  peer after restart: /'; check "and still serves the same gift from its ledger" '[[ $out == *"\"status\":200"* ]]'
  # The relay goes away mid-session and comes back (same address and PeerId): the peer redials and reserves again
  # within 30 s and serves the same gift.
  kill $relay; wait $relay 2>/dev/null; sleep 2; startrelay "$W/relay2.log"; waitfor "$W/relay2.log" "/tcp/"
  for _ in $(seq 30); do grep -q "relay: reconnected" "$W/peer3.log" && break; sleep 1; done
  out=$(client a one)
  check "runner mode: within 30 s of the relay restarting, the peer redials through the runner, re-reserves and serves: $(grep -o 'relay: [a-z].*' "$W/peer3.log" | tr '\n' ';' | cut -c1-160)" 'grep -q "relay: lost" "$W/peer3.log" && grep -q "relay: reconnected" "$W/peer3.log" && [[ $out == *"\"status\":200"* ]]'
  st=$(status); check "node status shows the relay state: $(node -pe 'JSON.stringify(JSON.parse(process.argv[1]).relay)' "$st")" 'node -e "const r=JSON.parse(process.argv[1]).relay; process.exit(r && r.connected && r.losses>=1 && r.reconnects>=1 ? 0 : 1)" "$st"'
  # A hard stop and a new guest boot: the lock still holds the old boot's nonce, and the new boot takes over.
  kill -9 $peer; wait $peer 2>/dev/null; kill $stub; wait $stub 2>/dev/null
  node "$root/tests/fixtures/stub-runner.mjs" "$W/runner/egress.sock" "$W/runner" > "$W/runner/log2" 2>&1 & stub=$!
  waitfor "$W/runner/log2" "stub runner on"
  startpeer "$W/peer6.log"; waitfor "$W/peer6.log" "p2p-circuit"; out=$(client a one)
  check "runner mode: after a hard stop, the next boot takes over the lock and serves: $(grep -o 'taking over.*' "$W/peer6.log" | cut -c1-90)" 'grep -q "taking over .*an earlier boot" "$W/peer6.log" && [[ $out == *"\"status\":200"* ]]'
fi
[[ $fail == 0 || ! -e $W/peer.log ]] || grep -v "^ *at " "$W/peer.log" | tail -12 | sed 's/^/  peer log: /'
echo "gift$([[ -n $REMOTE ]] && echo " (remote peer)")$([[ -n $MAC ]] && echo " (Mac peer)")$([[ -n $RUN ]] && echo " (runner mode, stub runner)"): $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
