#!/usr/bin/env bash
# G4 + G5 live on NEAR: one abalone ask over the synthetic PDF on an attested NEAR model, then notebook
# search and delete. Uses the real ABALONE_DIR (its configured key). Spend: one short turn on a small model.
# --relaxed runs on a config copy with providers.json nearai.policy.gatewayTcb = "reported", for use while
# the repo config still gates on UpToDate. Without it the repo config is used as shipped.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${ABALONE_DIR:-$HOME/.abalone}"
model="${NEAR_MODEL:-z-ai/glm-5.3-flash}"
work="$(mktemp -d)"; cd "$work"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
if [[ ${1:-} == --relaxed ]]; then
  echo "CONFIG: RELAXED copy (nearai.policy.gatewayTcb = reported), not the repo config"
  export ABALONE_CONFIG="$work/config"; mkdir -p "$ABALONE_CONFIG/agents/pi"
  cp "$root/agents/pi/admitted.json" "$ABALONE_CONFIG/agents/pi/"; cp "$root/policy.json" "$ABALONE_CONFIG/"
  node -e 'const p=require(process.argv[1]);p.admitted.find(a=>a.id=="nearai").policy.gatewayTcb="reported";require("fs").writeFileSync(process.argv[2],JSON.stringify(p,null,1))' "$root/providers.json" "$ABALONE_CONFIG/providers.json"
else echo "CONFIG: repo (nearai.policy = $(node -p 'JSON.stringify(require(process.argv[1]).admitted.find(a=>a.id=="nearai").policy)' "$root/providers.json"))"; fi
since=$(date -u +%FT%T)
timeout 300 "$root/bin/abalone" ask --model "nearai/$model" --project g4-live "$root/tests/fixtures/docs/tenancy-renewal.pdf" \
  "If I do nothing, what happens to my tenancy, and what are my options for staying and what would each cost per month?" < /dev/null > out 2>&1
cat out
check "answer cites the file and abalone quotes the cited lines" 'grep -q "^  \[L[0-9]*\] \"" out && ! grep -q "no such line" out'
"$root/bin/abalone" show evidence > ev 2>&1; cat ev
check "strip shows verification from verifier output, with the gateway TCB as gw-tcb (model TEE up to date)" '[[ $(sed -n "/^Status (from/,/^Saved:/p" out | tr -s " \n" " ") == *"Model: remote, TEE checked · gw-tcb:out-of-date"* ]] && grep -q "Model: nearai/$model, remote, checked by abalone .*GPU: NVIDIA verdict (signature checked)), tcb:up-to-date, gw-tcb:out-of-date" ev'
hosts=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.ts>=process.argv[2]) console.log(e.via, e.host, e.allowed) }' "$state/egress.jsonl" "$since" | sort | uniq -c)
echo "$hosts" | sed 's/^/  egress: /'
check "egress only to NEAR, NVIDIA NRAS, Intel PCS and the other admitted hosts' attestation endpoints" '! grep -vE "cloud-api.near.ai|nras.attestation.nvidia.com|trustedservices.intel.com|tee.redpill.ai|inference.phala.com|127.0.0.1" <<<"$hosts" | grep -q .'
src=$(grep -oP '\(source \Ksrc-[0-9a-f]+' out)
"$root/bin/abalone" notebook search renewal November | head -5
"$root/bin/abalone" notebook rm "$src"
check "the live run's source is removed from the real notebook" '[[ $("$root/bin/abalone" notebook search Brennecke) == "no matches" ]]'
echo "private-work-near: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
