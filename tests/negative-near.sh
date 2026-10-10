#!/usr/bin/env bash
# G8 for NEAR, on both routes: direct (node key on this machine) and gift (the route gifts use: the client reaches a real
# gift peer over libp2p through a relay, fetches the report through it and sends E2EE chat to it; the peer pins NEAR's
# SPKI on its own upstream). The peer runs here with --evidence dev, admitted by a config copy (peers.admit.dev).
# Each tampered verification step must be refused with an error naming the failed check, with zero chat POSTs reaching
# NEAR, zero canary bytes on every route, no debit in the peer's ledger, and no retry: at most one refused TLS handshake
# at NEAR (a connection that carries no request is a chat attempt the SPKI pin stopped, from the client or the peer).
# A logging MITM (tests/mitm/near.mjs, own CA) stands in for cloud-api.near.ai and NRAS for the client and the peer
# alike: it relays the live report and NRAS verdict and changes one thing, set per case through a mode file. The client's
# egress redirect, and an egress socket dir with egress-preload for the peer, stand in for a route hijack. Every other
# admitted host gets a pass-through logging witness, and the ⌂ local ports get logging witnesses.
# Needs the real nearai node key (the report endpoint needs auth and a fresh nonce, so it cannot be recorded).
# No chat request reaches NEAR, so nothing is spent.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
key=$(node -e 'const s=require(process.argv[1]);const k=s.keys.find(k=>k.provider==="nearai"&&k.label===s.active.nearai);if(!k)process.exit(1);console.log(k.key)' "$HOME/.abalone/node/keys.json") \
  || { echo "no active nearai key in ~/.abalone/node/keys.json: cannot run"; exit 1; }
devkey nearai neg "$key"
tmp="$ABALONE_DIR/neg"; mkdir -p "$tmp"
near=cloud-api.near.ai nras=nras.attestation.nvidia.com model=z-ai/glm-5.3-flash
others=$(node -e 'console.log(require(process.argv[1]).admitted.flatMap(a=>a.hosts).filter(h=>!process.argv.slice(2).includes(h)).join(" "))' "$root/providers.json" $near $nras)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=mitm-test-ca" -keyout "$tmp/ca.key" -out "$tmp/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$near" -keyout "$tmp/leaf.key" -out "$tmp/leaf.csr" 2>/dev/null
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca.key" -CAcreateserial -days 1 \
  -extfile <(printf "subjectAltName=%s" "$(printf 'DNS:%s,' $near $nras $others | sed 's/,$//')") -out "$tmp/leaf.pem" 2>/dev/null
export NODE_EXTRA_CA_CERTS="$tmp/ca.pem" ABALONE_CONFIG="$tmp/config"
mkdir -p "$ABALONE_CONFIG/curated"; cp "$root/providers.json" "$root/policy.json" "$ABALONE_CONFIG/"; cp "$root/curated/manifest.json" "$ABALONE_CONFIG/curated/"
node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$ABALONE_CONFIG/providers.json"
node "$root/tools/rehash-manifest.mjs" > /dev/null   # the tree under test
fail=0
trap 'kill $(jobs -p) $(cat "$tmp"/*.pid 2>/dev/null) 2>/dev/null' EXIT
canary="CANARY-$(openssl rand -hex 8)"
verifier=$(node -e 'console.log(require(process.argv[1]).verifierHosts.join(" "))' "$root/providers.json")
locals=$(node -e 'console.log(require(process.argv[1]).local.map(l=>new URL(l.baseUrl).port).join(" "))' "$root/providers.json")
localw='const [port,log]=process.argv.slice(1);require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{require("fs").appendFileSync(log,JSON.stringify({method:q.method,url:q.url,body:b})+"\n");s.writeHead(404);s.end()})}).listen(+port,"127.0.0.1",()=>console.log(port))'
reqs() { grep -c '"method"' "$1"; }
# Connections in a MITM log that carried no request: TLS handshakes the client side refused (an SPKI pin).
bare() { node -e 'const ls=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse),used=new Set(ls.map(l=>l.port));console.log(ls.filter(l=>l.conn&&!used.has(l.conn)).length)' "$1"; }
echo pass > "$tmp/pass.mode"

serve() { # log file, then the command; waits for the port it prints
  : > "$1"; local f=$1; shift
  "$@" > "$f.port" & echo $! > "$f.pid"
  until [[ -s $f.port ]]; do kill -0 $! 2>/dev/null || { echo "server for $f died" >&2; exit 1; }; sleep 0.1; done
  cat "$f.port"
}
mitm() { serve "$3" node "$root/tests/mitm/near.mjs" "$tmp/leaf.pem" "$tmp/leaf.key" "$3" "$1" "$2"; }  # host, mode file, log

