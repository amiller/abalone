#!/usr/bin/env bash
# Chutes, live, direct, per instance. Needs CHUTES_API_KEY (written only into this run's temporary credit store).
# Spend: two short turns on a small TEE model. A logging MITM (tests/mitm/chutes.mjs, own CA) stands in for api.chutes.ai
# through the egress redirect, so the log holds each request exactly as Chutes' API receives it after TLS.
#   1. with a tampered evidence nonce, the instance is refused and no /e2e/invoke request is made;
#   2. a turn runs: the instance is verified, the reply carries a canary only the prompt held, and the invoke body
#      on the wire is octet-stream ciphertext that contains neither the canary nor the model name.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
[[ -n ${CHUTES_API_KEY:-} ]] || { echo "no CHUTES_API_KEY: cannot run"; exit 1; }
printf %s "$CHUTES_API_KEY" | devkey chutes live; unset CHUTES_API_KEY
model=${CHUTES_MODEL:-deepseek-ai/DeepSeek-V3.2-TEE} tmp="$ABALONE_DIR/mitm"; mkdir -p "$tmp"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=mitm-test-ca" -keyout "$tmp/ca.key" -out "$tmp/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=api.chutes.ai" -keyout "$tmp/leaf.key" -out "$tmp/leaf.csr" 2>/dev/null
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca.key" -CAcreateserial -days 1 -extfile <(echo "subjectAltName=DNS:api.chutes.ai") -out "$tmp/leaf.pem" 2>/dev/null
echo nonce > "$tmp/mode"; : > "$tmp/log"
node "$root/tests/mitm/chutes.mjs" "$tmp/leaf.pem" "$tmp/leaf.key" "$tmp/log" "$tmp/mode" > "$tmp/port" & trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$ABALONE_DIR/credit"' EXIT
until [[ -s $tmp/port ]]; do sleep 0.1; done
export NODE_EXTRA_CA_CERTS="$tmp/ca.pem" ABALONE_EGRESS_REDIRECT="api.chutes.ai=127.0.0.1:$(cat "$tmp/port")"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
run() { timeout 300 "$root/bin/abalone" sandbox -p --model "chutes/$model" "$1" < /dev/null 2>&1 | grep -v "⌂ local provider"; }
invokes() { grep -c '"url":"/e2e/invoke"' "$tmp/log"; }
out=$(run "Reply with exactly: abalone ok"); echo "  tampered nonce: $(tail -1 <<<"$out")"
check "tampered evidence nonce refused" '[[ $out == *"report_data does not bind our nonce"* ]]'
check "no /e2e/invoke request after the refusal" '[[ $(invokes) == 0 ]]'
echo pass > "$tmp/mode"; canary="abalone-$(openssl rand -hex 6)"; since=$(date -u +%FT%T)
out=$(run "Reply with exactly this token and nothing else: $canary"); echo "  reply: $(tail -1 <<<"$out")"
check "live verified E2EE turn returns the canary" '[[ $out == *"$canary"* ]]'
sess=$(ls -t "$ABALONE_DIR"/agent/sessions/*/*.jsonl | head -1)
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.customType==="chutes-attestation") console.log("  attestation:", JSON.stringify(e.data)); }' "$sess"
check "attestation profile saved in the session log" 'grep -q chutes-attestation "$sess"'
node -e 'const [log,canary,model]=process.argv.slice(1);for (const l of require("fs").readFileSync(log,"utf8").trim().split("\n")) { const r=JSON.parse(l),b=Buffer.from(r.body,"base64"); console.log("  wire:", r.method, r.url.replace(/nonce=\w+/,"nonce=…"), r.type, `${b.length} B`, r.url==="/e2e/invoke"?`instance ${r.instance}, canary ${b.includes(canary)?"PRESENT":"absent"}, model name ${b.includes(model)?"PRESENT":"absent"}, first bytes ${b.subarray(0,16).toString("hex")}`:"") }' "$tmp/log" "$canary" "$model"
check "invoke body is ciphertext: octet-stream, no canary, no model name" 'node -e '"'"'const [log,canary,model]=process.argv.slice(1);const rs=require("fs").readFileSync(log,"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.url==="/e2e/invoke");process.exit(rs.length===1&&rs.every(r=>{const b=Buffer.from(r.body,"base64");return r.type==="application/octet-stream"&&!b.includes(canary)&&!b.includes(model)&&b.length>1116})?0:1)'"'"' "$tmp/log" "$canary" "$model"'
check "no request to the plaintext OpenAI route" '! grep -q "chat/completions\"" "$tmp/log"'
hosts=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.ts>=process.argv[2]) console.log(e.host) }' "$ABALONE_DIR/egress.jsonl" "$since" | sort | uniq -c)
echo "$hosts" | sed 's/^/  egress: /'
check "egress only to Chutes, NVIDIA NRAS, Intel PCS and the other admitted hosts" '! grep -vE "chutes.ai|nras.attestation.nvidia.com|trustedservices.intel.com|cloud-api.near.ai|mainnet.base.org|tee.redpill.ai|inference.phala.com|127.0.0.1" <<<"$hosts" | grep -q .'
echo "chutes: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
