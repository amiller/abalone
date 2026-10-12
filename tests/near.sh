#!/usr/bin/env bash
# NEAR AI, live, admitted per model. Needs a configured key (abalone key add nearai)
# and uses the real ~/.abalone. Spend: one short turn on a small TEE model.
#   1. models NEAR proxies to outside vendors (anthropic/*, openai/*) are refused for private agents;
#   2. with the default policy (gateway TCB must be UpToDate) a TEE model is refused while NEAR's gateway is OutOfDate;
#   3. with providers.json nearai.policy.gatewayTcb = "reported" (a config copy), one attested E2EE turn runs.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${ABALONE_DIR:-$HOME/.abalone}"
work="$(mktemp -d)"; cd "$work"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
run() { timeout 300 "$root/bin/abalone" sandbox -p --model "nearai/$1" "Reply with exactly: abalone ok" < /dev/null 2>&1 | grep -v "⌂ local provider"; }
for m in anthropic/claude-fable-5 anthropic/claude-haiku-4-5 openai/gpt-5-nano openai/gpt-4.1-mini; do
  out=$(run "$m"); check "$m refused for private agents: $(tail -1 <<<"$out" | cut -c1-150)" '[[ $out == *"is ○ outside"* ]]'
done
out=$(run z-ai/glm-5.3-flash); echo "  default policy: $(tail -1 <<<"$out")"
check "default policy refuses on gateway TCB" '[[ $out == *"gateway TCB status"*"is not UpToDate"* ]]'
export ABALONE_CONFIG="$work/config"; mkdir -p "$ABALONE_CONFIG/curated"
cp "$root/curated/manifest.json" "$ABALONE_CONFIG/curated/"; cp "$root/policy.json" "$ABALONE_CONFIG/"
node -e 'const p=require(process.argv[1]);p.admitted.find(a=>a.id=="nearai").policy.gatewayTcb="reported";require("fs").writeFileSync(process.argv[2],JSON.stringify(p,null,1))' "$root/providers.json" "$ABALONE_CONFIG/providers.json"
since=$(date -u +%FT%T)
out=$(run z-ai/glm-5.3-flash); echo "  gatewayTcb=reported: $out"
check "live attested E2EE turn" '[[ $out == *"abalone ok"* ]]'
sess=$(ls -t "$state"/agent/sessions/*/*.jsonl | head -1)
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.customType==="near-attestation") console.log("  attestation:", JSON.stringify(e.data)); }' "$sess"
check "attestation profile saved in the session log" 'grep -q near-attestation "$sess"'
hosts=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.ts>=process.argv[2]) console.log(e.host) }' "$state/egress.jsonl" "$since" | sort | uniq -c)
echo "$hosts" | sed 's/^/  egress: /'
check "egress only to NEAR, NVIDIA NRAS, Intel PCS and the other admitted hosts" '! grep -vE "cloud-api.near.ai|nras.attestation.nvidia.com|trustedservices.intel.com|tee.redpill.ai|inference.phala.com|127.0.0.1" <<<"$hosts" | grep -q .'
echo "near: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
