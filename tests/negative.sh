#!/usr/bin/env bash
# Negative tests: each tampered provider must be refused with an error naming the failed check,
# and the logging MITM must record zero prompt bytes. The egress redirect stands in for a DNS/route
# hijack outside the sandbox. Needs no API key (a dummy one is used).
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
printf dummy | devkey redpill t
tmp="$ABALONE_DIR/neg"; mkdir -p "$tmp"   # inside ABALONE_DIR, so the sandbox can read the CA
host=tee.redpill.ai
# Every other admitted host goes through a pass-through logging MITM too (a witness), so any prompt byte sent on any
# route is visible. Witnessed providers fail their own SPKI pin; that is expected and not what is tested here.
others=$(node -e 'console.log(require(process.argv[1]).admitted.flatMap(a=>a.hosts).filter(h=>h!==process.argv[2]).join(" "))' "$root/providers.json" "$host")
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=mitm-test-ca" \
  -keyout "$tmp/ca.key" -out "$tmp/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$host" -keyout "$tmp/leaf.key" -out "$tmp/leaf.csr" 2>/dev/null
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca.key" -CAcreateserial -days 1 \
  -extfile <(printf "subjectAltName=%s" "$(printf 'DNS:%s,' $host $others | sed 's/,$//')") -out "$tmp/leaf.pem" 2>/dev/null
fail=0
trap 'kill $(jobs -p) 2>/dev/null' EXIT
canary="CANARY-$(openssl rand -hex 8)"
verifier=$(node -e 'console.log(require(process.argv[1]).verifierHosts.join(" "))' "$root/providers.json")

locals=$(node -e 'console.log(require(process.argv[1]).local.map(l=>new URL(l.baseUrl).port).join(" "))' "$root/providers.json")
# ⌂ local model ports get a plain-HTTP logging witness that answers 404; it fails to start if a real server holds the port.
localw='const [port,log]=process.argv.slice(1);require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{require("fs").appendFileSync(log,JSON.stringify({method:q.method,url:q.url,body:b})+"\n");s.writeHead(404);s.end()})}).listen(+port,"127.0.0.1",()=>console.log(port))'

mitm() { # host (or local:<port>), tamper mode, log file; prints the port
  if [[ $1 == local:* ]]; then node -e "$localw" "${1#local:}" "$3" > "$3.port" &
  else node "$root/tests/mitm/server.mjs" "$tmp/leaf.pem" "$tmp/leaf.key" "$3" "$1" "$2" > "$3.port" & fi
  echo $! > "$3.pid"
  until [[ -s $3.port ]]; do kill -0 $! || { echo "mitm server died" >&2; exit 1; }; sleep 0.1; done
  cat "$3.port"
}

run() { # name, expected error regex, mitm tamper mode (or "none"), extra env...
  local name=$1 expect=$2 tamper=$3; shift 3
  local log="$tmp/$name.mitm.jsonl"; : > "$log"
  local port="" redirect=() ports=()
  local w
  if [[ $tamper != none ]]; then port=$(mitm "$host" "$tamper" "$log") || exit 1; redirect+=("$host=127.0.0.1:$port"); fi
  for h in $others; do : > "$tmp/$name.$h.mitm.jsonl"; w=$(mitm "$h" spki "$tmp/$name.$h.mitm.jsonl") || exit 1; ports+=($w); redirect+=("$h=127.0.0.1:$w"); done
  for p in $locals; do : > "$tmp/$name.local-$p.mitm.jsonl"; w=$(mitm "local:$p" - "$tmp/$name.local-$p.mitm.jsonl") || exit 1; ports+=($w); done
  local envs=(ABALONE_EGRESS_REDIRECT="$(IFS=,; echo "${redirect[*]}")" NODE_EXTRA_CA_CERTS="$tmp/ca.pem")
  local out
  local trace=()
  [[ -n ${NEG_TRACE:-} ]] && trace=(strace -f -e trace=connect -o "$tmp/$name.trace")
  out=$(env "${envs[@]}" "$@" \
    timeout 120 "${trace[@]}" "$root/bin/abalone" sandbox -p --model "redpill/z-ai/glm-5.2" "secret: $canary" < /dev/null 2>&1)
  local code=$?
  kill $(cat "$tmp/$name".*pid)
  local posts prompt witness
  posts=$(grep -c '"method":"POST"' "$log"); prompt=$(grep -c "$canary" "$log")
  witness=$(for h in $others $(printf 'local-%s ' $locals); do printf '%s:%s/%s/%s ' "$h" "$(wc -l < "$tmp/$name.$h.mitm.jsonl")" "$(grep -c '"method":"POST"' "$tmp/$name.$h.mitm.jsonl")" "$(grep -c "$canary" "$tmp/$name.$h.mitm.jsonl")"; done)
  posts=$((posts + $(cat "$tmp/$name".*.mitm.jsonl | grep -c '"method":"POST"'))); prompt=$((prompt + $(cat "$tmp/$name".*.mitm.jsonl | grep -c "$canary")))
  local err; err=$(grep -oE "$expect" <<<"$out" | head -1)
  echo "[$name] exit=$code mitm_requests=$(wc -l < "$log") mitm_posts=$posts mitm_prompt_hits=$prompt (all routes)"
  echo "  witnesses requests/posts/prompt_hits: $witness"
  echo "  error: $(grep -m1 -oE 'ACI[^\"]{0,300}' <<<"$out")"
  if [[ $code -eq 0 || -z $err || $posts -ne 0 || $prompt -ne 0 ]]; then echo "  FAIL (expected /$expect/): $(tail -c 400 <<<"$out")"; fail=1; else echo "  PASS: named check: $err"; fi
  [[ -n ${NEG_TRACE:-} ]] && connects "$name" "$port"
}

