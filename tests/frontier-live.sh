#!/usr/bin/env bash
# J1 live, in the interactive session: the synthetic tenancy letter mentioned with runner/claude selected. The mediator
# (policy.json, NEAR glm-5.3-flash, RELAXED config copy as tests/private-work-near.sh --relaxed) reads it first and drafts
# a pour; "send once" sends it through real `claude -p` in the bwrap runner on runner-home/claude. The private-only baseline for the same
# question is the `abalone ask` run in local-data/evidence/j1-disclose-live.txt. Uses the real ABALONE_DIR (configured key). Spend: a few NEAR turns, one Claude turn.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
state="${ABALONE_DIR:-$HOME/.abalone}"
work="$(mktemp -d)"; mkdir "$work/w"; cp "$root/tests/fixtures/docs/tenancy-renewal.txt" "$work/w/"; cd "$work"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[2]+")")(l))' "$1" "$2"; }
answer='es.filter(e=>e.type==="message_end"&&e.message.role==="assistant").at(-1).message.content.filter(c=>c.type==="text").map(c=>c.text).join("")'
echo "CONFIG: RELAXED copy (nearai.policy.gatewayTcb = reported), repo policy.json (no standing policy for claude)"
export ABALONE_CONFIG="$work/config"; mkdir -p "$ABALONE_CONFIG/curated"
cp "$root/curated/manifest.json" "$ABALONE_CONFIG/curated/"; cp "$root/policy.json" "$ABALONE_CONFIG/"
node -e 'const p=require(process.argv[1]);p.admitted.find(a=>a.id=="nearai").policy.gatewayTcb="reported";require("fs").writeFileSync(process.argv[2],JSON.stringify(p,null,1))' "$root/providers.json" "$ABALONE_CONFIG/providers.json"
q="@tenancy-renewal.txt I would like Claude's general view on this: in most US states, if a tenant does not sign a renewal, can the landlord simply end the tenancy on the lease end date with no further notice, and what should I ask the leasing office?"
since=$(date -u +%FT%T); opens() { grep -c '"domain":"open"' "$state/agents.jsonl"; }; opens0=$(opens); runs0=$(ls "$state/runs" 2>/dev/null)
# tests/session-drive.mjs, except that an unused choice (no pour prompt shown) is reported, not thrown before the events print.
cat > drive.mjs <<'JS'
import fs from "node:fs";
const { runPrompt } = await import(process.env.ROOT + "/lib/rpc.mjs");
const [model, message] = process.argv.slice(2), choices = JSON.parse(process.env.CHOICES ?? "[]");
const { events } = await runPrompt({ args: ["--model", model], message, onUi: (ev) => ({ value: choices.shift() }) });
for (const e of events) console.log(JSON.stringify(e));
if (choices.length) console.error(`unused choices: ${JSON.stringify(choices)}`);
JS
(cd w && ROOT="$root" CHOICES='["send once"]' timeout 900 strace -f -e trace=connect -o ../trace node ../drive.mjs runner/claude "$q" > ../ev1 2> ../err1); cat err1
ev ev1 'es.find(e=>e.method==="select")?.title ?? "NO POUR PROMPT"'
echo "--- frontier-assisted answer"; ev ev1 "$answer"
rec=$(grep -h '"label":"released"' "$state/disclosures.jsonl" | tail -1)
check "one new runner run, released once by the user" '[[ $(( $(opens) - opens0 )) == 1 && $(node -p "JSON.parse(process.argv[1]).approval" "$rec") == user-once && $(node -p "JSON.parse(process.argv[1]).ts > process.argv[2]" "$rec" "$since") == true ]]'
check "the released record's text hashes to its payload_sha256, and this run left no scratch dir" '[[ $(node -p "require(\"crypto\").createHash(\"sha256\").update(JSON.parse(process.argv[1]).payload).digest(\"hex\") === JSON.parse(process.argv[1]).payload_sha256" "$rec") == true && $(ls "$state/runs" 2>/dev/null) == "$runs0" ]]'
egress=$(node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l); if (e.ts>=process.argv[2]) console.log(e.via, e.host, e.allowed) }' "$state/egress.jsonl" "$since" | sort | uniq -c)
echo "$egress" | sed 's/^/  egress: /'
check "runner egress (CONNECT proxy) reached only api.anthropic.com" '[[ -n $(grep " connect " <<<"$egress") ]] && ! grep " connect " <<<"$egress" | grep -vq "api.anthropic.com true"'
declare -A name; for h in api.anthropic.com cloud-api.near.ai nras.attestation.nvidia.com api.trustedservices.intel.com certificates.trustedservices.intel.com tee.redpill.ai inference.phala.com; do for ip in $(getent ahosts $h | awk '{print $1}' | sort -u); do name[$ip]=$h; done; done
grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' trace | sed -E 's/\).*"/ /' | sort | uniq -c | while read -r n p ip; do echo "  connect: $ip:$p x$n ${name[$ip]:-}"; done | tee connects
check "every inet connect is an admitted host, the runner host, loopback or the resolver" '! grep -vE "api.anthropic.com|cloud-api.near.ai|nras|trustedservices.intel.com|tee.redpill.ai|inference.phala.com|127\.0\.0\.(1|53):" connects | grep -q .'
echo "frontier-live: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