# Long-lived MITMs for NEAR and NRAS, shared by the clients and the peer.
echo pass | tee "$tmp/near.mode" > "$tmp/nras.mode"
nearport=$(mitm $near "$tmp/near.mode" "$tmp/near.log") || exit 1
nrasport=$(mitm $nras "$tmp/nras.mode" "$tmp/nras.log") || exit 1

# A relay and a gift peer from this tree (the peer's NEAR and NRAS traffic through the MITMs), and a gift redeemed on a fresh client.
mkdir -p "$tmp/pe" "$tmp/pes" "$tmp/i" "$tmp/ledger" "$tmp/r"
ABALONE_DIR="$tmp/pes" ABALONE_EGRESS_REDIRECT="$near=127.0.0.1:$nearport,$nras=127.0.0.1:$nrasport" \
  serve "$tmp/pe.log" node --input-type=module -e 'const { startEgress } = await import(process.argv[1]); await startEgress(process.argv[2], process.argv.slice(3), [], [], "peer"); console.log("up")' "$root/lib/egress.mjs" "$tmp/pe" $near $nras > /dev/null || exit 1
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" && return 0; grep -q "rror\|refused" "$1" && return 1; sleep 1; done; return 1; }
"$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$tmp/relay.log" 2>&1 &
waitfor "$tmp/relay.log" /tcp/ || { echo "relay did not start:"; cat "$tmp/relay.log"; exit 1; }
relay=$(grep -o '/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*' "$tmp/relay.log" | head -1)
iss=$(ABALONE_DIR="$tmp/i" "$root/bin/abalone" gift --issuer-pub)
NODE_OPTIONS="--import $root/curated/egress-preload.mjs" ABALONE_EGRESS="$tmp/pe" \
  "$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$relay" --evidence dev --reserve 1usd --ledger "$tmp/ledger" --issuer "$iss" > "$tmp/peer.log" 2>&1 &
waitfor "$tmp/peer.log" p2p-circuit || { echo "gift peer did not start:"; cat "$tmp/peer.log"; exit 1; }
peer=$(grep -o '/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*' "$tmp/peer.log" | head -1)
echo "peer: $(head -1 "$tmp/peer.log")"
echo "  reached at $peer"
echo "peer's startup verification went through the MITM: $(grep -c attestation/report "$tmp/near.log") report fetch(es), $(grep -c '"method":"POST"' "$tmp/nras.log") NRAS call(s)"
p2pports=$(grep -oh '/ip4/127.0.0.1/tcp/[0-9]*' "$tmp/relay.log" "$tmp/peer.log" | cut -d/ -f5 | sort -u | xargs)
ABALONE_DIR="$tmp/i" "$root/bin/abalone" gift --setup 1usd > /dev/null || { echo "gift funding failed"; exit 1; }
code=$(ABALONE_DIR="$tmp/i" "$root/bin/abalone" gift --peer "$peer" 0.5usd | grep -o 'g1[0-9A-Z]\{31\}\.[A-Za-z0-9_-]*') || { echo "gift issuance failed"; exit 1; }
ABALONE_DIR="$tmp/r" "$root/bin/abalone" redeem --peer "$peer" "$code" > /dev/null || { echo "gift redemption failed"; exit 1; }
echo "gift redeemed on a fresh client (ABALONE_DIR without a NEAR key)"
cp "$tmp/ca.pem" "$tmp/r/ca.pem"   # the client's sandbox sees only its own ABALONE_DIR

