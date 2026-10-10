#!/usr/bin/env bash
# The redeemed gift as a model place in the session (curated/peer-provider.ts), with live NEAR through a gift peer. Spend: cents.
#   tests/gift-session.sh                  a dev peer here behind a local relay, a $0.25 gift; the peer logs every request
#                                          it receives and every frame it sends (ABALONE_PEER_WIRE_LOG)
#   ABALONE_PEER=<multiaddr> tests/gift-session.sh
#                                          an existing peer (the admitted Mac runner): the repo's admission (no dev peers),
#                                          a $0.10 gift signed with the local issuer key (ABALONE_ISSUER_KEY, default
#                                          ~/.abalone/issuer.key) into a temporary book; no wire log, so no peer-side canary check
# The recipient has an empty HOME and no provider key.
# Checks: the picker and the strip name the place (NEAR's TEE via the peer) and the balance; a typed turn goes through the
# peer and the balance drops by exactly its charge; a private @file turn and an in-content tool read go straight to the
# model, and the peer never sees the file's text or its canary, raw, hex or base64 (it sees ciphertext, sizes, usage); every
# reply verifies against NEAR's per-chat gateway signature before any of its tool lines run.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/abgs.XXXX)" REMOTE=${ABALONE_PEER:-} MODEL=z-ai/glm-5.3-flash
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" 2>/dev/null && return 0; grep -q "rror\|refused" "$1" 2>/dev/null && return 1; sleep 1; done; return 1; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[2]+")")(l))' "$1" "$2"; }
answer='es.filter(e=>e.type==="message_end"&&e.message.role==="assistant").at(-1).message'
text="$answer.content.filter(c=>c.type===\"text\").map(c=>c.text).join(\"\")"
selects='es.filter(e=>e.type==="extension_ui_request"&&e.method==="select").length'
charges='es.filter(e=>e.type==="entry_appended"&&e.entry.customType==="gift-charge").map(e=>e.entry.data.charge)'
mkdir -p "$W/config/curated" "$W/i" "$W/l" "$W/r/home" "$W/r/work"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/curated/manifest.json" "$W/config/curated/"
node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=process.argv[2]==="1";require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json" "$([[ -z $REMOTE ]] && echo 1)"
ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null
export ABALONE_CONFIG="$W/config"
iss() { ABALONE_DIR="$W/i" "$root/bin/abalone" "$@"; }
rcp() { (cd "$W/r/work" && env -i XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" ABALONE_NO_CANARIES=1 PATH="$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" HOME="$W/r/home" ABALONE_DIR="$W/r/home/.abalone" \
  ABALONE_CONFIG="$W/config" TERM=dumb "$@" < /dev/null); }
drive() { rcp node "$root/tests/session-drive.mjs" "gift/$MODEL" "$1"; }
left() { node -pe 'require(process.argv[1]).remaining' "$W/r/home/.abalone/gift-left.json"; }
if [[ -n $REMOTE ]]; then
  export ABALONE_ISSUER_KEY=${ABALONE_ISSUER_KEY:-$HOME/.abalone/issuer.key}
  trap 'rm -rf "$W"' EXIT
  AMOUNT=0.1usd hop="Mac peer"
else
  "$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
  trap 'kill $relay ${peer:-} 2>/dev/null; rm -rf "$W"' EXIT   # the work dir holds coupons and device keys
  waitfor "$W/relay.log" "/tcp/" || { cat "$W/relay.log"; exit 1; }
  R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
  ABALONE_PEER_WIRE_LOG="$W/wire.jsonl" "$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 1usd --ledger "$W/l" --issuer "$(iss gift --issuer-pub)" > "$W/peer.log" 2>&1 & peer=$!
  waitfor "$W/peer.log" "p2p-circuit" || { cat "$W/peer.log"; exit 1; }
  export ABALONE_PEER=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/peer.log" | head -1)
  AMOUNT=0.25usd hop="unattested dev peer"
fi
echo "  peer: $ABALONE_PEER"
iss gift --setup "$AMOUNT" > /dev/null
token=$(iss gift "$AMOUNT" --peer "$ABALONE_PEER" | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*')
out=$(rcp abalone redeem --peer "$ABALONE_PEER" "$token" 2>&1) || { echo "FAIL redeem: $out"; exit 1; }; echo "$out" | sed 's/^/  /'
l0=$(left); check "redeem records the balance the peer reported ($l0 µ\$)" '[[ $l0 == $(node -pe "Math.round(parseFloat(process.argv[1])*1e6)" "$AMOUNT") ]]'
label="◈ attested (NEAR TEE · via $hop, which sees ciphertext and metadata)"

echo "== the picker (tmux, 220 columns)"
t=abalone-gift-$$
tmux new-session -d -s $t -x 220 -y 40 "cd $W/r/work && env -i XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR NO_COLOR=1 ABALONE_NO_CANARIES=1 PATH=$root/bin:$(dirname "$(command -v node)"):/usr/bin:/bin HOME=$W/r/home ABALONE_DIR=$W/r/home/.abalone ABALONE_CONFIG=$W/config TERM=xterm-256color $root/bin/abalone; sleep 30"
for _ in $(seq 60); do tmux capture-pane -t $t -p | grep -q "/model to change" && break; sleep 0.5; done
tmux send-keys -t $t "/model" Enter; for _ in $(seq 40); do tmux capture-pane -t $t -p | grep -q "\[gift\]" && break; sleep 0.5; done
tmux capture-pane -t $t -p > "$W/picker.txt"; tmux kill-session -t $t
grep -A1 "\[gift\]" "$W/picker.txt" | head -3 | sed 's/^/  /'
check "the picker shows the gift's models as NEAR's TEE via the peer, with the balance (the TUI wraps at 100 columns)" 'tr -s "\n" " " < "$W/picker.txt" | grep -qF "$MODEL [gift] $label · gift \$0."'
check "the footer (100 columns, short form) names the model and the balance" 'grep -qF "◈ glm-5.3-flash not yet checked · nothing shared · no canaries · gift \$0." "$W/picker.txt"'

echo "== a typed turn through the peer"
drive "Reply with exactly: abalone ok" > "$W/ev1" 2> "$W/err1" || cat "$W/err1"
echo "  answer: $(ev "$W/ev1" "$text.slice(0,80)")"
charge=$(ev "$W/ev1" "$charges.at(-1)")
status='es.filter(e=>e.method==="setStatus"&&e.statusKey==="abalone").at(-1).statusText'
echo "  strip: $(ev "$W/ev1" "$status")"; echo "  charge: $charge µ\$, left $(left) µ\$"
check "answered through the peer; NEAR's attestation verified here (our nonce, through the peer) and recorded for the gift provider" \
  '[[ $(ev "$W/ev1" "$text") == *"abalone ok"* && $(ev "$W/ev1" "es.filter(e=>e.type===\"entry_appended\"&&e.entry.customType===\"near-attestation\").at(-1).entry.data.provider") == gift ]]'
check "the NRAS verdict's signature was checked here, on the peer path" '[[ $(ev "$W/ev1" "es.filter(e=>e.type===\"entry_appended\"&&e.entry.customType===\"near-attestation\").at(-1).entry.data.gpu") == "GPU: NVIDIA verdict (signature checked)" ]]'
check "the balance dropped by exactly the turn's charge" '[[ $charge -gt 0 && $(left) == $((l0 - charge)) ]]'
check "the strip (80 columns) names the model and the balance" '[[ $(ev "$W/ev1" "$status") == "◈ glm-5.3-flash tcb:"*" · nothing shared · no canaries · gift \$0."* ]]'

echo "== private file turns: straight to NEAR's TEE, ciphertext at the peer"
canary="ZEBRA-$RANDOM$RANDOM"
printf 'Quarterly notes, confidential.\nThe project code word is %s.\nDo not share outside the team.\n' "$canary" > "$W/r/work/secret.txt"
l1=$(left); drive "@secret.txt What is the project code word? Reply with just the word." > "$W/ev2" 2> "$W/err2" || cat "$W/err2"
echo "  answer: $(ev "$W/ev2" "$text.slice(0,80)")"
check "the @file turn is answered from the file, with no pour prompt, and charged" '[[ $(ev "$W/ev2" "$selects") == 0 && $(ev "$W/ev2" "$text") == *"$canary"* && $(left) -lt $l1 ]]'
drive "Use your read tool on secret.txt (do not guess), then tell me the code word in it." > "$W/ev3" 2> "$W/err3" || cat "$W/err3"
tools=$(ev "$W/ev3" 'es.filter(e=>e.type==="entry_appended"&&e.entry.customType==="abalone-tool").length')
echo "  tool rounds: $tools; answer: $(ev "$W/ev3" "$text.slice(0,80)")"
check "an in-content tool read runs here and its result goes back to the model" '[[ $tools -ge 1 && $(ev "$W/ev3" "$text") == *"$canary"* ]]'
sigs() { cat "$W"/ev1 "$W"/ev2 "$W"/ev3 | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse).filter(e=>e.type==="entry_appended"&&e.entry.customType==="near-signature").map(e=>e.entry.data); console.log(l.length, l.filter(d=>d.verified).length, [...new Set(l.map(d=>d.kind))].join(","), JSON.stringify([...new Set(l.map(d=>d.reason))]).replace(/ /g,"_"))'; }
read n ok gw why < <(sigs); echo "  NEAR chat signatures: $n replies, $ok verified, kind $gw, failures $why"
check "every reply through the peer carried NEAR's signature (the attested model key, provider_tee) over this request and these bytes, verified here before its tools ran" '[[ $n -ge 4 && $ok == $n ]]'
if [[ -z $REMOTE ]]; then
  hex=$(printf %s "$canary" | xxd -p | tr -d '\n') b64=$(printf %s "$canary" | base64)
  echo "  wire: $(wc -l < "$W/wire.jsonl") records, $(wc -c < "$W/wire.jsonl") bytes; chat requests: $(grep -c '"url":"/v1/chat/completions"' "$W/wire.jsonl")"
  check "the peer received and sent no canary (raw, hex, base64) and no line of the file" \
    '! grep -qiF -e "$canary" -e "$hex" -e "$b64" -e "Quarterly notes" -e "Do not share outside" -e "secret.txt" "$W/wire.jsonl"'
  check "what the peer relayed was the E2EE ciphertext of those turns (chat bodies carry hex-encrypted content)" \
    'node -e "const l=require(\"fs\").readFileSync(process.argv[1],\"utf8\").trim().split(\"\n\").map(JSON.parse).filter(r=>r.in?.url===\"/v1/chat/completions\"); process.exit(l.length>=4 && l.every(r=>JSON.parse(r.in.body).messages.every(m=>/^[0-9a-f]{200,}$/.test(m.content))) ? 0 : 1)" "$W/wire.jsonl"'
fi
echo "== strict incognito with only a gift: the gift place counts as an admitted TEE destination"
rcp env ABALONE_PASSPHRASE_FD=3 abalone trace key init 3<<<"gift test oyster" > /dev/null
rcp env ABALONE_PASSPHRASE_FD=3 node "$root/tests/incognito-drive.mjs" "gift/$MODEL" "Reply with exactly: incognito ok" 3<<<"gift test oyster" > "$W/ev4" 2> "$W/err4" || cat "$W/err4"
notes4=$(ev "$W/ev4" 'es.filter(e=>e.method==="notify").map(e=>e.message).join("|")')
echo "  answer: $(ev "$W/ev4" "$text.slice(0,60)")"
check "a gift-only friend can start strict incognito; the turn goes to the gift place, labelled as seeing ciphertext and metadata" \
  '[[ $(ev "$W/ev4" "$text") == *"incognito ok"* && $notes4 == *"sent to: $label ($MODEL)"* && $(ev "$W/ev4" "es.filter(e=>e.method===\"setStatus\").map(e=>e.statusText).join(\"|\")") == *"incognito"* ]]'
echo "gift-session$([[ -n $REMOTE ]] && echo " (remote peer)"): $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