# NEG_TRACE=1 (Linux): every TCP connect of the abalone process tree must go to the MITM port, the resolver, or a
# verifier host; with no MITM (release), also to the tampered provider's own hosts. Any other destination is a switch.
connects() {
  local name=$1 port=$2 ok=() bad=0 w=" ${ports[*]} "
  for h in $verifier; do ok+=($(getent ahosts "$h" | awk '{print $1}')); done
  [[ -z $port ]] && for h in $host; do ok+=($(getent ahosts "$h" | awk '{print $1}')); done
  while read -r n p ip; do
    if [[ $ip == 127.0.0.1 && $p == "$port" ]]; then echo "  connect mitm  $ip:$p x$n"
    elif [[ $ip == 127.0.0.1 && $w == *" $p "* ]]; then echo "  connect witness $ip:$p x$n"
    elif [[ $ip == 127.0.0.53 && $p == 53 ]]; then echo "  connect dns   $ip:$p x$n"
    elif [[ " ${ok[*]} " == *" $ip "* ]]; then echo "  connect ok    $ip:$p x$n"
    else echo "  connect BAD   $ip:$p x$n"; bad=1; fi
  done < <(grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' "$tmp/$name.trace" | sed -E 's/\).*"/ /' | sort | uniq -c | awk '{print $1, $2, $3}')
  if [[ $bad -ne 0 ]]; then echo "  FAIL: connect to a destination outside the verified route"; fail=1; else echo "  PASS: connects confined ($tmp/$name.trace)"; fi
}

run spki    'TLS SPKI pin mismatch'                   spki
run keyset  'id-2: [^;]*'                              keyset
run compose 'id-4: [^;]*'                              compose
run release 'id-4: [^;]*not accepted[^;]*|id-4: [^;]*' none REDPILL_ACCEPTED_COMPOSE_HASHES=$(printf '0%.0s' {1..64})
# Gateway failure scope: a provider that fails the gate is refused; the other admitted providers keep working.
printf dummy | devkey phala t
log="$tmp/scope.mitm.jsonl"; : > "$log"
node "$root/tests/mitm/server.mjs" "$tmp/leaf.pem" "$tmp/leaf.key" "$log" "$host" spki > "$tmp/scope.port" & pid=$!
until [[ -s $tmp/scope.port ]]; do sleep 0.1; done
out=$(ABALONE_EGRESS_REDIRECT="$host=127.0.0.1:$(cat "$tmp/scope.port")" NODE_EXTRA_CA_CERTS="$tmp/ca.pem" timeout 120 "$root/bin/abalone" sandbox --list-models < /dev/null 2>&1)
kill $pid
echo "[scope] $(grep -o '✗ refused: provider [a-z]*' <<<"$out"); listed: $(awk 'NR>1 && $1!~/✗|⌂/ {print $1}' <<<"$out" | grep -E '^(redpill|phala)$' | sort | uniq -c | xargs)"
if [[ $out == *"✗ refused: provider redpill"* && $(grep -c '^phala ' <<<"$out") -gt 0 && $(grep -c '^redpill ' <<<"$out") == 0 ]]; then echo "  PASS: redpill refused, phala still listed"; else echo "  FAIL"; fail=1; fi
exit $fail