run() { # route (direct|gift), case, expected error regex, NEAR mode, NRAS mode
  local route=$1 name=$1-$2 expect=$3 redirect=("$near=127.0.0.1:$nearport" "$nras=127.0.0.1:$nrasport") ports=($nearport $nrasport $p2pports) w
  echo "$4" > "$tmp/near.mode"; echo "$5" > "$tmp/nras.mode"; : > "$tmp/near.log"; : > "$tmp/nras.log"
  for h in $others; do w=$(mitm "$h" "$tmp/pass.mode" "$tmp/$name.w-$h.log") || exit 1; ports+=($w); redirect+=("$h=127.0.0.1:$w"); done
  for l in $locals; do w=$(serve "$tmp/$name.w-local-$l.log" node -e "$localw" "$l" "$tmp/$name.w-local-$l.log") || exit 1; ports+=($w); done
  local dir=$ABALONE_DIR ca="$tmp/ca.pem"; [[ $route == gift ]] && dir="$tmp/r" ca="$tmp/r/ca.pem"
  local debits0; debits0=$(grep -c '"type":"debit"' "$tmp/ledger/ledger.jsonl")
  local trace=(); [[ -n ${NEG_TRACE:-} ]] && trace=(strace -f -e trace=connect -o "$tmp/$name.trace")
  local out code
  out=$(ABALONE_DIR="$dir" NODE_EXTRA_CA_CERTS="$ca" ABALONE_EGRESS_REDIRECT="$(IFS=,; echo "${redirect[*]}")" \
    timeout 180 "${trace[@]}" "$root/bin/abalone" -p --model "nearai/$model" "secret: $canary" < /dev/null 2>&1); code=$?
  printf "%s\n" "$out" > "$tmp/$name.out"; kill $(cat "$tmp/$name".*.pid)
  local chat wposts hits err refused debits
  chat=$(grep -c '"method":"POST","url":"/v1/chat' "$tmp/near.log")
  wposts=$(cat "$tmp/$name".w-*.log | grep -c '"method":"POST"')
  hits=$(cat "$tmp/near.log" "$tmp/nras.log" "$tmp/$name".w-*.log "$tmp/peer.log" "$tmp/relay.log" "$tmp/ledger/ledger.jsonl" | grep -c "$canary")
  refused=$(bare "$tmp/near.log")
  debits=$(( $(grep -c '"type":"debit"' "$tmp/ledger/ledger.jsonl") - debits0 ))
  err=$(grep -m1 -oE "$expect" <<<"$out")
  echo "[$name] exit=$code near_requests=$(reqs "$tmp/near.log") near_chat_posts=$chat near_refused_handshakes=$refused nras_requests=$(reqs "$tmp/nras.log") new_debits=$debits witness_posts=$wposts canary_hits=$hits (all routes, peer and relay logs, ledger)"
  echo "  witnesses requests/posts/canary: $(for f in "$tmp/$name".w-*.log; do b=${f##*.w-}; printf '%s:%s/%s/%s ' "${b%.log}" "$(reqs "$f")" "$(grep -c '"method":"POST"' "$f")" "$(grep -c "$canary" "$f")"; done)"
  if [[ $code -eq 0 || -z $err || $chat -ne 0 || $wposts -ne 0 || $hits -ne 0 || $debits -ne 0 || $refused -gt 1 ]]; then echo "  FAIL (expected /$expect/, no retry): $(tail -c 400 <<<"$out")"; fail=1; else echo "  PASS: named check: $err"; fi
  # The gift endpoint: the launcher's own loopback server for its attested libp2p client, forwarded into the sandbox.
  [[ $route == gift ]] && ports+=($(grep -o '"via":"local","host":"127.0.0.1:[0-9]*' "$dir/egress.jsonl" | cut -d: -f4 | grep -vxF -f <(tr ' ' '\n' <<<"$locals") | sort -u))
  [[ -n ${NEG_TRACE:-} ]] && connects "$name" "${ports[*]}"
}

# NEG_TRACE=1 (Linux): every TCP connect of the client's process tree goes to a MITM or witness port, the relay, the
# peer, the gift endpoint, the resolver, or an Intel verifier host.
connects() {
  local name=$1 w=" $2 " ok=() bad=0
  for h in $verifier; do ok+=($(getent ahosts "$h" | awk '{print $1}')); done
  while read -r n p ip; do
    if [[ $ip == 127.0.0.1 && $w == *" $p "* ]]; then echo "  connect loopback (mitm, witness, relay, peer, gift endpoint) $ip:$p x$n"
    elif [[ $ip == 127.0.0.53 && $p == 53 ]]; then echo "  connect dns   $ip:$p x$n"
    elif [[ " ${ok[*]} " == *" $ip "* ]]; then echo "  connect ok    $ip:$p x$n"
    else echo "  connect BAD   $ip:$p x$n"; bad=1; fi
  done < <(grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' "$tmp/$name.trace" | sed -E 's/\).*"/ /' | sort | uniq -c | awk '{print $1, $2, $3}')
  if [[ $bad -ne 0 ]]; then echo "  FAIL: connect outside the verified route"; fail=1; else echo "  PASS: connects confined ($tmp/$name.trace)"; fi
}

for route in direct gift; do
  run $route nonce 'report_data does not carry our nonce'          nonce pass
  run $route model 'model attestation is for [^,]*, not [^ "]*'     model pass
  run $route gpu   'NVIDIA NRAS verdict is not true'               pass  gpu
  run $route spki  'SPKI pin mismatch for cloud-api.near.ai[^"]*'  pass  pass
done
exit $fail
